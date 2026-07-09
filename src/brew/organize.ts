// Condenses noisy `brew` output into organized summaries. Where the per-command
// streaming filters in cycle.ts could only keep/drop lines as they flew past,
// this buffers a command's whole output, parses it into header-delimited blocks,
// and lets a per-command classifier route each block to one of four fates:
// drop (known noise), condense (a tidy summary line), keep (recognized and
// actionable — emit verbatim inline), or defer (UNRECOGNIZED — emit verbatim in
// a trailer at the very end). The default for anything a classifier doesn't
// claim is `defer`, so brew output is never silently swallowed.

import { isBrewNoiseLine, isTrustWarningHeader, stripAnsi } from "@brew/quiet"
import { Ansi, dim, plural } from "@cli/ansi"

export interface Block {
  // First line, ANSI-stripped and right-trimmed — the classification key.
  header: string
  // All lines, ANSI-stripped (for matching).
  lines: string[]
  // All lines, original (for verbatim emit so brew's own coloring survives).
  rawLines: string[]
}

export type Verdict = { kind: "drop" } | { kind: "condense"; summary: string[] } | { kind: "keep" } | { kind: "defer" }

export interface OrganizeContext {
  isManaged: (name: string) => boolean
  onColdBrewTapWarning?: () => void
  // Free-form scratch a classifier accumulates across blocks (counters parsed
  // for a finalize() rollup, etc.).
  state: Record<string, unknown>
}

export interface Classifier {
  classify: (block: Block, ctx: OrganizeContext) => Verdict
  // Emitted after all blocks — a place for a rolled-up summary built from
  // counters accumulated during classify (e.g. "cleaned 12 files, freed 1.2GB").
  finalize?: (ctx: OrganizeContext) => string[]
}

export interface OrganizeResult {
  // Ordered lines to print up front: condense summaries, kept blocks, finalize.
  condensed: string[]
  // Verbatim unrecognized blocks for the trailing "other brew output:" section.
  deferred: string[]
  // How many blocks were `keep` (recognized actionable). Distinct from condense
  // summaries (which can be benign-positive like "cleaned N files") so callers
  // can tell whether anything actionable actually surfaced.
  keptCount: number
}

// A new block opens at a header line; everything until the next header (or EOF)
// belongs to it. Splitting on headers — not blank lines — is deliberate: brew's
// `Warning:` blocks contain internal blank lines and indented items.
const BLOCK_HEADER = /^(==>|Warning:|Error:|fatal:|Please note)/

export function splitBlocks(raw: string): Block[] {
  const rawLines = raw.split("\n")
  // Drop the single empty element a trailing newline produces.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop()

  const blocks: Block[] = []
  let current: Block | null = null

  for (const rawLine of rawLines) {
    const line = stripAnsi(rawLine)
    // A header opens a new block; leading lines before any header (e.g. "Your
    // system is ready to brew.") form a preamble block the classifier judges.
    if (BLOCK_HEADER.test(line.trimEnd()) || current === null) {
      if (current) blocks.push(current)
      current = { header: line.trimEnd(), lines: [line], rawLines: [rawLine] }
    } else {
      current.lines.push(line)
      current.rawLines.push(rawLine)
    }
  }
  if (current) blocks.push(current)
  return blocks
}

export function organize(raw: string, classifier: Classifier, ctx: OrganizeContext): OrganizeResult {
  const condensed: string[] = []
  const deferred: string[] = []
  let keptCount = 0

  for (const block of splitBlocks(raw)) {
    const verdict = classifier.classify(block, ctx)
    switch (verdict.kind) {
      case "drop":
        break
      case "condense":
        condensed.push(...verdict.summary)
        break
      case "keep":
        condensed.push(...block.rawLines)
        keptCount++
        break
      case "defer":
        deferred.push(...block.rawLines)
        break
    }
  }

  if (classifier.finalize) condensed.push(...classifier.finalize(ctx))
  return { condensed, deferred, keptCount }
}

export function printOrganized(result: OrganizeResult): void {
  for (const line of result.condensed) process.stdout.write(`${line}\n`)
  if (result.deferred.length > 0) {
    process.stdout.write(`${Ansi.DIM}other brew output:${Ansi.RESET}\n`)
    for (const line of result.deferred) process.stdout.write(`${line}\n`)
  }
}

// The cycle should flag a step as "reported issues" only when cold-brew actually
// surfaced something actionable — a deferred (unrecognized) block or a kept
// warning — not merely because brew exited non-zero on warnings we recognized
// and dropped. `exit` stays brew's real code so callers keep scripting truth.
export function decideExit(brewExit: number, result: OrganizeResult): { exitCode: number; surfaced: boolean } {
  return { exitCode: brewExit, surfaced: result.deferred.length > 0 || result.keptCount > 0 }
}

