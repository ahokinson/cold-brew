import { hasGitHubToken } from "@brew/api"
import { runWithConcurrencyLimit } from "@brew/concurrency"
import { computeCvssScore } from "@brew/cvss"
import { getEpssScores } from "@brew/epss"
import { getKevCatalog } from "@brew/kev"
import { parseVersion } from "@brew/policy"
import { Advisory, type Package } from "@brew/types"
import { type AdvisoryCacheEntry, cacheAdvisories, getCachedAdvisories } from "@db"

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch"
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns"
const GITHUB_ADVISORIES_URL = "https://api.github.com/advisories"
const FETCH_TIMEOUT_MILLISECONDS = 10_000
const MAX_CONCURRENT_OSV_DETAIL = 5
const MAX_CONCURRENT_GHSA = 5
const OSV_BATCH_SIZE = 100

interface OsvQuery {
  package: { name: string }
  version?: string
}

interface OsvBatchResponse {
  results: Array<{ vulns?: Array<{ id: string; modified?: string }> }>
}

interface OsvSeverity {
  type: string
  score: string
}

interface OsvRange {
  type: string
  events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>
}

interface OsvAffected {
  package?: { name?: string; ecosystem?: string }
  ranges?: OsvRange[]
  versions?: string[]
}

interface OsvVuln {
  id: string
  aliases?: string[]
  summary?: string
  details?: string
  severity?: OsvSeverity[]
  affected?: OsvAffected[]
  references?: Array<{ type?: string; url?: string }>
}

interface GhsaVuln {
  package?: { ecosystem?: string; name?: string }
  severity?: string
  patched_versions?: string | null
  vulnerable_version_range?: string | null
}

interface GhsaAdvisory {
  ghsa_id: string
  cve_id?: string | null
  summary?: string
  description?: string
  severity?: string
  cvss?: { score?: number | null; vector_string?: string | null }
  cvss_severities?: { cvss_v3?: { score?: number | null } | null } | null
  html_url?: string
  vulnerabilities?: GhsaVuln[]
}

function extractCvssScore(severities: OsvSeverity[] | undefined): number | null {
  if (!severities) return null
  // Prefer v4 when present, fall back to v3.
  const sorted = [...severities].sort((a, b) => {
    const aV4 = a.type === "CVSS_V4" ? 0 : 1
    const bV4 = b.type === "CVSS_V4" ? 0 : 1
    return aV4 - bV4
  })
  for (const severity of sorted) {
    if (severity.type !== "CVSS_V3" && severity.type !== "CVSS_V4") continue
    const plain = parseFloat(severity.score)
    if (Number.isFinite(plain) && plain >= 0 && plain <= 10) return plain
    const computed = computeCvssScore(severity.score)
    if (computed !== null) return computed
  }
  return null
}

