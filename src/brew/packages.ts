import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { fetchAdvisoriesBatch } from "@brew/advisories"
import {
  brewInfoJson,
  brewLeaves,
  brewListCaskVersions,
  brewListVersions,
  brewOutdatedJson,
  brewPrefix,
  fetchSourceLastModifiedBatch,
} from "@brew/api"
import { runBatchesWithLimit } from "@brew/concurrency"
import { isPlausibleSourceTime, isVersionAhead } from "@brew/policy"
import { fetchProvenanceBatch } from "@brew/provenance"
import { isOfficialTap } from "@brew/tap"
import { COLD_BREW_TAP } from "@brew/trust"
import type { Package } from "@brew/types"
import {
  cacheMetadata,
  cacheNegativePublishDates,
  cachePublishDates,
  ensureCacheEntries,
  getCachedMetadata,
  getCachedNegativePublishDates,
  getCachedPublishDates,
  getOriginalTap,
  type MetadataCacheEntry,
  type PublishDateCacheEntry,
  setOriginalTap,
} from "@db"

async function readInstallReceipt(
  cellarPath: string,
  name: string,
  version: string,
): Promise<Package.InstallReceipt | null> {
  const receiptPath = join(cellarPath, name, version, "INSTALL_RECEIPT.json")
  try {
    return await Bun.file(receiptPath).json()
  } catch {
    return null
  }
}

// Casks store their receipt at `Caskroom/<token>/.metadata/INSTALL_RECEIPT.json`
// (not version-nested like formulae). It carries the real source tap, which
// `brew list` does not expose.
async function readCaskInstallReceipt(caskroomPath: string, name: string): Promise<Package.CaskInstallReceipt | null> {
  const receiptPath = join(caskroomPath, name, ".metadata", "INSTALL_RECEIPT.json")
  try {
    return await Bun.file(receiptPath).json()
  } catch {
    return null
  }
}

// An index of which installed third-party taps provide each formula/cask file.
// This is the authoritative, offline signal for a package's true origin —
// independent of `brew info` (which can be unavailable) and of stale receipts.
// Built once per load and shared across packages. Excludes cold-brew's own tap
// (so stepped packages resolve to their real upstream) and official Homebrew
// taps (never a meaningful third-party origin or shadow).
export interface TapIndex {
  formula: Map<string, string[]>
  cask: Map<string, string[]>
}

// List the bare names of `*.rb` files directly in `dir` (one level, no recursion).
// Missing/unreadable directories yield an empty list.
async function rubyStems(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((entry) => entry.endsWith(".rb")).map((entry) => entry.slice(0, -".rb".length))
  } catch {
    return []
  }
}

// Scan `<prefix>/Library/Taps` and record, per tap, which formula/cask files it
// provides. Homebrew accepts formulae at `Formula/`, `HomebrewFormula/`, or the
// tap root, and casks at `Casks/` or `Casks/<first-letter>/` (sharded). Earlier
// code only checked `Formula/`/`Casks/`, so root-layout taps (e.g. anomalyco/tap,
// anchore/grype) were missed and their packages fell through to a trusted
// official-tap default.
async function buildTapIndex(prefix: string): Promise<TapIndex> {
  const tapsRoot = join(prefix, "Library", "Taps")
  const index: TapIndex = { formula: new Map(), cask: new Map() }
  const add = (map: Map<string, string[]>, name: string, tap: string) => {
    const taps = map.get(name)
    if (!taps) map.set(name, [tap])
    else if (!taps.includes(tap)) taps.push(tap)
  }

  let users: string[]
  try {
    users = await readdir(tapsRoot)
  } catch {
    return index
  }
  for (const user of users) {
    let repos: string[]
    try {
      repos = await readdir(join(tapsRoot, user))
    } catch {
      continue
    }
    for (const repo of repos) {
      if (!repo.startsWith("homebrew-")) continue
      const tap = `${user}/${repo.slice("homebrew-".length)}`
      if (tap === COLD_BREW_TAP || isOfficialTap(tap)) continue
      const repoDir = join(tapsRoot, user, repo)

      // Formulae: Formula/, HomebrewFormula/, and the tap root.
      for (const stem of await rubyStems(join(repoDir, "Formula"))) add(index.formula, stem, tap)
      for (const stem of await rubyStems(join(repoDir, "HomebrewFormula"))) add(index.formula, stem, tap)
      for (const stem of await rubyStems(repoDir)) add(index.formula, stem, tap)

      // Casks: Casks/ and one level of sharding (Casks/<first-letter>/). Casks
      // never live at the tap root, so root .rb files are formulae only.
      const casksDir = join(repoDir, "Casks")
      for (const stem of await rubyStems(casksDir)) add(index.cask, stem, tap)
      let shards: string[] = []
      try {
        shards = await readdir(casksDir)
      } catch {}
      for (const shard of shards) {
        for (const stem of await rubyStems(join(casksDir, shard))) add(index.cask, stem, tap)
      }
    }
  }
  // Sort so first-match origin resolution is stable — `readdir` order is
  // filesystem-dependent when two same-named taps exist.
  for (const map of [index.formula, index.cask]) {
    for (const taps of map.values()) taps.sort()
  }
  return index
}

