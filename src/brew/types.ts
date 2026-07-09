export namespace Package {
  export interface InstallReceipt {
    time: number
    source_modified_time: number
    installed_as_dependency: boolean
    installed_on_request: boolean
    built_as_bottle: boolean
    poured_from_bottle: boolean
    source: {
      tap: string
      versions: { stable: string; head: string | null }
    }
  }

  // Casks write a receipt to `Caskroom/<token>/.metadata/INSTALL_RECEIPT.json`.
  // Its `source` shape differs from the formula receipt (no nested `versions`);
  // only the source tap, install time, and request flag are relevant here.
  export interface CaskInstallReceipt {
    time?: number
    installed_on_request?: boolean
    source?: {
      tap?: string
    }
  }

  export namespace DateConfidence {
    export const Authoritative = "authoritative" as const
    export const InstallTime = "install-time" as const
    export const Unknown = "unknown" as const
  }
  export type DateConfidence =
    | typeof DateConfidence.Authoritative
    | typeof DateConfidence.InstallTime
    | typeof DateConfidence.Unknown

  export namespace BypassReason {
    // CVSS: max CVSS for the package's advisories met `auto-bypass-cvss`.
    // Kev:  any advisory's CVE id was on the CISA KEV catalog and
    //       `auto-bypass-kev` is enabled.
    // Epss: any advisory's EPSS score met `auto-bypass-epss`.
    // Precedence when multiple fire: KEV > EPSS > CVSS. Rationale: KEV is
    // confirmed in-the-wild exploitation, EPSS is predicted exploitation,
    // CVSS is theoretical severity. We surface the most specific signal.
    export const Cvss = "cvss" as const
    export const Kev = "kev" as const
    export const Epss = "epss" as const

    export const ALL = [Cvss, Kev, Epss] as const
  }
  export type BypassReason = typeof BypassReason.Cvss | typeof BypassReason.Kev | typeof BypassReason.Epss

  export interface Info {
    name: string
    installedVersion: string
    latestVersion: string | null
    installedAt: number
    sourceModifiedAt: number
    isLeaf: boolean
    installedAsDependency: boolean
    installedOnRequest: boolean
    pinned: boolean
    outdated: boolean
    // Set when `brew outdated` reports the package as outdated AND
    // installed_versions already includes current_version — i.e. the target
    // keg is in the Cellar but unlinked (typically a prior interrupted
    // upgrade). `brew upgrade` no-ops in this state ("Warning: <ver> already
    // installed"); the upgrade path must use `brew reinstall` to relink.
    needsRelink: boolean
    // `tap` is where the package physically lives — for packages cold-brew has
    // stepped, that's "cold-brew/cold-brew". `originTap` is the upstream tap the
    // package actually came from (e.g. "ahokinson/tap"); for unstepped packages
    // the two are identical. Display and trust use originTap; stepping logic
    // keys off `tap`.
    tap: string
    originTap: string
    // Other third-party taps on disk that provide a same-named formula/cask but
    // are not this package's origin. A signal for shadowing: a trusted package
    // (e.g. a genuine homebrew/core install) can have an untrusted namesake tap
    // checked out locally. Populated from the on-disk tap scan; absent on
    // cache-only renders until the next full refresh.
    shadowTaps?: string[]
    // The untrusted shadow tap to surface, derived from `shadowTaps` against the
    // trust store at the render sink. Null when nothing untrusted shadows this
    // package. Only set for packages that are themselves trusted.
    shadowedBy?: string | null
    // Whether originTap is trusted by Homebrew (official tap, or explicitly
    // trusted via `brew trust`). Recomputed from trust.json on every load.
    trusted: boolean
    description: string | null
    isCask: boolean
    dateConfidence: DateConfidence
    homepage?: string | null
    advisories?: Advisory.Summary | null
    provenance?: Provenance.Summary | null
  }

  export interface WithStatus extends Info {
    status: Hold.Status
    sourceAgeDays: number
    holdDaysRemaining: number
    advisories: Advisory.Summary | null
    provenance: Provenance.Summary | null
    bypassReason: BypassReason | null
  }

  export interface VersionHistory {
    version: string
    commitHash: string
    commitDate: string
  }
}

export namespace Advisory {
  export namespace Severity {
    export const Critical = "critical" as const
    export const High = "high" as const
    export const Medium = "medium" as const
    export const Low = "low" as const
    export const Unknown = "unknown" as const

    export const ORDER = [Critical, High, Medium, Low, Unknown] as const

    export function fromCvss(cvss: number | null): Severity {
      if (cvss === null) return Unknown
      if (cvss >= 9.0) return Critical
      if (cvss >= 7.0) return High
      if (cvss >= 4.0) return Medium
      if (cvss > 0) return Low
      return Unknown
    }

    export function rank(severity: Severity): number {
      switch (severity) {
        case Critical:
          return 4
        case High:
          return 3
        case Medium:
          return 2
        case Low:
          return 1
        case Unknown:
          return 0
      }
    }
  }
  export type Severity =
    | typeof Severity.Critical
    | typeof Severity.High
    | typeof Severity.Medium
    | typeof Severity.Low
    | typeof Severity.Unknown

  export namespace Source {
    export const Osv = "osv" as const
    export const Ghsa = "ghsa" as const
    export const Brew = "brew" as const
  }
  export type Source = typeof Source.Osv | typeof Source.Ghsa | typeof Source.Brew

