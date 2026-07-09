import { Status } from "@brew/status"
import { Hold, Package } from "@brew/types"

const SECONDS_PER_DAY = 86400

function parseVersionPart(s: string): number {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

// Homebrew encodes formula revisions as `_N` (e.g. `8.1_1` is version 8.1, revision 1).
export function parseVersion(s: string): number[] {
  const underscore = s.indexOf("_")
  const base = underscore === -1 ? s : s.slice(0, underscore)
  const revision = underscore === -1 ? 0 : parseVersionPart(s.slice(underscore + 1))
  const parts = base.split(".").map(parseVersionPart)
  parts.push(revision)
  return parts
}

export function isVersionAhead(installed: string, latest: string): boolean {
  const installedParts = parseVersion(installed)
  const latestParts = parseVersion(latest)
  const length = Math.max(installedParts.length, latestParts.length)
  for (let i = 0; i < length; i++) {
    const a = installedParts[i] ?? 0
    const b = latestParts[i] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return false
}

// Reproducible-build tooling stamps archive entries with fixed sentinel mtimes
// far in the past: npm uses 1985-10-26 ("Back to the Future"), zip uses
// 1980-01-01. Homebrew surfaces these verbatim as source_modified_time, which
// would otherwise read as a ~40-year-old package (e.g. playwright-cli's npm
// tarball). No real package source predates this floor, so treat anything
// below it as unknown and let the install-time / GitHub-date fallbacks take over.
export const MIN_PLAUSIBLE_SOURCE_TIME = Math.floor(Date.UTC(2000, 0, 1) / 1000)

export function isPlausibleSourceTime(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds >= MIN_PLAUSIBLE_SOURCE_TIME
}

export function getSourceAgeDays(sourceModifiedTime: number): number {
  // Treat unknown dates (0, negative sentinel, NaN) as zero days old so the
  // package stays held until a valid date is resolved. Without this guard,
  // sourceModifiedTime=0 would compute age from the Unix epoch (~20k days),
  // satisfying any hold window and silently bypassing the policy.
  if (!Number.isFinite(sourceModifiedTime) || sourceModifiedTime <= 0) return 0
  const publishDate = new Date(sourceModifiedTime * 1000)
  const publishMidnight = Date.UTC(publishDate.getUTCFullYear(), publishDate.getUTCMonth(), publishDate.getUTCDate())
  const days = Math.floor((Date.now() - publishMidnight) / (1000 * SECONDS_PER_DAY))
  if (!Number.isFinite(days) || days < 0) return 0
  return days
}

export function formatAgeDays(days: number): string {
  if (days >= 365) {
    const years = Math.floor(days / 365)
    const months = Math.floor((days % 365) / 30)
    return `${years}y ${months}m`
  }
  if (days >= 30) {
    const months = Math.floor(days / 30)
    const remainingDays = days % 30
    return `${months}m ${remainingDays}d`
  }
  return `${days}d`
}

export function evaluateHoldStatus(
  pkg: Package.Info,
  holdDays: number,
  policy: Hold.Policy,
  versionPin: string | null,
  autoBypassThreshold = Number.POSITIVE_INFINITY,
  autoBypassKev = false,
  autoBypassEpss: number | null = null,
): Package.WithStatus {
  const effectiveModifiedAt =
    pkg.sourceModifiedAt > 0 ? pkg.sourceModifiedAt : pkg.installedAt > 0 ? pkg.installedAt : 0
  const sourceAgeDays = getSourceAgeDays(effectiveModifiedAt)
  const holdDaysRemaining = Math.max(0, holdDays - sourceAgeDays)

  let status: Hold.Status

  if (versionPin && pkg.installedVersion === versionPin) {
    status = Hold.ColdBrewPinned
  } else if (pkg.outdated && pkg.latestVersion && isVersionAhead(pkg.installedVersion, pkg.latestVersion)) {
    // Installed is newer than upstream's latest — upstream rolled back.
    // Distinct from ColdBrewPinned so we don't blame the user for it.
    status = Hold.AheadOfUpstream
  } else if (pkg.tap === "cold-brew/cold-brew" && versionPin) {
    status = Hold.ColdBrewPinned
  } else if (policy === "always-hold") {
    status = Hold.AlwaysHold
  } else if (policy === "always-allow") {
    status = Hold.AlwaysAllow
  } else if (pkg.pinned) {
    status = Hold.BrewPinned
  } else if (!pkg.outdated) {
    status = Hold.UpToDate
  } else if (sourceAgeDays < holdDays) {
    status = Hold.Held
  } else {
    status = Hold.Ready
  }

  const advisories = pkg.advisories ?? null
  let bypassReason: Package.BypassReason | null = null

  // Auto-bypass: promote Held → Ready only when advisory data is present and
  // a fix is available in latestVersion. Three independent signals can trigger:
  //   1. KEV-listed CVE  (auto-bypass-kev enabled).
  //   2. EPSS score ≥ threshold  (auto-bypass-epss is a 0–1 float, or null).
  //   3. Max CVSS ≥ threshold.
  // Precedence when multiple fire: KEV > EPSS > CVSS. KEV is confirmed
  // in-the-wild exploitation, EPSS is predicted exploitation, CVSS is
  // theoretical severity — we surface the most specific signal in
  // bypassReason. Never overrides explicit user intent (AlwaysHold,
  // BrewPinned, ColdBrewPinned).
  if (status === Hold.Held && advisories && advisories.hasActionableFix) {
    if (autoBypassKev && advisories.hasKevListed) {
      status = Hold.Ready
      bypassReason = Package.BypassReason.Kev
    } else if (autoBypassEpss !== null && advisories.maxEpss !== null && advisories.maxEpss >= autoBypassEpss) {
      status = Hold.Ready
      bypassReason = Package.BypassReason.Epss
    } else if (Number.isFinite(autoBypassThreshold) && (advisories.maxCvss ?? 0) >= autoBypassThreshold) {
      status = Hold.Ready
      bypassReason = Package.BypassReason.Cvss
    }
  }

  return {
    ...pkg,
    status,
    sourceAgeDays,
    holdDaysRemaining,
    advisories,
    provenance: pkg.provenance ?? null,
    bypassReason,
  }
}

export function evaluateAllPackages(
  packages: Package.Info[],
  holdDays: number,
  policyFor: (name: string) => Hold.Policy,
  versionPinFor: (name: string) => string | null,
  autoBypassThreshold = Number.POSITIVE_INFINITY,
  autoBypassKev = false,
  autoBypassEpss: number | null = null,
): Package.WithStatus[] {
  return packages.map((pkg) => {
    return evaluateHoldStatus(
      pkg,
      holdDays,
      policyFor(pkg.name),
      versionPinFor(pkg.name),
      autoBypassThreshold,
      autoBypassKev,
      autoBypassEpss,
    )
  })
}

export interface UpgradePartition {
  upgrade: Package.WithStatus[]
  held: Package.WithStatus[]
}

export function partitionUpgrade(packages: Package.WithStatus[]): UpgradePartition {
  const upgrade: Package.WithStatus[] = []
  const held: Package.WithStatus[] = []

  for (const pkg of packages) {
    // Skip up-to-date AlwaysAllow: would otherwise log a from==to upgrade.
    if (!pkg.outdated) continue
    if (pkg.status === Hold.ColdBrewPinned) continue
    if (pkg.status === Hold.AheadOfUpstream) continue
    if (Status.isReady(pkg)) {
      upgrade.push(pkg)
    } else if (Status.isHeld(pkg)) {
      held.push(pkg)
    }
  }

  return { upgrade, held }
}

export function formatHoldReason(pkg: Package.WithStatus): string {
  switch (pkg.status) {
    case Hold.Held:
      // nf-fa-hourglass_start — kept distinct from the hourglass_half used
      // for the status glyph so one symbol doesn't mean both "held" and
      // "time remaining".
      return `\u{F251} ${pkg.holdDaysRemaining}d left`
    case Hold.AlwaysHold:
      return "always held"
    case Hold.BrewPinned:
      return "pinned by brew"
    case Hold.AlwaysAllow:
      return "always allowed"
    case Hold.Ready:
      return `${formatAgeDays(pkg.sourceAgeDays)} old`
    case Hold.UpToDate:
      return "up to date"
    case Hold.ColdBrewPinned:
      return `pinned to ${pkg.installedVersion}`
    case Hold.AheadOfUpstream:
      return `ahead of upstream (latest ${pkg.latestVersion ?? "?"})`
  }
}
