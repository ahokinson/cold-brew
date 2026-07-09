import { isCustomTap } from "@brew/tap"
import { Advisory, Hold, type Package } from "@brew/types"
import type { Theme } from "@tui/context/theme"
import { Icon } from "@tui/icons"

export namespace Status {
  export const SECTION_ACTIONABLE = 0
  export const SECTION_STABLE = 1

  export function isReady(pkg: Package.WithStatus): boolean {
    return pkg.status === Hold.Ready || pkg.status === Hold.AlwaysAllow
  }

  export function isHeld(pkg: Package.WithStatus): boolean {
    return pkg.status === Hold.Held || pkg.status === Hold.AlwaysHold || pkg.status === Hold.BrewPinned
  }

  export function isActionable(pkg: Package.WithStatus): boolean {
    return (
      pkg.isLeaf &&
      pkg.status !== Hold.UpToDate &&
      pkg.status !== Hold.ColdBrewPinned &&
      pkg.status !== Hold.AheadOfUpstream
    )
  }

  export function section(pkg: Package.WithStatus): number {
    if (pkg.status === Hold.UpToDate || pkg.status === Hold.ColdBrewPinned || pkg.status === Hold.AheadOfUpstream)
      return SECTION_STABLE
    return SECTION_ACTIONABLE
  }

  export function sectionLabel(sectionId: number): string | null {
    switch (sectionId) {
      case SECTION_ACTIONABLE:
        return "actionable"
      case SECTION_STABLE:
        return "stable"
      default:
        return null
    }
  }

  export function glyph(status: Hold.Status): string {
    switch (status) {
      case Hold.UpToDate:
        return "  "
      case Hold.Ready:
        return Icon.ready.char
      case Hold.Held:
        return Icon.held.char
      case Hold.BrewPinned:
        return Icon.pinned.char
      case Hold.AlwaysHold:
        return Icon.pinned.char
      case Hold.AlwaysAllow:
        return Icon.bolt.char
      case Hold.ColdBrewPinned:
        return Icon.versionPinned.char
      case Hold.AheadOfUpstream:
        return Icon.triangleWarning.char
    }
  }

  export function isTooNew(pkg: Package.WithStatus, holdDays: number): boolean {
    if (holdDays === 0) return false
    if (pkg.status === Hold.UpToDate) return false
    if (!pkg.outdated) return false
    return pkg.sourceAgeDays < Math.ceil(holdDays / 3)
  }

  export function tapColor(tap: string, theme: Theme): string {
    if (tap === "cold-brew/cold-brew") return theme.accent
    if (isCustomTap(tap)) return theme.lavender
    return theme.textDim
  }

  // Untrusted taps are a caution, not a failure — use the warning/stale hue
  // rather than the critical-advisory red.
  export function untrustedColor(theme: Theme): string {
    return theme.maroon
  }

  // A trusted package shadowed by an untrusted same-named tap on disk is a
  // milder caution than an untrusted package — a confusion/typo risk worth
  // noting, not a trust failure. Use the stale hue to distinguish it.
  export function shadowColor(theme: Theme): string {
    return theme.stale
  }

  export function color(status: Hold.Status, theme: Theme): string {
    switch (status) {
      case Hold.UpToDate:
        return theme.textFaint
      case Hold.Ready:
        return theme.ready
      case Hold.Held:
        return theme.fresh
      case Hold.BrewPinned:
        return theme.flamingo
      case Hold.AlwaysHold:
        return theme.locked
      case Hold.AlwaysAllow:
        return theme.teal
      case Hold.ColdBrewPinned:
        return theme.pinned
      case Hold.AheadOfUpstream:
        return theme.stale
    }
  }

  export function severityColor(severity: Advisory.Severity, theme: Theme): string {
    switch (severity) {
      case "critical":
        return theme.overdue
      case "high":
        return theme.fresh
      case "medium":
        return theme.stale
      case "low":
        return theme.textDim
      case "unknown":
        return theme.textDim
    }
  }

  export function severityGlyph(severity: Advisory.Severity): string {
    switch (severity) {
      case "critical":
      case "high":
      case "medium":
        return Icon.bug.char
      case "low":
      case "unknown":
        return ""
    }
  }

  export function topSeverity(pkg: Package.WithStatus): Advisory.Severity | null {
    const vulns = Advisory.Kind.vulnerabilities(pkg.advisories)
    if (vulns.length === 0) return null
    return vulns[0]!.severity
  }

  export function ageColor(pkg: Package.WithStatus, theme: Theme, holdDays: number): string {
    if (!isActionable(pkg)) return theme.textDim
    if (isHeld(pkg)) return color(pkg.status, theme)
    if (holdDays === 0) return theme.ready
    const ageDays = pkg.sourceAgeDays
    if (ageDays < holdDays) return theme.maroon
    if (ageDays < holdDays * 2) return theme.stale
    if (ageDays < holdDays * 4) return theme.ready
    if (ageDays < holdDays * 8) return theme.textDim
    return theme.overdue
  }
}
