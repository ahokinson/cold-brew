import { brewVersionHistory } from "@brew/api"
import { isVersionAhead, parseVersion } from "@brew/policy"
import { Hold, type Package } from "@brew/types"
import { getOriginalTap, setOriginalTap } from "@db"

const MILLISECONDS_PER_DAY = 86_400_000

export interface IntermediateStep {
  pkg: Package.WithStatus
  version: string
  commitHash: string
  ageDays: number
  // Tap to use for fetching source / version history. Differs from pkg.tap
  // when the package is currently installed from cold-brew/cold-brew (i.e. the
  // result of an earlier step) — in that case we resolve back to the original
  // tap so we can keep walking the upstream history.
  effectiveTap: string
}

export interface IntermediateResolution {
  intermediate: IntermediateStep[]
  stillHeld: Package.WithStatus[]
}

function compareVersions(a: string, b: string): number {
  const aParts = parseVersion(a)
  const bParts = parseVersion(b)
  const length = Math.max(aParts.length, bParts.length)
  for (let i = 0; i < length; i++) {
    const av = aParts[i] ?? 0
    const bv = bParts[i] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

function pickEligible(
  pkg: Package.WithStatus,
  history: Package.VersionHistory[],
  holdDays: number,
  now: number,
): Omit<IntermediateStep, "effectiveTap"> | null {
  const latest = pkg.latestVersion
  if (!latest) return null
  const holdMilliseconds = holdDays * MILLISECONDS_PER_DAY
  let best: { entry: Package.VersionHistory; ageDays: number } | null = null

  for (const entry of history) {
    if (!isVersionAhead(entry.version, pkg.installedVersion)) continue
    if (isVersionAhead(entry.version, latest)) continue
    if (entry.version === latest) continue

    const commitTime = Date.parse(entry.commitDate)
    if (!Number.isFinite(commitTime)) continue
    const age = now - commitTime
    if (age < holdMilliseconds) continue

    if (!best || compareVersions(entry.version, best.entry.version) > 0) {
      best = { entry, ageDays: Math.floor(age / MILLISECONDS_PER_DAY) }
    }
  }

  if (!best) return null
  return {
    pkg,
    version: best.entry.version,
    commitHash: best.entry.commitHash,
    ageDays: best.ageDays,
  }
}

export async function resolveIntermediateUpgrades(
  held: Package.WithStatus[],
  holdDays: number,
  now: number = Date.now(),
): Promise<IntermediateResolution> {
  const intermediate: IntermediateStep[] = []
  const stillHeld: Package.WithStatus[] = []

  for (const pkg of held) {
    // Mid-stepping packages flip to Hold.Ready once the post-step window
    // elapses, but we want to keep climbing intermediates before allowing
    // a direct jump to latest.
    const isMidStepping = pkg.tap === "cold-brew/cold-brew"
    if (pkg.status !== Hold.Held && !isMidStepping) {
      stillHeld.push(pkg)
      continue
    }
    // Packages on cold-brew/cold-brew need their original tap to keep
    // walking upstream history; when the mapping is missing, fall back to
    // homebrew/{core,cask} and persist whatever resolves so we self-heal.
    const recordedOriginal = pkg.tap === "cold-brew/cold-brew" ? getOriginalTap(pkg.name) : null
    const fallbackOriginal = pkg.isCask ? "homebrew/cask" : "homebrew/core"
    const effectiveTap = pkg.tap === "cold-brew/cold-brew" ? (recordedOriginal ?? fallbackOriginal) : pkg.tap
    if (!pkg.latestVersion || !effectiveTap || effectiveTap === "unknown" || effectiveTap === "cold-brew/cold-brew") {
      stillHeld.push(pkg)
      continue
    }
    if (pkg.tap === "cold-brew/cold-brew" && !recordedOriginal) {
      setOriginalTap(pkg.name, effectiveTap)
    }

    let history: Package.VersionHistory[] = []
    try {
      history = await brewVersionHistory(pkg.name, pkg.isCask, effectiveTap)
    } catch {
      stillHeld.push(pkg)
      continue
    }

    const step = pickEligible(pkg, history, holdDays, now)
    if (step) {
      intermediate.push({ ...step, effectiveTap })
    } else {
      stillHeld.push(pkg)
    }
  }

  return { intermediate, stillHeld }
}
