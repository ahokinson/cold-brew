import type { KeySpec } from "@ahokinson/press/keyboard"

// Build a key-match spec from a binding name. OpenTUI reports an uppercase
// letter as its lowercase `name` plus `shift: true`, so "G" must match on
// shift, and a lowercase letter must set shift:false or a shifted press falls
// through to it. Non-letters ("/", ",", "?") stay shift-agnostic (they arrive
// with shift on many layouts).
export function matchFor(name: string): KeySpec {
  if (name.length === 1 && name >= "A" && name <= "Z") return { name: name.toLowerCase(), shift: true }
  if (name.length === 1 && name >= "a" && name <= "z") return { name, shift: false }
  return { name }
}
