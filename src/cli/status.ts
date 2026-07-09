import { formatHoldReason } from "@brew/policy"
import { Status } from "@brew/status"
import { Ansi, Color, dim } from "@cli/ansi"
import { preparePackages } from "@cli/prepare"

export async function handleStatus(): Promise<number> {
  const { packages } = await preparePackages()
  const outdated = packages.filter((pkg) => pkg.outdated)

  if (outdated.length === 0) {
    console.log("All packages are up-to-date.")
    return 0
  }

  const sorted = outdated.sort((a, b) => {
    const readyA = Status.isReady(a) ? 0 : 1
    const readyB = Status.isReady(b) ? 0 : 1
    if (readyA !== readyB) return readyA - readyB
    return a.name.localeCompare(b.name)
  })

  const arrows = sorted.map((pkg) => `${pkg.installedVersion} → ${pkg.latestVersion ?? "?"}`)
  const maxName = Math.max(...sorted.map((pkg) => pkg.name.length))
  const maxArrow = Math.max(...arrows.map((arrow) => arrow.length))

  for (const [index, pkg] of sorted.entries()) {
    const name = pkg.name.padEnd(maxName)
    const arrow = arrows[index]!.padEnd(maxArrow)
    const reason = formatHoldReason(pkg)
    const color = Status.isReady(pkg) ? Color.ready : Color.held
    console.log(`  ${name}  ${dim(arrow)}  ${color}${reason}${Ansi.RESET}`)
  }
  return 0
}
