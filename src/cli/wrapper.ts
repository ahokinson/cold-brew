import { brewInstallVersion, brewUpgrade } from "@brew/api"
import { formatBypass } from "@brew/format"
import { bareName } from "@brew/packages"
import { formatHoldReason, partitionUpgrade } from "@brew/policy"
import { resolveIntermediateUpgrades } from "@brew/stepping"
import { Hold, type Package } from "@brew/types"
import { Ansi, bold, Color, dim, plural } from "@cli/ansi"
import { preparePackages } from "@cli/prepare"
import { statusClear, statusUpdate } from "@cli/progress"
import { getHoldDays, getOriginalTap, logUpgrade } from "@db"

interface Row {
  name: string
  arrow: string
  badge: string
}

function arrowText(pkg: Package.WithStatus): string {
  return `${pkg.installedVersion} → ${pkg.latestVersion ?? "?"}`
}

function renderRows(rows: Row[], color: string): void {
  if (rows.length === 0) return
  // reduce, not Math.max(...spread): a large batch would overflow the arg limit.
  const maxName = rows.reduce((m, row) => Math.max(m, row.name.length), 0)
  const maxArrow = rows.reduce((m, row) => Math.max(m, row.arrow.length), 0)
  for (const row of rows) {
    const name = row.name.padEnd(maxName)
    const arrow = row.arrow.padEnd(maxArrow)
    console.log(`  ${name}  ${dim(arrow)}  ${color}${row.badge}${Ansi.RESET}`)
  }
}

// brewUpgrade condenses brew's own progress away, so cold-brew reports the
// per-package verdict from its own success set: any planned package not in the
// succeeded set failed (brew's error detail is surfaced by brewUpgrade's
// "other brew output:" trailer just above this).
function reportFailures(planned: Package.WithStatus[], succeeded: Set<string>): void {
  const failed = planned.filter((pkg) => !succeeded.has(pkg.name))
  if (failed.length === 0) return
  console.log(`\n${Ansi.RED}${bold(`Failed ${failed.length} ${plural(failed.length, "package")}:`)}${Ansi.RESET}`)
  renderRows(
    failed.map((pkg) => ({ name: pkg.name, arrow: arrowText(pkg), badge: "failed" })),
    Ansi.RED,
  )
}

