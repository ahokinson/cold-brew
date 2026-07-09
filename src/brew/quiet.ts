// Filters chatter lines out of brew's stdout/stderr. Predicate-only — the
// caller decides what to do with a matched line (typically: drop it).

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC (\x1b) that opens every ANSI CSI sequence is the whole point here.
const ANSI_CSI = /\x1b\[[0-9;]*[A-Za-z]/g

export function stripAnsi(line: string): string {
  return line.replace(ANSI_CSI, "")
}

const NOISE_PATTERNS: readonly RegExp[] = [
  /^==> Fetching( dependencies for| downloads for:)?\b/,
  /^==> Downloading( from)? https?:\/\//,
  /^Already downloaded: /,
  /^==> Summary$/,
  /^🍺 /,
  /^==> Running [`'"]brew cleanup/,
  /^Disable this behaviour by setting HOMEBREW_NO_INSTALL_CLEANUP\.$/,
  /^==> Pruned \d+ symbolic links/,
  /^==> (Backing up Cask|Removing Cask|Linking Binary|Purging files) /,
  /^==> Caskroom is /,
]

export function isBrewNoiseLine(line: string): boolean {
  const stripped = stripAnsi(line).trimStart()
  if (stripped === "") return false
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(stripped)) return true
  }
  return false
}

// Under HOMEBREW_REQUIRE_TAP_TRUST, brew prefixes type-scoped commands
// (`brew upgrade --formula`/`--cask`) with a ~18-line block listing every
// untrusted tap on the system and prescribing `brew trust`/`brew untap`. It
// fires on every run regardless of which packages are being touched, and
// prescriptive remediation isn't cold-brew's voice (the TUI surfaces trust
// state and offers the action). This returns a stateful line predicate that
// drops that block whole and otherwise defers to isBrewNoiseLine.
const TRUST_BLOCK_START = /^Warning: The following taps are not trusted:/
const TRUST_BLOCK_END = /will be removed in a later release\.?$/

// True when a line opens brew's untrusted-taps block. Shared by the streaming
// filter below and the block-organizer's doctor/upgrade classifiers, which key
// off the block header rather than tracking the block line by line.
export function isTrustWarningHeader(line: string): boolean {
  return TRUST_BLOCK_START.test(stripAnsi(line).trimEnd())
}

export function createTrustWarningFilter(): (line: string) => boolean {
  let inBlock = false
  return (line: string): boolean => {
    const stripped = stripAnsi(line).trimEnd()
    if (inBlock) {
      // The block's final line — drop it and close the block.
      if (TRUST_BLOCK_END.test(stripped)) {
        inBlock = false
        return false
      }
      // Defensive re-sync: if brew moved on to real progress without the
      // expected terminator (wording drift), stop swallowing and judge the
      // line normally rather than eating the rest of the output.
      if (stripped.startsWith("==>")) {
        inBlock = false
      } else {
        return false
      }
    }
    if (TRUST_BLOCK_START.test(stripped)) {
      inBlock = true
      return false
    }
    return !isBrewNoiseLine(line)
  }
}