function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const partsA = parseVersion(a)
  const partsB = parseVersion(b)
  const length = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < length; i++) {
    const x = partsA[i] ?? 0
    const y = partsB[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

function versionLte(a: string, b: string): boolean {
  return compareVersions(a, b) <= 0
}

function versionLt(a: string, b: string): boolean {
  return compareVersions(a, b) < 0
}

function rangeIncludesVersion(range: OsvRange, installedVersion: string): { hit: boolean; firstFixed: string | null } {
  if (range.type !== "SEMVER" && range.type !== "ECOSYSTEM") {
    return { hit: false, firstFixed: null }
  }
  let introduced: string | null = null
  let firstFixed: string | null = null
  for (const event of range.events) {
    if (event.introduced) introduced = event.introduced
    if (event.fixed) {
      firstFixed = event.fixed
      const introducedOk = !introduced || introduced === "0" || versionLte(introduced, installedVersion)
      const fixedOk = versionLt(installedVersion, event.fixed)
      if (introducedOk && fixedOk) return { hit: true, firstFixed: event.fixed }
      introduced = null
    }
    if (event.last_affected) {
      const introducedOk = !introduced || introduced === "0" || versionLte(introduced, installedVersion)
      const affectedOk = versionLte(installedVersion, event.last_affected)
      if (introducedOk && affectedOk) return { hit: true, firstFixed: null }
      introduced = null
    }
  }
  if (introduced && !firstFixed && versionLte(introduced, installedVersion)) {
    return { hit: true, firstFixed: null }
  }
  return { hit: false, firstFixed }
}

// Distro-specific ecosystems track downstream packaging state, not upstream
// software state. A CVE that's "open" in Debian 11's pydantic doesn't mean
// the latest upstream pydantic is vulnerable. Skip these to avoid false positives.
const DISTRO_ECOSYSTEM_PREFIXES = [
  "Debian:",
  "Ubuntu:",
  "Alpine:",
  "Rocky Linux:",
  "AlmaLinux:",
  "Red Hat:",
  "SUSE:",
  "openSUSE:",
  "Chainguard",
  "Photon OS:",
  "Mageia:",
  "Wolfi",
  "Bellsoft:",
  "Bitnami",
]

function isDistroEcosystem(ecosystem: string | undefined): boolean {
  if (!ecosystem) return false
  return DISTRO_ECOSYSTEM_PREFIXES.some((prefix) => ecosystem.startsWith(prefix))
}

function affectsInstalledVersion(vuln: OsvVuln, installedVersion: string): { hit: boolean; fixedIn: string | null } {
  let fixedIn: string | null = null
  let hit = false
  for (const affected of vuln.affected ?? []) {
    if (isDistroEcosystem(affected.package?.ecosystem)) continue
    const explicitHit = affected.versions?.includes(installedVersion) ?? false
    if (explicitHit) hit = true
    for (const range of affected.ranges ?? []) {
      const probe = rangeIncludesVersion(range, installedVersion)
      if (probe.hit) hit = true
      // Record the earliest fix from any matching range — even when the hit
      // came from `versions[]`, a sibling range tells us where to upgrade to.
      const candidate = probe.firstFixed
      if (candidate && (explicitHit || probe.hit)) {
        if (!fixedIn || versionLt(candidate, fixedIn)) fixedIn = candidate
      }
    }
  }
  return { hit, fixedIn }
}

// OSV's malicious-package feed (MAL-*) catalogs typosquats and backdoors in
// language package registries (npm, PyPI, RubyGems...). These match Homebrew
// formulae by name alone, so they rarely represent a real vulnerability in
// the installed software. We surface them as a separate "typosquat" kind so
// the user sees the name is a known impersonation target, without mixing
// them into the CVE list or counting them toward auto-bypass decisions.
function isMalwareId(id: string): boolean {
  return id.startsWith("MAL-") || id.startsWith("OSV-MAL-")
}

function osvVulnToEntry(vuln: OsvVuln, installedVersion: string, latestVersion: string | null): Advisory.Entry | null {
  const aliasedCve = vuln.aliases?.find((alias) => alias.startsWith("CVE-"))
  const summary = vuln.summary ?? vuln.details?.split("\n")[0] ?? ""
  const url = vuln.references?.find((ref) => ref.type === "ADVISORY")?.url ?? `https://osv.dev/vulnerability/${vuln.id}`

  // Malware entry without a CVE alias → typosquat (informational, not scored,
  // not version-filtered). Most MAL-* entries fall here.
  if (isMalwareId(vuln.id) && !aliasedCve) {
    if (!summary) return null
    return {
      id: vuln.id,
      source: "osv",
      kind: "typosquat",
      severity: "unknown",
      cvss: null,
      summary,
      fixedIn: null,
      fixInLatest: false,
      url,
      kev: false,
      epss: null,
    }
  }

  // Vulnerability path: must affect the installed version to matter.
  const { hit, fixedIn } = affectsInstalledVersion(vuln, installedVersion)
  if (!hit) return null
  const cvss = extractCvssScore(vuln.severity)
  // Drop low-confidence entries: no summary, no CVSS, id not a CVE.
  // These are mostly distro advisory aliases from OSV's cross-ecosystem fan-out
  // that surface as noise for Homebrew-installed packages.
  const hasUsefulSignal = summary.length > 0 || cvss !== null || vuln.id.startsWith("CVE-") || !!aliasedCve
  if (!hasUsefulSignal) return null
  const fixInLatest = !!(fixedIn && latestVersion && versionLte(fixedIn, latestVersion))
  const id = aliasedCve ?? vuln.id
  // Malware with a CVE alias (rare — supply-chain incidents that earned one)
  // is the most severe class regardless of CVSS presence.
  const severity = isMalwareId(vuln.id) ? Advisory.Severity.Critical : Advisory.Severity.fromCvss(cvss)
  return {
    id,
    source: "osv",
    kind: "vulnerability",
    severity,
    cvss,
    summary: summary || id,
    fixedIn,
    fixInLatest,
    url,
    kev: false,
    epss: null,
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
  })
  if (!response.ok) throw new Error(`POST ${url} failed: ${response.status}`)
  return response.json()
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
  })
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`)
  return response.json()
}

interface OsvBatchOutcome {
  byPackage: Map<string, OsvVuln[]>
  // Names whose batch POST failed — caller must not write these to the
  // advisory cache, otherwise an OSV outage gets baked in for hours and
  // suppresses auto-bypass for newly-disclosed CVEs.
  failed: Set<string>
}

async function fetchOsvForPackages(
  packages: Array<{ name: string; installedVersion: string }>,
): Promise<OsvBatchOutcome> {
  const result = new Map<string, OsvVuln[]>()
  const failed = new Set<string>()
  if (packages.length === 0) return { byPackage: result, failed }

  const idsByPackage = new Map<string, Set<string>>()
  for (let i = 0; i < packages.length; i += OSV_BATCH_SIZE) {
    const chunk = packages.slice(i, i + OSV_BATCH_SIZE)
    const queries: OsvQuery[] = chunk.map((pkg) => ({
      package: { name: pkg.name },
      version: pkg.installedVersion,
    }))
    let response: OsvBatchResponse
    try {
      response = (await postJson(OSV_BATCH_URL, { queries })) as OsvBatchResponse
    } catch {
      for (const pkg of chunk) failed.add(pkg.name)
      continue
    }
    for (let idx = 0; idx < chunk.length; idx++) {
      const pkg = chunk[idx]!
      const vulns = response.results?.[idx]?.vulns ?? []
      if (vulns.length === 0) continue
      let set = idsByPackage.get(pkg.name)
      if (!set) {
        set = new Set<string>()
        idsByPackage.set(pkg.name, set)
      }
      for (const vuln of vulns) set.add(vuln.id)
    }
  }

  const allIds = new Set<string>()
  for (const ids of idsByPackage.values()) {
    for (const id of ids) allIds.add(id)
  }

  const detailMap = new Map<string, OsvVuln>()
  const idList = [...allIds]
  const details = await runWithConcurrencyLimit(idList, MAX_CONCURRENT_OSV_DETAIL, async (id) => {
    try {
      return (await getJson(`${OSV_VULN_URL}/${encodeURIComponent(id)}`)) as OsvVuln
    } catch {
      return null
    }
  })
  for (let i = 0; i < idList.length; i++) {
    const vuln = details[i]
    if (vuln && !(vuln instanceof Error)) detailMap.set(idList[i]!, vuln)
  }

  for (const [name, ids] of idsByPackage) {
    const vulns: OsvVuln[] = []
    for (const id of ids) {
      const vuln = detailMap.get(id)
      if (vuln) vulns.push(vuln)
    }
    result.set(name, vulns)
  }
  return { byPackage: result, failed }
}

function extractGithubRepo(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    const match = candidate.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git|\/|$)/i)
    if (match) {
      const owner = match[1]!
      const repo = match[2]!.replace(/\.git$/, "")
      return `${owner}/${repo}`
    }
  }
  return null
}

// Override table for packages whose homepage isn't GitHub but have a GitHub mirror.
const FORMULA_GHSA_OVERRIDE: Record<string, string> = {
  curl: "curl/curl",
  openssl: "openssl/openssl",
  "openssl@3": "openssl/openssl",
  "openssl@1.1": "openssl/openssl",
  nginx: "nginx/nginx",
  git: "git/git",
  python: "python/cpython",
  "python@3.12": "python/cpython",
  "python@3.11": "python/cpython",
  "python@3.13": "python/cpython",
  ruby: "ruby/ruby",
  node: "nodejs/node",
  go: "golang/go",
  rust: "rust-lang/rust",
  postgresql: "postgres/postgres",
  "postgresql@16": "postgres/postgres",
  redis: "redis/redis",
  php: "php/php-src",
  ffmpeg: "FFmpeg/FFmpeg",
  wget: "mirror/wget",
}

function resolveGhsaRepo(pkg: Package.Info): string | null {
  const override = FORMULA_GHSA_OVERRIDE[pkg.name]
  if (override) return override
  return extractGithubRepo([pkg.homepage])
}

async function fetchGhsaForPackage(pkg: Package.Info, repo: string): Promise<Advisory.Entry[]> {
  const url = `${GITHUB_ADVISORIES_URL}?affects=${encodeURIComponent(`${pkg.name}@${pkg.installedVersion}`)}&per_page=50`
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) headers.Authorization = `token ${token}`

  let raw: unknown
  try {
    raw = await getJson(url, headers)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const entries: Advisory.Entry[] = []
  for (const item of raw as GhsaAdvisory[]) {
    const matchingVuln = item.vulnerabilities?.find(
      (vuln) =>
        vuln.package?.name?.toLowerCase() === pkg.name.toLowerCase() ||
        (repo.split("/")[1] ?? "").toLowerCase() === (vuln.package?.name ?? "").toLowerCase(),
    )
    if (!matchingVuln) continue

    const fixedIn = matchingVuln.patched_versions?.split(",")[0]?.trim() || null
    const cvss = item.cvss_severities?.cvss_v3?.score ?? item.cvss?.score ?? null
    const fixInLatest = !!(fixedIn && pkg.latestVersion && versionLte(fixedIn, pkg.latestVersion))
    entries.push({
      id: item.cve_id ?? item.ghsa_id,
      source: "ghsa",
      kind: "vulnerability",
      severity: Advisory.Severity.fromCvss(cvss),
      cvss,
      summary: item.summary ?? item.description?.split("\n")[0] ?? item.ghsa_id,
      fixedIn,
      fixInLatest,
      url: item.html_url ?? `https://github.com/advisories/${item.ghsa_id}`,
      kev: false,
      epss: null,
    })
  }
  return entries
}

