import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { isOfficialTap } from "@brew/tap"
import { isPackageTrusted, loadTrustStore, markTrusted, type TrustStore, trustFilePath } from "@brew/trust"

const PRIOR = process.env.XDG_CONFIG_HOME
let xdgHome: string
let configHome: string

beforeEach(async () => {
  // brew resolves trust.json under $XDG_CONFIG_HOME/homebrew when XDG is set.
  xdgHome = await mkdtemp(join(tmpdir(), "cb-trust-"))
  configHome = join(xdgHome, "homebrew")
  await mkdir(configHome, { recursive: true })
  process.env.XDG_CONFIG_HOME = xdgHome
})

afterEach(async () => {
  if (PRIOR === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = PRIOR
  await rm(xdgHome, { recursive: true, force: true })
})

async function writeTrust(store: Record<string, string[]>) {
  await writeFile(join(configHome, "trust.json"), JSON.stringify(store))
}

function entry(overrides: Partial<{ name: string; originTap: string; isCask: boolean }> = {}) {
  return { name: "demo", originTap: "homebrew/core", isCask: false, ...overrides }
}

describe("isOfficialTap", () => {
  test("any homebrew-owned tap is official", () => {
    expect(isOfficialTap("homebrew/core")).toBe(true)
    expect(isOfficialTap("homebrew/cask")).toBe(true)
    expect(isOfficialTap("Homebrew/Cask")).toBe(true)
    expect(isOfficialTap("ahokinson/tap")).toBe(false)
    expect(isOfficialTap("cold-brew/cold-brew")).toBe(false)
  })

  test("a malformed slashless tap is not official", () => {
    expect(isOfficialTap("homebrew")).toBe(false)
    expect(isOfficialTap("homebrew/")).toBe(false)
    expect(isOfficialTap("")).toBe(false)
  })
})

describe("trustFilePath", () => {
  test("uses $XDG_CONFIG_HOME/homebrew when set", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-example"
    expect(trustFilePath()).toBe(join("/tmp/xdg-example", "homebrew", "trust.json"))
  })

  test("falls back to ~/.homebrew when XDG is unset", () => {
    delete process.env.XDG_CONFIG_HOME
    expect(trustFilePath()).toBe(join(homedir(), ".homebrew", "trust.json"))
  })
})

describe("loadTrustStore", () => {
  test("missing file yields empty store", () => {
    const store = loadTrustStore()
    expect(store.taps.size).toBe(0)
    expect(store.casks.size).toBe(0)
    expect(store.formulae.size).toBe(0)
  })

  test("parses and lowercases entries", async () => {
    await writeTrust({
      trustedtaps: ["Foo/Bar"],
      trustedcasks: ["ahokinson/tap/Claude-Code"],
      trustedformulae: ["cold-brew/cold-brew/awscli"],
    })
    const store = loadTrustStore()
    expect(store.taps.has("foo/bar")).toBe(true)
    expect(store.casks.has("ahokinson/tap/claude-code")).toBe(true)
    expect(store.formulae.has("cold-brew/cold-brew/awscli")).toBe(true)
  })

  test("invalid json yields empty store", async () => {
    await writeFile(join(configHome, "trust.json"), "{ not json")
    const store = loadTrustStore()
    expect(store.taps.size).toBe(0)
  })
})

describe("isPackageTrusted", () => {
  const empty: TrustStore = { taps: new Set(), formulae: new Set(), casks: new Set() }

  test("official taps are always trusted", () => {
    expect(isPackageTrusted(entry({ originTap: "homebrew/core" }), empty)).toBe(true)
    expect(isPackageTrusted(entry({ originTap: "homebrew/cask", isCask: true }), empty)).toBe(true)
  })

  test("cold-brew's own tap is trusted (auto-trusted)", () => {
    expect(isPackageTrusted(entry({ originTap: "cold-brew/cold-brew" }), empty)).toBe(true)
  })

  test("untrusted third-party tap is flagged", () => {
    expect(isPackageTrusted(entry({ originTap: "ahokinson/tap" }), empty)).toBe(false)
  })

  test("unknown origin is untrusted", () => {
    expect(isPackageTrusted(entry({ originTap: "unknown" }), empty)).toBe(false)
  })

  test("explicitly trusted tap is trusted", () => {
    const store: TrustStore = { taps: new Set(["ahokinson/tap"]), formulae: new Set(), casks: new Set() }
    expect(isPackageTrusted(entry({ originTap: "ahokinson/tap" }), store)).toBe(true)
  })

  test("per-package trust honours formula/cask granularity", () => {
    // The tap itself is untrusted, but this specific cask is trusted.
    const store: TrustStore = {
      taps: new Set(),
      formulae: new Set(),
      casks: new Set(["ahokinson/tap/claude-code"]),
    }
    expect(isPackageTrusted(entry({ name: "claude-code", originTap: "ahokinson/tap", isCask: true }), store)).toBe(true)
    // A formula of the same name on the same tap is not covered by a cask grant.
    expect(isPackageTrusted(entry({ name: "claude-code", originTap: "ahokinson/tap", isCask: false }), store)).toBe(
      false,
    )
  })
})

describe("markTrusted", () => {
  test("annotates each package against the store", async () => {
    await writeTrust({ trustedtaps: ["ahokinson/tap"] })
    const marked = markTrusted([
      entry({ name: "a", originTap: "ahokinson/tap" }),
      entry({ name: "b", originTap: "evil/tap" }),
    ])
    expect(marked.find((p) => p.name === "a")?.trusted).toBe(true)
    expect(marked.find((p) => p.name === "b")?.trusted).toBe(false)
  })

  test("flags a trusted package shadowed by an untrusted same-named tap", () => {
    const empty: TrustStore = { taps: new Set(), formulae: new Set(), casks: new Set() }
    const marked = markTrusted(
      [{ name: "grype", originTap: "homebrew/core", isCask: false, shadowTaps: ["anchore/grype"] }],
      empty,
    )
    expect(marked[0]!.trusted).toBe(true)
    expect(marked[0]!.shadowedBy).toBe("anchore/grype")
  })

  test("shadow clears once the shadowing tap is trusted", () => {
    const store: TrustStore = { taps: new Set(["anchore/grype"]), formulae: new Set(), casks: new Set() }
    const marked = markTrusted(
      [{ name: "grype", originTap: "homebrew/core", isCask: false, shadowTaps: ["anchore/grype"] }],
      store,
    )
    expect(marked[0]!.shadowedBy).toBeNull()
  })

  test("an already-untrusted package reports no shadow (it's flagged on its own merits)", () => {
    const empty: TrustStore = { taps: new Set(), formulae: new Set(), casks: new Set() }
    const marked = markTrusted([{ name: "x", originTap: "evil/tap", isCask: false, shadowTaps: ["other/tap"] }], empty)
    expect(marked[0]!.trusted).toBe(false)
    expect(marked[0]!.shadowedBy).toBeNull()
  })
})