export async function handleUpgrade(args: string[]): Promise<number> {
  const force = args.includes("--force") || args.includes("-f")
  const specificPackages = args.slice(1).filter((argument) => !argument.startsWith("-"))

  const holdDays = getHoldDays()
  console.log(
    dim(`cold-brew: checking packages (hold window: ${holdDays} days, fetching advisories may take a moment)...`),
  )

  let { packages: evaluated } = await preparePackages()

  if (specificPackages.length > 0) {
    // brew accepts both bare and tap-qualified names (`claude-code` and
    // `ahokinson/tap/claude-code`); cold-brew tracks packages by bare name
    // internally, so strip any tap prefix before matching.
    const names = new Set(specificPackages.map(bareName))
    const installedNames = new Set(evaluated.map((pkg) => pkg.name))
    evaluated = evaluated.filter((pkg) => names.has(pkg.name))
    const unknown = [...names].filter((name) => !installedNames.has(name))
    if (unknown.length > 0) {
      console.log(`${Ansi.YELLOW}${bold(`Not installed: ${unknown.join(", ")}`)}${Ansi.RESET}`)
      if (evaluated.length === 0) return 1
    }
  }

  // Drop packages whose origin tap Homebrew doesn't trust. `brew upgrade`
  // loads every package in a batch up front; one untrusted tap makes brew
  // refuse to load and abort the whole batch, starving the trusted siblings.
  // Filtering here keeps untrusted packages out of every downstream path —
  // the upgrade batches *and* stepping (which would otherwise launder an
  // untrusted formula through the trusted cold-brew/cold-brew tap). We don't
  // auto-trust; the user opts in explicitly via the TUI trust action.
  const untrusted = evaluated.filter((pkg) => pkg.outdated && !pkg.trusted)
  evaluated = evaluated.filter((pkg) => pkg.trusted)
  if (untrusted.length > 0) {
    console.log(
      `\n${Color.held}${bold(`Skipping ${untrusted.length} ${plural(untrusted.length, "package")} from untrusted ${plural(untrusted.length, "tap")}:`)}${Ansi.RESET}`,
    )
    renderRows(
      untrusted.map((pkg) => ({
        name: pkg.name,
        arrow: arrowText(pkg),
        badge: pkg.originTap,
      })),
      Color.held,
    )
    // An explicit request that resolves only to untrusted packages did nothing
    // the user asked for — report failure rather than a misleading exit 0.
    if (specificPackages.length > 0 && evaluated.length === 0) return 1
  }

  if (force) {
    // --force overrides the hold window, not explicit version pins.
    const outdated = evaluated.filter((pkg) => pkg.outdated)
    const honoredPins = outdated.filter((pkg) => pkg.status === Hold.ColdBrewPinned)
    const eligible = outdated.filter((pkg) => pkg.status !== Hold.ColdBrewPinned)
    if (honoredPins.length > 0) {
      const names = honoredPins.map((pkg) => pkg.name).join(", ")
      const noun = plural(honoredPins.length, "pin")
      console.log(dim(`Honoring ${honoredPins.length} ${noun} despite --force: ${names}`))
    }
    if (eligible.length === 0) {
      if (outdated.length > 0) {
        console.log("Nothing to upgrade — all outdated packages are pinned.")
      } else if (untrusted.length === 0) {
        // Suppressed when untrusted packages were skipped above — the skip
        // section already explains why there's nothing left to do.
        console.log("Already up-to-date.")
      }
      return 0
    }
    const forcedResult = await brewUpgrade(
      eligible.map((package_) => ({
        name: package_.name,
        isCask: package_.isCask,
        tap: package_.tap,
        originalTap: getOriginalTap(package_.name),
        installedVersion: package_.installedVersion,
        needsRelink: package_.needsRelink,
      })),
    )
    const succeeded = new Set([...forcedResult.formulaeSucceeded, ...forcedResult.casksSucceeded])
    for (const pkg of eligible) {
      if (!succeeded.has(pkg.name)) continue
      logUpgrade(pkg.name, pkg.installedVersion, pkg.latestVersion ?? pkg.installedVersion, pkg.sourceAgeDays)
    }
    reportFailures(eligible, succeeded)
    return forcedResult.exitCode
  }

  const { upgrade, held } = partitionUpgrade(evaluated)

  const securityBypass = upgrade.filter((pkg) => pkg.bypassReason !== null)
  if (securityBypass.length > 0) {
    console.log(
      `\n${Color.bypass}${bold(`Bypassed ${plural(securityBypass.length, "package")} for security fixes:`)}${Ansi.RESET}`,
    )
    const rows: Row[] = securityBypass.map((pkg) => {
      const top = pkg.advisories?.entries[0]
      const badge = top
        ? `${top.id}${top.cvss != null ? ` CVSS ${top.cvss.toFixed(1)}` : ""}`
        : formatBypass(pkg.bypassReason)
      return { name: pkg.name, arrow: arrowText(pkg), badge }
    })
    renderRows(rows, Color.bypass)
  }

  let intermediate: Awaited<ReturnType<typeof resolveIntermediateUpgrades>>["intermediate"] = []
  let stillHeld = held
  // Cold-brew-tap packages that already cleared their post-step hold window
  // land in `upgrade` (Hold.Ready). Feed them back through stepping so we
  // keep walking the intermediate ladder instead of jumping to latest.
  const midSteppingReady = upgrade.filter((pkg) => pkg.tap === "cold-brew/cold-brew")
  const stepCandidates = [...held, ...midSteppingReady]
  let remainingUpgrade = upgrade
  if (stepCandidates.length > 0) {
    statusUpdate("resolving intermediate upgrades...")
    const resolution = await resolveIntermediateUpgrades(stepCandidates, holdDays)
    statusClear()
    intermediate = resolution.intermediate
    const steppedNames = new Set(intermediate.map((step) => step.pkg.name))
    stillHeld = resolution.stillHeld.filter((pkg) => pkg.status === Hold.Held)
    remainingUpgrade = upgrade.filter((pkg) => !steppedNames.has(pkg.name))
  }

  if (stillHeld.length > 0) {
    console.log(
      `\n${Color.held}${bold(`Holding back ${stillHeld.length} ${plural(stillHeld.length, "package")}:`)}${Ansi.RESET}`,
    )
    renderRows(
      stillHeld.map((pkg) => ({
        name: pkg.name,
        arrow: arrowText(pkg),
        badge: formatHoldReason(pkg),
      })),
      Color.held,
    )
  }

  if (intermediate.length > 0) {
    console.log(
      `\n${Color.stepping}${bold(`Stepping ${intermediate.length} ${plural(intermediate.length, "package")} to intermediate ${plural(intermediate.length, "version")}:`)}${Ansi.RESET}`,
    )
    renderRows(
      intermediate.map((step) => ({
        name: step.pkg.name,
        arrow: `${step.pkg.installedVersion} → ${step.version} (latest ${step.pkg.latestVersion ?? "?"})`,
        badge: `${step.ageDays}d old`,
      })),
      Color.stepping,
    )
    console.log()

    for (const step of intermediate) {
      const exitCode = await brewInstallVersion(
        step.pkg.name,
        step.version,
        step.commitHash,
        step.pkg.isCask,
        step.effectiveTap,
      )
      if (exitCode !== 0) {
        console.error(
          `${Ansi.YELLOW}Failed to install ${step.pkg.name} ${step.version} (exit ${exitCode}). Aborting remaining steps.${Ansi.RESET}`,
        )
        return exitCode
      }
      logUpgrade(step.pkg.name, step.pkg.installedVersion, step.version, step.ageDays)
    }
  }

  if (remainingUpgrade.length > 0) {
    console.log(
      `\n${Color.ready}${bold(`Upgrading ${remainingUpgrade.length} ${plural(remainingUpgrade.length, "package")}:`)}${Ansi.RESET}`,
    )
    renderRows(
      remainingUpgrade.map((pkg) => ({
        name: pkg.name,
        arrow: arrowText(pkg),
        badge: formatHoldReason(pkg),
      })),
      Color.ready,
    )
    console.log()

    const result = await brewUpgrade(
      remainingUpgrade.map((package_) => ({
        name: package_.name,
        isCask: package_.isCask,
        tap: package_.tap,
        originalTap: getOriginalTap(package_.name),
        installedVersion: package_.installedVersion,
        needsRelink: package_.needsRelink,
      })),
    )

    const succeeded = new Set([...result.formulaeSucceeded, ...result.casksSucceeded])
    for (const pkg of remainingUpgrade) {
      if (!succeeded.has(pkg.name)) continue
      logUpgrade(pkg.name, pkg.installedVersion, pkg.latestVersion ?? pkg.installedVersion, pkg.sourceAgeDays)
    }
    reportFailures(remainingUpgrade, succeeded)

    return result.exitCode
  }

  if (intermediate.length > 0) {
    return 0
  }

  if (stillHeld.length > 0) {
    console.log(`\n${dim(`${stillHeld.length} ${plural(stillHeld.length, "package")} held.`)}`)
  } else if (untrusted.length === 0) {
    // Suppressed when untrusted packages were skipped above — the skip section
    // already explains why there's nothing left to upgrade.
    console.log("\nAlready up-to-date.")
  }

  return 0
}