export function mergeAdvisoryEntries(
  osv: Advisory.Entry[],
  ghsa: Advisory.Entry[],
  brew: Advisory.Entry[],
  kevSet: ReadonlySet<string> = new Set(),
): Advisory.Entry[] {
  const byId = new Map<string, Advisory.Entry>()
  for (const entry of osv) byId.set(entry.id, entry)
  // GHSA wins over OSV for matching CVE ids.
  for (const entry of ghsa) byId.set(entry.id, entry)
  for (const entry of brew) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
  }
  // Stamp KEV membership after the source merge so an entry replaced by GHSA
  // still gets enriched. KEV is keyed on CVE ids; non-CVE entries stay false.
  const enriched: Advisory.Entry[] = []
  for (const entry of byId.values()) {
    enriched.push(entry.id.startsWith("CVE-") && kevSet.has(entry.id) ? { ...entry, kev: true } : entry)
  }
  return enriched.sort((a, b) => {
    const aScore = a.cvss ?? -1
    const bScore = b.cvss ?? -1
    if (aScore !== bScore) return bScore - aScore
    return Advisory.Severity.rank(b.severity) - Advisory.Severity.rank(a.severity)
  })
}

export function buildSummary(entries: Advisory.Entry[]): Advisory.Summary {
  let maxCvss: number | null = null
  let maxEpss: number | null = null
  let hasActionableFix = false
  let hasKevListed = false
  // Only real vulnerabilities contribute to severity score and bypass logic.
  // Typosquats are informational and must never trigger a hold bypass.
  for (const entry of entries) {
    if (entry.kind !== "vulnerability") continue
    if (entry.cvss !== null && (maxCvss === null || entry.cvss > maxCvss)) maxCvss = entry.cvss
    if (entry.epss !== null && (maxEpss === null || entry.epss > maxEpss)) maxEpss = entry.epss
    if (entry.fixInLatest) hasActionableFix = true
    if (entry.kev) hasKevListed = true
  }
  return { entries, maxCvss, hasActionableFix, hasKevListed, maxEpss }
}

