import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { isOfficialTap } from "@brew/tap"
import type { Package } from "@brew/types"

// cold-brew's own synthetic tap is created and managed by cold-brew itself
// (and auto-trusted via `brew trust`), so it is never surfaced as untrusted.
export const COLD_BREW_TAP = "cold-brew/cold-brew"

export interface TrustStore {
  taps: Set<string>
  formulae: Set<string>
  casks: Set<string>
}

function emptyStore(): TrustStore {
  return { taps: new Set(), formulae: new Set(), casks: new Set() }
}

// Homebrew persists tap-trust state to `$XDG_CONFIG_HOME/homebrew/trust.json`
// when `XDG_CONFIG_HOME` is set, otherwise `~/.homebrew/trust.json` (see
// `brew trust --help`). Entries are lowercased under `trustedtaps` /
// `trustedformulae` / `trustedcasks`.
export function trustFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const configHome = xdg ? join(xdg, "homebrew") : join(homedir(), ".homebrew")
  return join(configHome, "trust.json")
}

function toSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(
    value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.toLowerCase()),
  )
}

export function loadTrustStore(): TrustStore {
  let raw: string
  try {
    raw = readFileSync(trustFilePath(), "utf8")
  } catch {
    return emptyStore()
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== "object" || parsed === null) return emptyStore()
    return {
      taps: toSet(parsed.trustedtaps),
      formulae: toSet(parsed.trustedformulae),
      casks: toSet(parsed.trustedcasks),
    }
  } catch {
    return emptyStore()
  }
}

// Whether a given tap (provider of `name`) is trusted: official, cold-brew's own,
// explicitly trusted at the tap level, or individually trusted for this
// formula/cask (`brew trust` supports per-package grants, so a tap can be
// untrusted while one of its packages is trusted).
export function isTapTrusted(tap: string, name: string, isCask: boolean, store: TrustStore): boolean {
  if (tap === COLD_BREW_TAP) return true
  if (isOfficialTap(tap)) return true
  if (store.taps.has(tap.toLowerCase())) return true
  const fullName = `${tap}/${name}`.toLowerCase()
  return isCask ? store.casks.has(fullName) : store.formulae.has(fullName)
}

// A package is trusted when its upstream tap is trusted by the rules above.
export function isPackageTrusted(pkg: Pick<Package.Info, "name" | "originTap" | "isCask">, store: TrustStore): boolean {
  return isTapTrusted(pkg.originTap, pkg.name, pkg.isCask, store)
}

// The first untrusted tap that shadows this package — a same-named tap checked
// out on disk that isn't the package's origin. Only meaningful for an otherwise
// trusted package (an untrusted package is already flagged on its own merits),
// so callers pass `trusted` to gate it.
function shadowedBy(
  pkg: Pick<Package.Info, "name" | "isCask"> & { shadowTaps?: string[] },
  trusted: boolean,
  store: TrustStore,
): string | null {
  if (!trusted) return null
  return (pkg.shadowTaps ?? []).find((tap) => !isTapTrusted(tap, pkg.name, pkg.isCask, store)) ?? null
}

export function markTrusted<T extends Pick<Package.Info, "name" | "originTap" | "isCask"> & { shadowTaps?: string[] }>(
  packages: readonly T[],
  store: TrustStore = loadTrustStore(),
): Array<T & { trusted: boolean; shadowedBy: string | null }> {
  return packages.map((pkg) => {
    const trusted = isPackageTrusted(pkg, store)
    return { ...pkg, trusted, shadowedBy: shadowedBy(pkg, trusted, store) }
  })
}