// ---------------------------------------------------------------------------
// Live progress sniffer — maps a brew progress marker to a short status label
// for the rewriting status line shown during long `brew upgrade`/`reinstall`
// runs (the output is buffered for organize, so this is the only live signal).
// ---------------------------------------------------------------------------

const PROGRESS_PATTERNS: readonly { re: RegExp; label: (match: RegExpMatchArray) => string }[] = [
  { re: /^==> Upgrading (\S+)/, label: (m) => `upgrading ${m[1]}` },
  { re: /^==> Reinstalling (\S+)/, label: (m) => `reinstalling ${m[1]}` },
  { re: /^==> Pouring (\S+)/, label: (m) => `pouring ${m[1]}` },
  { re: /^==> Installing (\S+)/, label: (m) => `installing ${m[1]}` },
  { re: /^==> Fetching (\S+)/, label: (m) => `fetching ${m[1]}` },
  { re: /^==> Downloading\b/, label: () => "downloading…" },
]

export function progressLabel(strippedLine: string): string | null {
  const line = strippedLine.trimEnd()
  for (const { re, label } of PROGRESS_PATTERNS) {
    const match = line.match(re)
    if (match) return label(match)
  }
  return null
}

// ---------------------------------------------------------------------------
// Shared block helpers
// ---------------------------------------------------------------------------

// Multi-line brew warnings whose listed kegs are routinely cold-brew's own
// doing (stepping writes a formula into the cold-brew tap then unlinks it; an
// interrupted step leaves an unlinked keg). Emitted by `brew doctor`, the first
// also by `brew cleanup`.
const COLD_BREW_KEG_HEADERS: readonly string[] = [
  "Warning: Some installed kegs have no formulae!",
  "Warning: You have unlinked kegs in your Cellar.",
]

function isColdBrewKegHeader(header: string): boolean {
  return COLD_BREW_KEG_HEADERS.some((h) => header.startsWith(h))
}

// Indented bare-token lines list the affected kegs (one name per line).
function listedNames(lines: readonly string[]): string[] {
  const names: string[] = []
  for (const line of lines) {
    const match = line.match(/^\s+(\S+)\s*$/)
    if (match?.[1]) names.push(match[1])
  }
  return names
}

// A cold-brew managed-keg block: dropped if every listed keg is cold-brew's own
// (recorded origin tap), else kept verbatim so real orphans/unlinked kegs show.
function classifyKegBlock(block: Block, ctx: OrganizeContext): Verdict {
  const listed = listedNames(block.lines)
  if (listed.length > 0 && listed.every(ctx.isManaged)) return { kind: "drop" }
  return { kind: "keep" }
}

// ---------------------------------------------------------------------------
// Per-command classifiers
// ---------------------------------------------------------------------------

const UPDATE_REPORT_HEADER = /^==> (New|Outdated|Modified|Deleted) (Formulae|Casks)$/
const UPDATE_NOISE_PATTERNS: readonly RegExp[] = [
  /^==> Updating Homebrew\b/,
  /^==> Updated Homebrew from [0-9a-f]+ to [0-9a-f]+\.?$/,
  /^Updated \d+ taps? \(.+\)\.$/,
  /^Already up-to-date\.$/,
  /^You have \d+ outdated formulae? installed\.$/,
  /^You can upgrade (them|it) with brew upgrade$/,
  /^or list (them|it) with brew outdated\.$/,
]

function isUpdateNoise(line: string): boolean {
  const trimmed = line.trimEnd()
  if (trimmed === "") return true
  if (isBrewNoiseLine(line)) return true
  // cold-brew/cold-brew is a local tap with no remote; its fetch always warns.
  if (line.includes("No remote") && line.includes("cold-brew")) return true
  return UPDATE_NOISE_PATTERNS.some((p) => p.test(trimmed))
}

// `brew update` inside the cycle is intentionally silent — the next step
// (upgrade) acts on the outdated list. Drop the report and all recognized
// noise; defer only genuine errors so a broken update is never hidden.
export function createUpdateClassifier(): Classifier {
  return {
    classify(block) {
      if (UPDATE_REPORT_HEADER.test(block.header)) return { kind: "drop" }
      if (block.lines.every(isUpdateNoise)) return { kind: "drop" }
      return { kind: "defer" }
    },
  }
}

// brew cleanup warns it's skipping old-version cleanup for every package whose
// installed version isn't the latest — which, for cold-brew, is every held
// package by design. Expected and repeated per package, so drop it.
const CLEANUP_SKIP = /^Warning: Skipping .+: most recent version .+ not installed/