function owningTaps(index: TapIndex, name: string, isCask: boolean): string[] {
  return (isCask ? index.cask : index.formula).get(name) ?? []
}

// Same-named third-party taps on disk other than the resolved origin — i.e.
// taps that shadow this package. Used to warn when a trusted package has an
// untrusted namesake tapped locally.
function shadowTaps(index: TapIndex, name: string, isCask: boolean, originTap: string): string[] {
  const taps = (isCask ? index.cask : index.formula).get(name) ?? []
  return taps.filter((tap) => tap !== originTap)
}

// Resolve the upstream tap a package came from. A concrete receipt tap wins —
// it is what brew recorded at install time and stays correct even when a stale
// same-named third-party tap lingers on disk. Only stepped packages (whose
// receipt reads cold-brew/cold-brew) and packages with a missing receipt
// ("unknown") need recovery: the on-disk third-party tap is the authoritative
// signal and overrides (and self-heals) a stale recorded origin — this is what
// catches a tap whose formula lives at the tap root. Absent any third-party tap
// on disk, the recorded origin stands (a package stepped from homebrew/core is
// legitimately core), and only with no signal at all do we return "unknown"
// (untrusted) rather than guessing a trusted official tap.
function resolveOriginTap(index: TapIndex, name: string, tap: string, isCask: boolean): string {
  if (tap !== COLD_BREW_TAP && tap !== "unknown") return tap
  const stored = getOriginalTap(name)
  const providers = owningTaps(index, name, isCask)
  // A stored origin still present on disk stays authoritative — don't let an
  // arbitrary same-named tap clobber a good value.
  if (stored && providers.includes(stored)) return stored
  // Self-heal only from an *unambiguous* single on-disk provider. When several
  // same-named third-party taps provide this package, we can't tell which is
  // the real origin — refuse to guess (and refuse to persist a guess an
  // attacker tap sorting first could capture). Fall back to the stored value or
  // "unknown", which is untrusted (fail-closed).
  if (providers.length === 1) {
    const only = providers[0]!
    // `original_tap` is keyed by package name, not by kind, so a formula and a
    // same-named cask both self-healing in one run race last-write-wins. This
    // is benign: `providers` here is kind-scoped (owningTaps honors isCask), so
    // if a cross-kind value lands in storage it won't match the other kind's
    // providers next run and gets re-healed — worst case one run of unknown
    // (untrusted, fail-closed), never a false trust grant.
    if (only !== stored) setOriginalTap(name, only)
    return only
  }
  return stored ?? "unknown"
}

