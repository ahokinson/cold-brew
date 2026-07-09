import { hasGitHubToken } from "@brew/api"
import { getInstalledPackages, withAdvisories, withMetadata, withOutdatedInfo, withProvenance } from "@brew/packages"
import { evaluateAllPackages } from "@brew/policy"
import { markTrusted } from "@brew/trust"
import type { Package } from "@brew/types"
import { Ansi } from "@cli/ansi"
import { statusClear, statusUpdate } from "@cli/progress"
import {
  getAutoBypassEpss,
  getAutoBypassKev,
  getAutoBypassThreshold,
  getHoldDays,
  getPackagePolicy,
  getVersionPin,
} from "@db"

export interface PreparedPackages {
  packages: Package.WithStatus[]
  holdDays: number
  bypassThreshold: number
  bypassKev: boolean
  // null when EPSS auto-bypass is disabled; a 0–1 float when enabled.
  bypassEpss: number | null
}

// INVARIANT: preparePackages always evaluates hold status from fresh brew
// data (via getInstalledPackages + withOutdatedInfo), never from cached data
// alone. This ensures stale or tampered cache values cannot bypass hold policies.
export async function preparePackages(): Promise<PreparedPackages> {
  if (!hasGitHubToken()) {
    console.warn(
      `${Ansi.YELLOW}warning:${Ansi.RESET} No GITHUB_TOKEN set — using unauthenticated GitHub API (60 req/h vs 5000); publish dates may be rate-limited.`,
    )
  }

  statusUpdate("gathering installed packages...")
  const installed = await getInstalledPackages()

  statusUpdate("checking for outdated packages...")
  const outdated = await withOutdatedInfo(installed)

  const withMeta = await withMetadata(outdated, statusUpdate)

  statusUpdate("checking advisories...")
  const withAdv = await withAdvisories(withMeta, statusUpdate)

  statusUpdate("checking provenance...")
  const withProv = await withProvenance(withAdv, statusUpdate)
  // Flag packages whose origin tap isn't trusted by Homebrew. Cheap, synchronous
  // read of trust.json; recomputed every run so it can't go stale.
  const packages = markTrusted(withProv)
  statusClear()

  const holdDays = getHoldDays()
  const bypassThreshold = getAutoBypassThreshold()
  const bypassKev = getAutoBypassKev()
  const bypassEpss = getAutoBypassEpss()
  const evaluated = evaluateAllPackages(
    packages,
    holdDays,
    getPackagePolicy,
    getVersionPin,
    bypassThreshold,
    bypassKev,
    bypassEpss,
  )

  return { packages: evaluated, holdDays, bypassThreshold, bypassKev, bypassEpss }
}
