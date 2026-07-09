import type { Package } from "@brew/types"

// Canonical tag for an auto-bypassed package. Centralized so CLI and audit
// stay in sync instead of drifting between "[bypassing hold]" and friends.
export function formatBypass(reason: Package.BypassReason | null): string {
  switch (reason) {
    case "kev":
      return "KEV bypass"
    case "epss":
      return "EPSS bypass"
    case "cvss":
      return "CVSS bypass"
    default:
      return ""
  }
}

export function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export function commitDateToAgeDays(dateString: string): number {
  const commitTime = new Date(`${dateString}T00:00:00Z`).getTime()
  return Math.floor((Date.now() - commitTime) / (1000 * 86400))
}