export async function getInstalledPackages(): Promise<Package.Info[]> {
  const [prefix, versions, caskVersions, leaves] = await Promise.all([
    brewPrefix(),
    brewListVersions(),
    brewListCaskVersions(),
    brewLeaves(),
  ])

  const cellarPath = join(prefix, "Cellar")
  const packages: Package.Info[] = []
  const tapIndex = await buildTapIndex(prefix)

  const receiptPromises = Array.from(versions.entries()).map(async ([name, version]): Promise<Package.Info | null> => {
    const receipt = await readInstallReceipt(cellarPath, name, version)
    if (!receipt) return null

    const tap = receipt.source?.tap ?? "unknown"
    const originTap = resolveOriginTap(tapIndex, name, tap, false)
    // npm/zip reproducible-build sentinel mtimes (1985/1980) surface here as
    // source_modified_time; reject them so age falls back to install time or
    // a refined GitHub date rather than reading as ~40 years old.
    const plausibleSource = isPlausibleSourceTime(receipt.source_modified_time)
    return {
      name,
      installedVersion: version,
      latestVersion: null,
      installedAt: receipt.time,
      sourceModifiedAt: plausibleSource ? receipt.source_modified_time : 0,
      isLeaf: leaves.has(name),
      installedAsDependency: receipt.installed_as_dependency,
      installedOnRequest: receipt.installed_on_request,
      pinned: false,
      outdated: false,
      needsRelink: false,
      tap,
      originTap,
      shadowTaps: shadowTaps(tapIndex, name, false, originTap),
      trusted: false,
      description: null,
      isCask: false,
      dateConfidence: plausibleSource ? "authoritative" : "unknown",
    }
  })

  const results = await Promise.all(receiptPromises)
  for (const pkg of results) {
    if (pkg) packages.push(pkg)
  }

  const caskroomPath = join(prefix, "Caskroom")
  const caskPromises = Array.from(caskVersions.entries()).map(async ([name, version]): Promise<Package.Info> => {
    const receipt = await readCaskInstallReceipt(caskroomPath, name)
    let installedAt = receipt?.time ?? 0
    if (!installedAt) {
      try {
        const versionDir = join(caskroomPath, name, version)
        const { birthtimeMs } = await stat(versionDir)
        installedAt = Math.floor(birthtimeMs / 1000)
      } catch {}
    }
    const tap = receipt?.source?.tap ?? "unknown"
    const originTap = resolveOriginTap(tapIndex, name, tap, true)
    return {
      name,
      installedVersion: version,
      latestVersion: null,
      installedAt,
      sourceModifiedAt: 0,
      isLeaf: true,
      installedAsDependency: false,
      installedOnRequest: receipt?.installed_on_request ?? true,
      pinned: false,
      outdated: false,
      needsRelink: false,
      tap,
      originTap,
      shadowTaps: shadowTaps(tapIndex, name, true, originTap),
      trusted: false,
      description: null,
      isCask: true,
      dateConfidence: "unknown",
    }
  })
  const caskResults = await Promise.all(caskPromises)
  for (const pkg of caskResults) {
    packages.push(pkg)
  }

  return packages
}

// `brew outdated --json=v2` returns tap-qualified names for tap formulae
// (e.g. "ahokinson/tap/acli"), while `brew list --versions` used by
// getInstalledPackages yields bare names. Strip the tap prefix so the lookup
// matches.
export function bareName(name: string): string {
  const slash = name.lastIndexOf("/")
  return slash >= 0 ? name.slice(slash + 1) : name
}

export async function withOutdatedInfo(packages: readonly Package.Info[]): Promise<Package.Info[]> {
  const { formulae, casks } = await brewOutdatedJson()

  interface OutdatedEntry {
    version: string
    pinned: boolean
    // `brew outdated` reports a package as outdated by comparing the *linked*
    // keg to the formula's current version. installed_versions is every keg
    // present in the Cellar. If current_version is in that list, the target
    // is already on disk but unlinked — `brew upgrade` would no-op with
    // "Warning: already installed". Flag it so the upgrade path reinstalls.
    needsRelink: boolean
  }

  // Key by kind too: Homebrew permits a same-named formula and cask, and the
  // cask (processed second) would otherwise clobber the formula's entry.
  const key = (name: string, isCask: boolean) => `${isCask ? "cask" : "formula"}:${name}`
  const outdatedMap = new Map<string, OutdatedEntry>()
  for (const formula of formulae) {
    outdatedMap.set(key(bareName(formula.name), false), {
      version: formula.current_version,
      pinned: formula.pinned,
      needsRelink: formula.installed_versions.includes(formula.current_version),
    })
  }
  for (const cask of casks) {
    outdatedMap.set(key(bareName(cask.name), true), {
      version: cask.current_version,
      pinned: false,
      needsRelink: cask.installed_versions.includes(cask.current_version),
    })
  }

  return packages.map((pkg) => {
    const info = outdatedMap.get(key(pkg.name, pkg.isCask))
    if (info) {
      return {
        ...pkg,
        latestVersion: info.version,
        outdated: true,
        pinned: info.pinned,
        needsRelink: info.needsRelink,
      }
    }
    return { ...pkg, outdated: false, pinned: false, needsRelink: false }
  })
}

const INFO_BATCH_SIZE = 50
const MAX_CONCURRENT_BATCHES = 3