  // "vulnerability": affects the installed version; scored and actionable.
  // "typosquat": a malicious package in another ecosystem shares this formula's
  //   name (typosquat/namesquatting). Not actionable for the installed package;
  //   surfaced as awareness that the name is a known impersonation target.
  export namespace Kind {
    export const Vulnerability = "vulnerability" as const
    export const Typosquat = "typosquat" as const

    export function vulnerabilities(summary: Summary | null | undefined): Entry[] {
      return summary?.entries.filter((e) => e.kind === Vulnerability) ?? []
    }

    export function typosquats(summary: Summary | null | undefined): Entry[] {
      return summary?.entries.filter((e) => e.kind === Typosquat) ?? []
    }
  }
  export type Kind = typeof Kind.Vulnerability | typeof Kind.Typosquat

  export namespace IdPrefix {
    export const Cve = "CVE-" as const
    export const Mal = "MAL-" as const
    export const OsvMal = "OSV-MAL-" as const
    export const Ghsa = "GHSA-" as const
  }

  export interface Entry {
    id: string
    source: Source
    kind: Kind
    severity: Severity
    cvss: number | null
    summary: string
    fixedIn: string | null
    fixInLatest: boolean
    url: string | null
    // True when `id` is a CVE that appears in the CISA Known Exploited
    // Vulnerabilities catalog. Always false for non-CVE ids (GHSA-*, MAL-*).
    kev: boolean
    // EPSS exploit-probability score (0–1) for the CVE id, sourced from
    // FIRST.org. Null when no score is published or the id isn't a CVE.
    epss: number | null
  }

  export interface Summary {
    entries: Entry[]
    maxCvss: number | null
    hasActionableFix: boolean
    // True when any vulnerability entry has `kev === true`. Typosquats are
    // excluded — they never contribute to bypass decisions.
    hasKevListed: boolean
    // Highest EPSS score across vulnerability entries (null if none scored).
    // Typosquats excluded for the same reason as hasKevListed.
    maxEpss: number | null
  }
}

export namespace Provenance {
  // Detection signals raised against the formula source code itself. None of
  // these auto-block or auto-bypass — the hold window already gates upgrades,
  // and provenance flags exist so the user can see *why* the wait is
  // earning its keep. Treat as informational.
  export namespace FlagKind {
    // Commit author has never authored this formula file before. Catches the
    // classic maintainer-hijack pattern (xz, Shai-Hulud). Honest caveat:
    // legitimate new contributors trip this too — it's a prompt to look, not
    // a verdict.
    export const NewMaintainer = "new-maintainer" as const
    // Added line invokes `system "curl"`, `system "bash"`, `system "sh"`,
    // `system "wget"`, or similar shell-shaped subprocesses. The standard
    // post-install foothold for a compromised formula.
    export const SystemCall = "system-call" as const
    // Added line uses `inreplace`. Inreplace blocks are arbitrary-edit
    // primitives and a known abuse vector for malicious patches.
    export const Inreplace = "inreplace" as const

    export const ALL = [NewMaintainer, SystemCall, Inreplace] as const
  }
  export type FlagKind = typeof FlagKind.NewMaintainer | typeof FlagKind.SystemCall | typeof FlagKind.Inreplace

  export interface Flag {
    kind: FlagKind
    detail: string
    commitSha: string
    commitUrl: string
  }

  export interface Summary {
    flags: Flag[]
    commitsScanned: number
    // Unix-epoch seconds of the oldest commit examined — i.e. the cutoff
    // passed to GitHub's `since` parameter. Useful for "looked at N commits
    // since {date}" rendering.
    rangeFrom: number
  }
}

export namespace Hold {
  export const Ready = "ready" as const
  export const Held = "held" as const
  export const UpToDate = "up-to-date" as const
  export const BrewPinned = "brew-pinned" as const
  export const AlwaysHold = "always-hold" as const
  export const AlwaysAllow = "always-allow" as const
  export const ColdBrewPinned = "cold-brew-pinned" as const
  // Installed version is newer than upstream's `latestVersion` — usually
  // because upstream yanked, reverted, or downgraded a release. Distinct
  // from ColdBrewPinned (which means the user explicitly pinned) so the
  // status surface doesn't lie about *who* asked for the version freeze.
  export const AheadOfUpstream = "ahead-of-upstream" as const

  export type Status =
    | typeof Ready
    | typeof Held
    | typeof UpToDate
    | typeof BrewPinned
    | typeof AlwaysHold
    | typeof AlwaysAllow
    | typeof ColdBrewPinned
    | typeof AheadOfUpstream

  export namespace Policy {
    export const AlwaysHold = "always-hold" as const
    export const AlwaysAllow = "always-allow" as const
    export const Default = "default" as const

    export const ALL = [AlwaysHold, AlwaysAllow, Default] as const
  }
  export type Policy = typeof Policy.AlwaysHold | typeof Policy.AlwaysAllow | typeof Policy.Default
}

export namespace View {
  export namespace SortField {
    export const Name = "name" as const
    export const Status = "status" as const
    export const Age = "age" as const
    export const Installed = "installed" as const
    export const Severity = "severity" as const
  }
  export type SortField =
    | typeof SortField.Name
    | typeof SortField.Status
    | typeof SortField.Age
    | typeof SortField.Installed
    | typeof SortField.Severity

  export namespace StatusFilter {
    export const Actionable = "actionable" as const
    export const Ready = "ready" as const
    export const Held = "held" as const
    export const All = "all" as const
  }
  export type StatusFilter =
    | typeof StatusFilter.Actionable
    | typeof StatusFilter.Ready
    | typeof StatusFilter.Held
    | typeof StatusFilter.All
}