export async function fetchAdvisoriesBatch(
  packages: readonly Package.Info[],
  onProgress?: (completed: number, total: number) => void,
): Promise<Map<string, Advisory.Summary>> {
  const targets = packages.filter((pkg) => pkg.outdated && pkg.latestVersion)
  const result = new Map<string, Advisory.Summary>()
  if (targets.length === 0) return result

  const cached = getCachedAdvisories(
    targets.map((pkg) => ({
      name: pkg.name,
      installedVersion: pkg.installedVersion,
      latestVersion: pkg.latestVersion ?? null,
    })),
  )
  for (const [name, summary] of cached) {
    result.set(name, summary)
  }

  const uncached = targets.filter((pkg) => !cached.has(pkg.name))
  if (uncached.length === 0) return result

  const { osvMap, osvFailed } = await fetchOsvOrTreatAsFailed(uncached)
  const ghsaMap = await fetchGhsaForUncached(uncached)
  // KEV catalog is small (~1.5k CVE ids) and fetched once per batch. Failures
  // resolve to an empty set, so a CISA outage just means no entries are
  // marked KEV-listed — no crash, no silent data corruption.
  const kevSet = await getKevCatalog()

  // First pass: merge OSV + GHSA + KEV stamping per package. We need merged
  // entries to know the full CVE id set before we can ask FIRST.org for EPSS.
  interface PerPackage {
    merged: Advisory.Entry[]
    sources: string[]
  }
  const byPkg = new Map<string, PerPackage>()
  const cveIds = new Set<string>()
  for (const pkg of uncached) {
    const osvEntries: Advisory.Entry[] = []
    for (const vuln of osvMap.get(pkg.name) ?? []) {
      const entry = osvVulnToEntry(vuln, pkg.installedVersion, pkg.latestVersion ?? null)
      if (entry) osvEntries.push(entry)
    }
    const ghsaEntries = ghsaMap.get(pkg.name) ?? []
    const merged = mergeAdvisoryEntries(osvEntries, ghsaEntries, [], kevSet)
    const sources = [osvEntries.length > 0 ? "osv" : "", ghsaEntries.length > 0 ? "ghsa" : ""].filter(Boolean)
    byPkg.set(pkg.name, { merged, sources })
    for (const entry of merged) {
      if (entry.id.startsWith("CVE-") && entry.kind === "vulnerability") cveIds.add(entry.id)
    }
  }

  // Second pass: stamp EPSS scores. Network failures degrade gracefully —
  // affected entries keep `epss: null` and the bypass logic falls back to
  // CVSS/KEV alone.
  const epssScores = cveIds.size > 0 ? await getEpssScores([...cveIds]) : new Map()

  const toCache: AdvisoryCacheEntry[] = []
  let completed = 0

  for (const pkg of uncached) {
    const { merged: base, sources } = byPkg.get(pkg.name) ?? { merged: [], sources: [] }
    const merged = base.map((entry) => {
      const score = epssScores.get(entry.id)
      return score ? { ...entry, epss: score.score } : entry
    })
    const summary = buildSummary(merged)
    result.set(pkg.name, summary)

    // Skip caching on OSV failure: an empty summary would mask real CVEs
    // for the cache TTL and suppress auto-bypass on newly-disclosed fixes.
    if (!osvFailed.has(pkg.name)) {
      toCache.push({
        packageName: pkg.name,
        installedVersion: pkg.installedVersion,
        latestVersion: pkg.latestVersion ?? null,
        summary,
        sources,
      })
    }

    completed++
    onProgress?.(completed, uncached.length)
  }

  cacheAdvisories(toCache)
  return result
}