// `brew cleanup`: drop the per-file removal chatter, the held-version skip
// warnings, and cold-brew managed-keg blocks; roll the volume up into one
// "cleaned N files, freed X" line; defer any warning cleanup didn't expect.
export function createCleanupClassifier(): Classifier {
  return {
    classify(block, ctx) {
      const freed = block.header.match(/freed approximately (.+?) of disk space/)
      if (freed) {
        ctx.state.freed = freed[1]
        return { kind: "drop" }
      }
      if (CLEANUP_SKIP.test(block.header)) return { kind: "drop" }
      if (isColdBrewKegHeader(block.header)) return classifyKegBlock(block, ctx)

      const removing = block.lines.filter((l) => l.startsWith("Removing:")).length
      if (removing > 0) ctx.state.removed = ((ctx.state.removed as number) ?? 0) + removing

      if (block.lines.every((l) => isCleanupNoise(l))) return { kind: "drop" }
      return { kind: "defer" }
    },
    finalize(ctx) {
      const removed = (ctx.state.removed as number) ?? 0
      const freed = ctx.state.freed as string | undefined
      if (removed === 0 && !freed) return []
      const parts: string[] = []
      if (removed > 0) parts.push(`cleaned ${removed} ${plural(removed, "file")}`)
      if (freed) parts.push(`freed ${freed}`)
      return [dim(parts.join(", "))]
    },
  }
}

function isCleanupNoise(line: string): boolean {
  const trimmed = line.trimEnd()
  if (trimmed === "") return true
  if (line.startsWith("Removing:")) return true
  if (line.startsWith("Pruned ")) return true
  return isBrewNoiseLine(line)
}

const DOCTOR_PREAMBLE = /^Please note that these warnings are just used to help/
const DOCTOR_BRANCH_WARNING = /^Warning: Some taps are not on the default git origin branch/
const DOCTOR_READY = /^Your system is ready to brew\b/
const DOCTOR_MISSING_DEPS = /^Warning: Some installed formulae or casks are missing dependencies/

// `brew doctor`: drop the maintainer preamble, the untrusted-taps block (the TUI
// surfaces trust state), the default-branch warning for cold-brew's local tap,
// and managed-keg blocks. Keep recognized-actionable warnings (missing deps,
// real orphan/unlinked kegs). Anything else is deferred to the trailer.
export function createDoctorClassifier(): Classifier {
  return {
    classify(block, ctx) {
      // cold-brew/cold-brew is a local tap with no remote — its git suggestions
      // are expected. Note it (for the cycle's explanatory trailer) wherever it
      // appears, regardless of how the surrounding block is classified.
      const hasColdBrewGit = block.lines.some(
        (l) => l.trimStart().startsWith("git -C") && l.includes("cold-brew/cold-brew"),
      )
      if (hasColdBrewGit) ctx.onColdBrewTapWarning?.()

      if (DOCTOR_PREAMBLE.test(block.header)) return { kind: "drop" }
      if (DOCTOR_READY.test(block.header)) return { kind: "drop" }
      if (isTrustWarningHeader(block.header)) return { kind: "drop" }

      if (DOCTOR_BRANCH_WARNING.test(block.header)) {
        const gitLines = block.lines.filter((l) => l.trimStart().startsWith("git -C"))
        const allColdBrew = gitLines.length > 0 && gitLines.every((l) => l.includes("cold-brew/cold-brew"))
        // Header-only (git lines already cold-brew) or all cold-brew → expected.
        // A foreign tap on a non-default branch is real — keep it.
        return gitLines.length === 0 || allColdBrew ? { kind: "drop" } : { kind: "keep" }
      }

      if (isColdBrewKegHeader(block.header)) return classifyKegBlock(block, ctx)
      if (DOCTOR_MISSING_DEPS.test(block.header)) return { kind: "keep" }

      if (block.lines.every((l) => l.trimEnd() === "" || isBrewNoiseLine(l))) return { kind: "drop" }
      return { kind: "defer" }
    },
  }
}

// `brew upgrade`/`reinstall`: cold-brew already printed the plan and computes the
// per-package outcome itself, so brew's streamed progress is pure noise — drop
// it all (and the trust block). Surface only what cold-brew can't account for:
// caveats and genuine errors/unexpected warnings, deferred to the trailer.
export function createUpgradeClassifier(): Classifier {
  return {
    classify(block) {
      if (isTrustWarningHeader(block.header)) return { kind: "drop" }
      if (block.header.startsWith("==> Caveats")) return { kind: "defer" }
      if (/^(Error:|fatal:)/.test(block.header)) return { kind: "defer" }
      if (block.header.startsWith("==>")) return { kind: "drop" }
      if (block.header.startsWith("🍺")) return { kind: "drop" }
      if (block.lines.every((l) => l.trimEnd() === "" || isBrewNoiseLine(l))) return { kind: "drop" }
      return { kind: "defer" }
    },
  }
}
