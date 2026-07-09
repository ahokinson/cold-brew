import type { ConfirmAction as DialogConfirmAction } from "@ahokinson/press/components"
import { type ConfirmRequest, createConfirmState, createStatusState, type StatusState } from "@ahokinson/press/models"
import type { TerminalHandover } from "@ahokinson/press/terminal"
import { brewInstallVersion, brewReinstallFromTap, brewTrust, brewUpdate, brewUpgrade } from "@brew/api"
import { getInstalledPackages, withAdvisories, withMetadata, withOutdatedInfo } from "@brew/packages"
import { evaluateAllPackages } from "@brew/policy"
import { Status } from "@brew/status"
import { resolveIntermediateUpgrades } from "@brew/stepping"
import { markTrusted } from "@brew/trust"
import { Hold, type Package } from "@brew/types"
import {
  cachePackages,
  clearAllCaches,
  clearVersionPin,
  getAutoBypassThreshold,
  getCachedAdvisories,
  getCachedPackages,
  getHoldDays,
  getOriginalTap,
  getPackagePolicy,
  getStaleCachedPackages,
  getVersionPin,
  logUpgrade,
  setPackagePolicy,
} from "@db"
import { createListState, type ListState } from "@tui/state/list"
import { createSettingsState, type SettingsState } from "@tui/state/settings"
import { createVersionPickerState, type VersionPickerState } from "@tui/state/versions"
import { createMemo, createSignal } from "solid-js"

export type { ScrollRef } from "@tui/state/list"

export interface PackageStore extends ListState, VersionPickerState, StatusState, SettingsState {
  packages: () => Package.WithStatus[]
  loading: () => boolean
  offline: () => boolean
  refresh: (options?: { force?: boolean }) => Promise<void>
  reevaluate: () => void
  toggleHold: (name: string) => void
  trustTap: (pkg: Package.WithStatus) => Promise<void>
  upgradePackage: (name: string) => Promise<void>
  upgradeAllReady: () => Promise<void>
  restoreAllTapPackages: () => Promise<void>
  confirmAction: () => ConfirmRequest | null
  requestConfirm: (action: ConfirmRequest) => void
  cancelConfirm: () => void
  executeConfirm: () => void
  /** Pre-wired accessor for `<ConfirmDialog action={store.dialogAction} />`. */
  dialogAction: () => DialogConfirmAction | null
  stats: () => {
    total: number
    leaves: number
    dependencies: number
    outdated: number
    held: number
    ready: number
  }
}

export interface PackageStoreConfig {
  handover: TerminalHandover
}

