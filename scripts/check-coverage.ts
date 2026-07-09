// Enforces a minimum coverage threshold by parsing coverage/lcov.info.
// Run after `bun test` (which writes lcov.info via bunfig.toml's
// coverageReporter setting). Exits non-zero when total line or function
// coverage falls below the threshold.
//
// bun's native coverageThreshold key in bunfig.toml is not honored in 1.3.x,
// so this script bridges the gap.

const THRESHOLD = 0.95

interface Totals {
  linesFound: number
  linesHit: number
  funcsFound: number
  funcsHit: number
}

function parseLcov(text: string): Totals {
  const t: Totals = { linesFound: 0, linesHit: 0, funcsFound: 0, funcsHit: 0 }
  for (const line of text.split("\n")) {
    if (line.startsWith("LF:")) t.linesFound += Number(line.slice(3))
    else if (line.startsWith("LH:")) t.linesHit += Number(line.slice(3))
    else if (line.startsWith("FNF:")) t.funcsFound += Number(line.slice(4))
    else if (line.startsWith("FNH:")) t.funcsHit += Number(line.slice(4))
  }
  return t
}

function pct(hit: number, found: number): number {
  return found === 0 ? 1 : hit / found
}

const lcovPath = "coverage/lcov.info"
const file = Bun.file(lcovPath)
if (!(await file.exists())) {
  console.error(`check-coverage: ${lcovPath} not found — did 'bun test' run with coverage enabled?`)
  process.exit(2)
}

const totals = parseLcov(await file.text())
const lineCov = pct(totals.linesHit, totals.linesFound)
const funcCov = pct(totals.funcsHit, totals.funcsFound)

const fmt = (n: number) => (n * 100).toFixed(2) + "%"
const minPct = fmt(THRESHOLD)

console.log(`coverage: lines ${fmt(lineCov)} (${totals.linesHit}/${totals.linesFound}), functions ${fmt(funcCov)} (${totals.funcsHit}/${totals.funcsFound}) — threshold ${minPct}`)

const failures: string[] = []
if (lineCov < THRESHOLD) failures.push(`line coverage ${fmt(lineCov)} below ${minPct}`)
if (funcCov < THRESHOLD) failures.push(`function coverage ${fmt(funcCov)} below ${minPct}`)

if (failures.length > 0) {
  for (const f of failures) console.error(`check-coverage: ${f}`)
  process.exit(1)
}