async function fetchBrewMetadata(
  packages: readonly Package.Info[],
  metadata: Map<string, Partial<Package.Info>>,
  onStatus?: (msg: string) => void,
): Promise<void> {
  const formulaeNames = packages.filter((pkg) => !pkg.isCask).map((pkg) => pkg.name)
  const caskNames = packages.filter((pkg) => pkg.isCask).map((pkg) => pkg.name)

  const allNames = [...formulaeNames, ...caskNames]
  const cachedInfo = getCachedMetadata(allNames)

  for (const [name, entry] of cachedInfo) {
    metadata.set(name, {
      description: entry.description,
      latestVersion: entry.latestVersion,
      ...(entry.tap ? { tap: entry.tap } : {}),
      ...(entry.installedTime ? { installedAt: entry.installedTime } : {}),
    })
  }

  const uncachedFormulaeNames = formulaeNames.filter((name) => !cachedInfo.has(name))
  const uncachedCaskNames = caskNames.filter((name) => !cachedInfo.has(name))
  const uncachedTotal = uncachedFormulaeNames.length + uncachedCaskNames.length
  let metadataFetched = 0
  const newInfoEntries: MetadataCacheEntry[] = []

  if (uncachedFormulaeNames.length > 0) {
    await runBatchesWithLimit(uncachedFormulaeNames, INFO_BATCH_SIZE, MAX_CONCURRENT_BATCHES, async (batch) => {
      try {
        const infos = await brewInfoJson(batch, "formula")
        for (const formula of infos.formulae) {
          metadata.set(formula.name, {
            description: formula.desc,
            latestVersion: formula.versions.stable,
            tap: formula.tap,
          })
          newInfoEntries.push({
            packageName: formula.name,
            description: formula.desc,
            latestVersion: formula.versions.stable,
            tap: formula.tap,
            installedTime: null,
          })
        }
      } catch {
        // Descriptions are optional — failures don't block the pipeline
      }
      metadataFetched += batch.length
      onStatus?.(`fetching metadata... (${metadataFetched}/${uncachedTotal})`)
    })
  }

  if (uncachedCaskNames.length > 0) {
    await runBatchesWithLimit(uncachedCaskNames, INFO_BATCH_SIZE, MAX_CONCURRENT_BATCHES, async (batch) => {
      try {
        const infos = await brewInfoJson(batch, "cask")
        for (const cask of infos.casks) {
          const metadataPatch: Partial<Package.Info> = {
            description: cask.desc,
            latestVersion: cask.version,
            tap: cask.tap,
          }
          if (cask.installed_time) {
            metadataPatch.installedAt = cask.installed_time
          }
          metadata.set(cask.token, metadataPatch)
          newInfoEntries.push({
            packageName: cask.token,
            description: cask.desc,
            latestVersion: cask.version,
            tap: cask.tap,
            installedTime: cask.installed_time,
          })
        }
      } catch {
        // Descriptions are optional — failures don't block the pipeline
      }
      metadataFetched += batch.length
      onStatus?.(`fetching metadata... (${metadataFetched}/${uncachedTotal})`)
    })
  }

  cacheMetadata(newInfoEntries)
}

async function fetchPublishDates(
  packages: readonly Package.Info[],
  metadata: Map<string, Partial<Package.Info>>,
  onStatus?: (msg: string) => void,
): Promise<void> {
  // Casks always need GitHub dates (no local source_modified_time).
  // Outdated formulae also need them — their install receipt reflects the installed version, not latest.
  const needsPublishTime = packages.filter((pkg) => pkg.isCask || pkg.outdated)
  const needsPublishTimeNames = needsPublishTime.map((pkg) => pkg.name)

  const cachedDates = getCachedPublishDates(needsPublishTimeNames)
  const negativelyCached = getCachedNegativePublishDates(needsPublishTimeNames)
  const uncachedPackages = needsPublishTime.filter(
    (pkg) => !cachedDates.has(pkg.name) && !negativelyCached.has(pkg.name),
  )

  for (const [name, sourceModifiedAt] of cachedDates) {
    const existing = metadata.get(name) ?? {}
    existing.sourceModifiedAt = sourceModifiedAt
    existing.dateConfidence = "authoritative"
    metadata.set(name, existing)
  }

  // Apply installedAt fallback for negatively-cached packages
  for (const name of negativelyCached) {
    const package_ = needsPublishTime.find((pkg) => pkg.name === name)
    if (!package_) continue
    const existing = metadata.get(name) ?? {}
    if (!existing.sourceModifiedAt || existing.sourceModifiedAt <= 0) {
      const fallbackTime = existing.installedAt ?? package_.installedAt
      if (fallbackTime && fallbackTime > 0) {
        existing.sourceModifiedAt = fallbackTime
        existing.dateConfidence = "install-time"
        metadata.set(name, existing)
      }
    }
  }

  if (uncachedPackages.length > 0) {
    const newDateEntries: PublishDateCacheEntry[] = []
    const newNegativeNames: string[] = []

    const batchResults = await fetchSourceLastModifiedBatch(
      uncachedPackages.map((pkg) => ({
        name: pkg.name,
        isCask: pkg.isCask,
        tap: metadata.get(pkg.name)?.tap ?? pkg.tap,
        latestVersion: metadata.get(pkg.name)?.latestVersion ?? pkg.latestVersion,
      })),
      onStatus ? (completed, total) => onStatus(`fetching publish dates... (${completed}/${total})`) : undefined,
    )

    for (const package_ of uncachedPackages) {
      const time = batchResults.get(package_.name) ?? null
      const existing = metadata.get(package_.name) ?? {}

      if (typeof time === "number") {
        existing.sourceModifiedAt = time
        existing.dateConfidence = "authoritative"
        metadata.set(package_.name, existing)
        newDateEntries.push({ packageName: package_.name, sourceModifiedAt: time })
      } else {
        if (time !== "rate-limited") {
          newNegativeNames.push(package_.name)
        }
        const fallbackTime = existing.installedAt ?? package_.installedAt
        if (fallbackTime && fallbackTime > 0) {
          existing.sourceModifiedAt = fallbackTime
          existing.dateConfidence = "install-time"
          metadata.set(package_.name, existing)
        }
      }
    }

    cachePublishDates(newDateEntries)
    cacheNegativePublishDates(newNegativeNames)
  }
}