export function createPackageStore(config: PackageStoreConfig): PackageStore {
  const { handover } = config
  const [rawPackages, setRawPackages] = createSignal<Package.WithStatus[]>([])
  const [loading, setLoading] = createSignal(false)
  const [offline, setOffline] = createSignal(false)

  const list = createListState(rawPackages)
  const status = createStatusState()

  function applyPackages(packages: Package.WithStatus[]) {
    // Recompute trust at the single render sink so it reflects the current
    // trust.json — including changes made via the in-app trust action this run.
    const trusted = markTrusted(packages)
    setRawPackages(trusted)
    list.setCursor((c) => Math.min(c, Math.max(0, trusted.length - 1)))
  }

  function attachCachedAdvisories(packages: Package.Info[]): Package.Info[] {
    const advisories = getCachedAdvisories(
      packages.map((pkg) => ({
        name: pkg.name,
        installedVersion: pkg.installedVersion,
        latestVersion: pkg.latestVersion ?? null,
      })),
    )
    return packages.map((pkg) => ({ ...pkg, advisories: advisories.get(pkg.name) ?? null }))
  }

  function loadFromCache(): boolean {
    const cached = getCachedPackages()
    if (!cached) return false

    const withAdvisories = attachCachedAdvisories(cached)
    const evaluated = evaluateAllPackages(
      withAdvisories,
      getHoldDays(),
      getPackagePolicy,
      getVersionPin,
      getAutoBypassThreshold(),
    )
    applyPackages(evaluated)
    return true
  }

  function loadFromStaleCache(): boolean {
    const stalePackages = getStaleCachedPackages()
    if (!stalePackages) return false

    const withAdvisories = attachCachedAdvisories(stalePackages)
    const evaluated = evaluateAllPackages(
      withAdvisories,
      getHoldDays(),
      getPackagePolicy,
      getVersionPin,
      getAutoBypassThreshold(),
    )
    applyPackages(evaluated)
    return true
  }

  async function fullRefresh() {
    status.busy.showReason("Gathering installed packages...")
    const installed = await getInstalledPackages()

    status.busy.showReason("Checking outdated packages...")
    const withOutdated = await withOutdatedInfo(installed)

    const withMeta = await withMetadata(withOutdated, (message) => status.busy.showReason(message))

    // Render immediately with metadata + any cached advisories. Fresh advisory
    // data streams in via the background fetch below — packages don't wait on
    // OSV/GHSA roundtrips to become visible.
    const withCachedAdv = attachCachedAdvisories(withMeta)
    applyPackages(
      evaluateAllPackages(withCachedAdv, getHoldDays(), getPackagePolicy, getVersionPin, getAutoBypassThreshold()),
    )
    cachePackages(withCachedAdv)
    setOffline(false)

    // Background advisory refresh — patches in when done; swallow failures.
    status.busy.showReason("Checking advisories...")
    withAdvisories(withMeta, (message) => status.busy.showReason(message))
      .then((full) => {
        applyPackages(
          evaluateAllPackages(full, getHoldDays(), getPackagePolicy, getVersionPin, getAutoBypassThreshold()),
        )
        cachePackages(full)
      })
      .catch(() => {})
      .finally(() => status.busy.clear())
  }

  async function refresh(options?: { force?: boolean }) {
    const force = options?.force ?? false

    if (force) {
      clearAllCaches()
    }

    if (!force && loadFromCache()) {
      status.busy.showReason("Updating Homebrew...")
      brewUpdate()
        .catch(() => {})
        .then(() => fullRefresh())
        .catch(() => {
          setOffline(true)
          status.showMessage("Offline — showing cached data")
          status.busy.clear()
        })
      // Note: fullRefresh clears busy itself once its background advisory
      // fetch completes. Don't add a finally that clears prematurely.
      return
    }

    setLoading(true)
    try {
      if (!force) {
        status.busy.showReason("Updating Homebrew...")
        try {
          await brewUpdate()
        } catch {}
      } else {
        status.busy.showReason("Refreshing...")
      }
      await fullRefresh()
    } catch {
      setOffline(true)
      if (loadFromStaleCache()) {
        status.showMessage("Offline — showing cached data")
      } else {
        try {
          const installed = await getInstalledPackages()
          const evaluated = evaluateAllPackages(
            installed,
            getHoldDays(),
            getPackagePolicy,
            getVersionPin,
            getAutoBypassThreshold(),
          )
          applyPackages(evaluated)
          status.showMessage("Offline — showing local package info only")
        } catch {
          status.showMessage("Unable to load packages — brew may be unavailable")
        }
      }
      status.busy.clear()
    } finally {
      setLoading(false)
    }
  }

  function reevaluate() {
    setRawPackages((current) => {
      return evaluateAllPackages(
        current.map((pkg) => ({ ...pkg })),
        getHoldDays(),
        getPackagePolicy,
        getVersionPin,
        getAutoBypassThreshold(),
      )
    })
  }

  const confirm = createConfirmState()

  const versionPicker = createVersionPickerState(list.selectedPackage, refresh, status.showMessage, handover)
  const settings = createSettingsState(reevaluate, status.showMessage)

  const stats = createMemo(() => {
    const all = rawPackages()
    let leaves = 0
    let outdated = 0
    let held = 0
    let ready = 0
    for (const pkg of all) {
      if (pkg.isLeaf) leaves++
      if (pkg.outdated) outdated++
      if (pkg.status === Hold.Held || pkg.status === Hold.AlwaysHold) held++
      if (Status.isReady(pkg)) ready++
    }
    return {
      total: all.length,
      leaves,
      dependencies: all.length - leaves,
      outdated,
      held,
      ready,
    }
  })

  function toggleHold(name: string) {
    const current = getPackagePolicy(name)
    const next = current === "always-hold" ? "default" : "always-hold"
    setPackagePolicy(name, next)
    reevaluate()
    status.showMessage(next === "always-hold" ? `Holding ${name}` : `Released ${name}`)
  }

  async function trustTap(pkg: Package.WithStatus) {
    status.busy.showReason(`Trusting ${pkg.originTap}...`)
    try {
      const exitCode = await brewTrust(pkg.originTap)
      status.showMessage(
        exitCode === 0 ? `Trusted ${pkg.originTap}` : `Failed to trust ${pkg.originTap} (exit ${exitCode})`,
      )
      await refresh({ force: true })
    } finally {
      status.busy.clear()
    }
  }

  async function upgradePackage(name: string) {
    const pkg = rawPackages().find((candidate) => candidate.name === name)
    if (!pkg) return
    // brew refuses to load packages from untrusted taps, so the upgrade would
    // just fail. Surface the reason instead; the user trusts the tap explicitly
    // via the trust action.
    if (!pkg.trusted) {
      status.showMessage(`${name} is from an untrusted tap (${pkg.originTap})`)
      return
    }
    status.busy.showReason(`Upgrading ${name}...`)
    try {
      const result = await handover(() =>
        brewUpgrade([
          {
            name,
            isCask: pkg.isCask,
            tap: pkg.tap,
            originalTap: getOriginalTap(name),
            installedVersion: pkg.installedVersion,
          },
        ]),
      )
      if (result.exitCode !== 0) {
        status.showMessage(`Failed to upgrade ${name} (exit ${result.exitCode})`)
        await refresh({ force: true })
        return
      }
      // Pin only released after brew confirms the upgrade landed; a failed
      // run otherwise leaves the user pinned in the database to a version
      // they are no longer running.
      clearVersionPin(name)
      logUpgrade(name, pkg.installedVersion, pkg.latestVersion ?? pkg.installedVersion, pkg.sourceAgeDays)
      status.showMessage(`Upgraded ${name} ${pkg.installedVersion} → ${pkg.latestVersion ?? pkg.installedVersion}`)
      await refresh({ force: true })
    } finally {
      status.busy.clear()
    }
  }

  async function upgradeAllReady() {
    // Exclude untrusted-tap packages: brew refuses to load them, which would
    // abort the whole batch and starve the trusted packages. Keeping them out
    // of both the direct batch and stepping preserves the trust gate.
    const ready = rawPackages().filter((pkg) => Status.isReady(pkg) && pkg.trusted)
    const held = rawPackages().filter((pkg) => pkg.status === Hold.Held && pkg.trusted)
    const skippedUntrusted = rawPackages().filter(
      (pkg) => !pkg.trusted && (Status.isReady(pkg) || pkg.status === Hold.Held),
    ).length

    status.busy.showReason("Resolving intermediate upgrades...")
    // Cold-brew-tap packages that already cleared their post-step hold window
    // land in `ready`. Feed them back through stepping so we keep walking the
    // intermediate ladder instead of jumping to latest.
    const midSteppingReady = ready.filter((pkg) => pkg.tap === "cold-brew/cold-brew")
    const stepCandidates = [...held, ...midSteppingReady]
    const resolution =
      stepCandidates.length > 0 ? await resolveIntermediateUpgrades(stepCandidates, getHoldDays()) : null
    const intermediate = resolution?.intermediate ?? []
    const steppedNames = new Set(intermediate.map((step) => step.pkg.name))
    const remainingReady = ready.filter((pkg) => !steppedNames.has(pkg.name))

    const untrustedNote = skippedUntrusted > 0 ? `; skipped ${skippedUntrusted} untrusted` : ""

    const totalActions = remainingReady.length + intermediate.length
    if (totalActions === 0) {
      if (skippedUntrusted > 0) {
        status.showMessage(`Skipped ${skippedUntrusted} untrusted package${skippedUntrusted > 1 ? "s" : ""}`)
      }
      status.busy.clear()
      return
    }

    status.busy.showReason(`Upgrading ${totalActions} package${totalActions > 1 ? "s" : ""}...`)
    try {
      const stepOutcome = await runSteppingBatch(intermediate)
      let upgraded = stepOutcome.upgraded
      let failed = stepOutcome.failed

      if (!failed && remainingReady.length > 0) {
        const directOutcome = await runDirectUpgradeBatch(remainingReady)
        upgraded += directOutcome.upgraded
        failed = directOutcome.failed
      }

      if (failed) {
        status.showMessage(`Upgraded ${upgraded}/${totalActions}; failed on ${failed}${untrustedNote}`)
      } else {
        status.showMessage(`Upgraded ${totalActions} package${totalActions > 1 ? "s" : ""}${untrustedNote}`)
      }
      await refresh({ force: true })
    } finally {
      status.busy.clear()
    }
  }

  interface BatchOutcome {
    upgraded: number
    failed: string | null
  }

  async function runSteppingBatch(
    steps: Awaited<ReturnType<typeof resolveIntermediateUpgrades>>["intermediate"],
  ): Promise<BatchOutcome> {
    let upgraded = 0
    for (const step of steps) {
      const exitCode = await handover(() =>
        brewInstallVersion(step.pkg.name, step.version, step.commitHash, step.pkg.isCask, step.effectiveTap),
      )
      if (exitCode !== 0) {
        return { upgraded, failed: `${step.pkg.name} ${step.version} (exit ${exitCode})` }
      }
      logUpgrade(step.pkg.name, step.pkg.installedVersion, step.version, step.ageDays)
      upgraded++
    }
    return { upgraded, failed: null }
  }

  async function runDirectUpgradeBatch(packages: Package.WithStatus[]): Promise<BatchOutcome> {
    const result = await handover(() =>
      brewUpgrade(
        packages.map((package_) => ({
          name: package_.name,
          isCask: package_.isCask,
          tap: package_.tap,
          originalTap: getOriginalTap(package_.name),
          installedVersion: package_.installedVersion,
        })),
      ),
    )
    const succeeded = new Set([...result.formulaeSucceeded, ...result.casksSucceeded])
    let upgraded = 0
    for (const pkg of packages) {
      if (!succeeded.has(pkg.name)) continue
      logUpgrade(pkg.name, pkg.installedVersion, pkg.latestVersion ?? pkg.installedVersion, pkg.sourceAgeDays)
      upgraded++
    }
    return {
      upgraded,
      failed: result.exitCode !== 0 ? `brew upgrade exit ${result.exitCode}` : null,
    }
  }

  async function restoreAllTapPackages() {
    const tapPackages = rawPackages().filter((pkg) => pkg.tap === "cold-brew/cold-brew")
    if (tapPackages.length === 0) {
      status.showMessage("No cold-brew tap packages found")
      return
    }
    status.busy.showReason(`Restoring ${tapPackages.length} packages to official versions...`)
    try {
      let restored = 0
      const failures: string[] = []
      for (const tapPackage of tapPackages) {
        const originalTap = getOriginalTap(tapPackage.name) ?? (tapPackage.isCask ? "homebrew/cask" : "homebrew/core")
        const exitCode = await handover(() => brewReinstallFromTap(tapPackage.name, tapPackage.isCask, originalTap))
        if (exitCode !== 0) {
          failures.push(`${tapPackage.name} (exit ${exitCode})`)
          continue
        }
        // Pin only released after the official tap reinstall lands so a failed
        // restore doesn't leave the package un-pinned but still on cold-brew/cold-brew.
        clearVersionPin(tapPackage.name)
        restored++
      }
      if (failures.length > 0) {
        status.showMessage(`Restored ${restored}/${tapPackages.length}; failed: ${failures.join(", ")}`)
      } else {
        status.showMessage(`Restored ${tapPackages.length} packages to official versions`)
      }
      await refresh({ force: true })
    } finally {
      status.busy.clear()
    }
  }

  return {
    packages: rawPackages,
    loading,
    offline,
    ...list,
    ...versionPicker,
    ...status,
    ...settings,
    refresh,
    reevaluate,
    toggleHold,
    trustTap,
    upgradePackage,
    upgradeAllReady,
    restoreAllTapPackages,
    confirmAction: confirm.action,
    requestConfirm: confirm.request,
    cancelConfirm: confirm.cancel,
    executeConfirm: confirm.execute,
    dialogAction: confirm.dialogAction,
    stats,
  }
}
