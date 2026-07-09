import { formatBypass } from "@brew/format"
import { type Advisory, Hold, type Package } from "@brew/types"
import { Ansi, dim } from "@cli/ansi"
import { preparePackages } from "@cli/prepare"

const SEVERITY_ORDER: Advisory.Severity[] = ["critical", "high", "medium", "low", "unknown"]

function severityColor(severity: Advisory.Severity): string {
  switch (severity) {
    case "critical":
      return Ansi.RED
    case "high":
      return Ansi.MAGENTA
    case "medium":
      return Ansi.YELLOW
    case "low":
    case "unknown":
      return Ansi.DIM
  }
}

function heldish(pkg: Package.WithStatus): boolean {
  return pkg.status === Hold.Held || pkg.status === Hold.AlwaysHold
}

interface AuditRow {
  pkg: Package.WithStatus
  entry: Advisory.Entry
}

export async function handleAudit(args: string[]): Promise<number> {
  const jsonOutput = args.includes("--json")

  const { packages: evaluated, bypassThreshold, bypassKev, bypassEpss } = await preparePackages()

  const vulnRows: AuditRow[] = []
  const typosquatRows: AuditRow[] = []
  for (const pkg of evaluated) {
    const entries = pkg.advisories?.entries ?? []
    for (const entry of entries) {
      if (entry.kind === "vulnerability") vulnRows.push({ pkg, entry })
      else typosquatRows.push({ pkg, entry })
    }
  }

  if (jsonOutput) {
    const payload = [...vulnRows, ...typosquatRows].map(({ pkg, entry }) => ({
      name: pkg.name,
      installedVersion: pkg.installedVersion,
      latestVersion: pkg.latestVersion,
      status: pkg.status,
      bypassReason: pkg.bypassReason,
      advisory: entry,
    }))
    console.log(JSON.stringify(payload, null, 2))
    return 0
  }

  if (vulnRows.length === 0 && typosquatRows.length === 0) {
    console.log("No advisories found for installed packages.")
    return 0
  }

  const epssTag = bypassEpss === null ? "disabled" : `≥ ${bypassEpss.toFixed(2)}`
  console.log(
    dim(
      `Auto-bypass: CVSS ≥ ${bypassThreshold.toFixed(1)}, KEV ${bypassKev ? "enabled" : "disabled"}, EPSS ${epssTag}`,
    ),
  )

  if (vulnRows.length > 0) {
    const counts: Record<Advisory.Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
    let bypassed = 0
    let held = 0
    for (const row of vulnRows) {
      counts[row.entry.severity]++
      if (row.pkg.bypassReason !== null) bypassed++
      else if (heldish(row.pkg)) held++
    }
    const tally = SEVERITY_ORDER.filter((severity) => counts[severity] > 0)
      .map((severity) => `${counts[severity]} ${severity}`)
      .join(", ")
    const actioned = [bypassed > 0 ? `${bypassed} bypassed` : null, held > 0 ? `${held} held` : null]
      .filter(Boolean)
      .join(", ")
    const summary = actioned ? `${tally}  |  ${actioned}` : tally
    console.log(dim(summary))
  }

  if (vulnRows.length > 0) {
    const grouped = new Map<Advisory.Severity, AuditRow[]>()
    for (const row of vulnRows) {
      const list = grouped.get(row.entry.severity) ?? []
      list.push(row)
      grouped.set(row.entry.severity, list)
    }
    for (const severity of SEVERITY_ORDER) {
      const list = grouped.get(severity)
      if (!list || list.length === 0) continue
      const color = severityColor(severity)
      console.log(`\n${color}${Ansi.BOLD}${severity.toUpperCase()}${Ansi.RESET} ${dim(`(${list.length})`)}`)
      list.sort((a, b) => (b.entry.cvss ?? 0) - (a.entry.cvss ?? 0))
      for (const { pkg, entry } of list) {
        const cvss = entry.cvss != null ? ` CVSS ${entry.cvss.toFixed(1)}` : ""
        const epss = entry.epss != null ? ` ${dim(`EPSS ${entry.epss.toFixed(2)}`)}` : ""
        const fix = entry.fixedIn ? ` ${dim(`fix: ${entry.fixedIn}`)}` : ""
        const kev = entry.kev ? ` ${Ansi.RED}[KEV]${Ansi.RESET}` : ""
        const bypassTag = formatBypass(pkg.bypassReason)
        const bypass = bypassTag
          ? ` ${Ansi.YELLOW}[${bypassTag}]${Ansi.RESET}`
          : heldish(pkg)
            ? ` ${dim("[held]")}`
            : ""
        console.log(
          `  ${color}${entry.id}${Ansi.RESET}${cvss}${epss}${kev}  ${pkg.name} ${dim(`${pkg.installedVersion} → ${pkg.latestVersion ?? "?"}`)}${fix}${bypass}`,
        )
        if (entry.summary) {
          console.log(`    ${dim(entry.summary.slice(0, 120))}`)
        }
      }
    }
  }

  if (typosquatRows.length > 0) {
    console.log(`\n${Ansi.YELLOW}${Ansi.BOLD}TYPOSQUATS${Ansi.RESET} ${dim(`(${typosquatRows.length})`)}`)
    console.log(
      dim(
        "Malicious packages sharing a formula name in other ecosystems. Not a direct threat to installed versions — awareness only.",
      ),
    )
    const grouped = new Map<string, AuditRow[]>()
    for (const row of typosquatRows) {
      const list = grouped.get(row.pkg.name) ?? []
      list.push(row)
      grouped.set(row.pkg.name, list)
    }
    for (const [name, rows] of grouped) {
      console.log(`  ${Ansi.BOLD}${name}${Ansi.RESET}`)
      for (const { entry } of rows) {
        console.log(`    ${dim(entry.id)}  ${entry.summary.slice(0, 120)}`)
      }
    }
  }

  const provenanceRows = evaluated.filter((pkg) => (pkg.provenance?.flags?.length ?? 0) > 0)
  if (provenanceRows.length > 0) {
    const totalFlags = provenanceRows.reduce((sum, pkg) => sum + (pkg.provenance?.flags.length ?? 0), 0)
    console.log(`\n${Ansi.YELLOW}${Ansi.BOLD}PROVENANCE FLAGS${Ansi.RESET} ${dim(`(${totalFlags})`)}`)
    console.log(
      dim(
        "Formula-source signals raised during the hold window. Informational — legitimate maintainer changes can trip these too.",
      ),
    )
    for (const pkg of provenanceRows) {
      console.log(`  ${Ansi.BOLD}${pkg.name}${Ansi.RESET}`)
      for (const flag of pkg.provenance!.flags) {
        console.log(`    ${Ansi.YELLOW}${flag.kind}${Ansi.RESET}  ${flag.detail}`)
        console.log(`      ${dim(flag.commitUrl)}`)
      }
    }
  }

  return 0
}