async function fetchOsvOrTreatAsFailed(
  uncached: readonly Package.Info[],
): Promise<{ osvMap: Map<string, OsvVuln[]>; osvFailed: Set<string> }> {
  try {
    const outcome = await fetchOsvForPackages(
      uncached.map((pkg) => ({ name: pkg.name, installedVersion: pkg.installedVersion })),
    )
    return { osvMap: outcome.byPackage, osvFailed: outcome.failed }
  } catch {
    // Wholesale OSV throw: mark every uncached package failed so none of
    // them get a stale "no advisories" entry written to the cache.
    return { osvMap: new Map(), osvFailed: new Set(uncached.map((pkg) => pkg.name)) }
  }
}

async function fetchGhsaForUncached(uncached: readonly Package.Info[]): Promise<Map<string, Advisory.Entry[]>> {
  const ghsaMap = new Map<string, Advisory.Entry[]>()
  if (!hasGitHubToken()) return ghsaMap

  const targets = uncached
    .map((pkg) => {
      const repo = resolveGhsaRepo(pkg)
      return repo ? { pkg, repo } : null
    })
    .filter((entry): entry is { pkg: Package.Info; repo: string } => entry !== null)

  const results = await runWithConcurrencyLimit(targets, MAX_CONCURRENT_GHSA, async ({ pkg, repo }) => ({
    name: pkg.name,
    entries: await fetchGhsaForPackage(pkg, repo),
  }))
  for (const item of results) {
    if (item instanceof Error) continue
    ghsaMap.set(item.name, item.entries)
  }
  return ghsaMap
}