function applyMetadata(
  packages: readonly Package.Info[],
  metadata: Map<string, Partial<Package.Info>>,
): Package.Info[] {
  return packages.map((pkg) => {
    const patch = metadata.get(pkg.name)
    if (!patch) return { ...pkg }
    const merged = { ...pkg, ...patch }
    merged.outdated = pkg.outdated
    merged.latestVersion = pkg.latestVersion ?? patch.latestVersion ?? null
    // The install receipt records the tap a package was actually installed
    // from. `brew info` returns the default-resolution tap, which diverges when
    // a package also exists in an official tap. Applies to casks too now that
    // their receipts are read (and keeps the cold-brew/cold-brew marker that
    // stepping logic depends on).
    if (pkg.tap && pkg.tap !== "unknown") merged.tap = pkg.tap
    // Stepped packages live on the cold-brew/cold-brew tap with the local
    // formula file already unlinked, so `brew outdated` doesn't flag them
    // even when the upstream tap has moved ahead. Re-derive outdatedness
    // from the upstream `brew info` version so further stepping can resume.
    if (
      pkg.tap === "cold-brew/cold-brew" &&
      !merged.outdated &&
      merged.latestVersion &&
      isVersionAhead(merged.latestVersion, pkg.installedVersion)
    ) {
      merged.outdated = true
    }
    return merged
  })
}

export async function withMetadata(
  packages: readonly Package.Info[],
  onStatus?: (msg: string) => void,
): Promise<Package.Info[]> {
  ensureCacheEntries(packages.map((pkg) => ({ name: pkg.name, isCask: pkg.isCask })))

  const metadata = new Map<string, Partial<Package.Info>>()
  onStatus?.("fetching package metadata...")
  await fetchBrewMetadata(packages, metadata, onStatus)
  onStatus?.("fetching publish dates...")
  await fetchPublishDates(packages, metadata, onStatus)
  return applyMetadata(packages, metadata)
}

export async function withAdvisories(
  packages: readonly Package.Info[],
  onStatus?: (msg: string) => void,
): Promise<Package.Info[]> {
  const advisories = await fetchAdvisoriesBatch(
    packages,
    onStatus ? (completed, total) => onStatus(`checking advisories... (${completed}/${total})`) : undefined,
  )
  return packages.map((pkg) => {
    const summary = advisories.get(pkg.name) ?? null
    return { ...pkg, advisories: summary }
  })
}

// Attaches Provenance.Summary to outdated homebrew/core formulae. Scope is
// intentionally narrow for v1: no casks, no third-party taps, no formulae
// without an installedAt anchor. Anything outside scope gets
// `provenance: null` — the caller is supposed to render it as "not
// available" rather than "all clear."
export async function withProvenance(
  packages: readonly Package.Info[],
  onStatus?: (msg: string) => void,
): Promise<Package.Info[]> {
  const provenance = await fetchProvenanceBatch(
    packages,
    onStatus ? (completed, total) => onStatus(`checking provenance... (${completed}/${total})`) : undefined,
  )
  return packages.map((pkg) => {
    const summary = provenance.get(pkg.name) ?? null
    return { ...pkg, provenance: summary }
  })
}
