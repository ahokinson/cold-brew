import { icon, Icon as PressIcon, placeholder } from "@ahokinson/press/icons"

export { placeholder }

// Domain glyphs that don't belong in press: status states, brew-specific kinds.
// Generic glyphs (chevrons, search, alert, gear, check, etc.) come from press.
const domain = {
  ready: icon("\u{F0AA}", 2), // nf-fa-arrow_circle_up
  held: icon("\u{F252}", 2), // nf-fa-hourglass_half
  pinned: icon("\u{F023}", 2), // nf-fa-lock (brew-pinned / always-hold)
  bolt: icon("\u{F0E7}", 2), // nf-fa-bolt (always-allow)
  versionPinned: icon("\u{F2DC}", 2), // nf-fa-snowflake_o
  cask: icon("\u{F0074}", 2), // nf-md-barrel
  formula: icon("\u{F0FC}", 2), // nf-fa-beer
  package: icon("\u{F487}", 2), // nf-oct-package
  tap: icon("\u{EA68}", 2), // nf-cod-source_control
  untrusted: icon("\u{F09C}", 2), // nf-fa-unlock (tap not yet trusted)
  ghost: icon("\u{F02A0}", 2), // nf-md-ghost (trusted pkg shadowed by untrusted tap)
  bug: icon("\u{F188}", 2), // nf-fa-bug (security advisory / vulnerability)
} as const

export const Icon = { ...PressIcon, ...domain } as const
