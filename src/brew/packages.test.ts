import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { resetBrewPrefixCache } from "@brew/api"
import { getInstalledPackages, withAdvisories, withMetadata, withOutdatedInfo } from "@brew/packages"
import { markTrusted, type TrustStore } from "@brew/trust"
import { Package } from "@brew/types"
import { getOriginalTap, resetDb, setOriginalTap } from "@db"

// Tests drive packages.ts through real api.ts code paths with Bun.spawn and
// fetch stubbed. Avoids mock.module(), which is process-global and would
// poison api.test.ts running in the same suite.

type FakeChild = { stdout: string; stderr: string; exitCode: number; exited: Promise<void>; kill: () => void }
function fakeChild(stdout = "", stderr = "", exitCode = 0): FakeChild {
  return { stdout, stderr, exitCode, exited: Promise.resolve(), kill: () => {} }
}
function fakeResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    headers: new Headers(),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  } as Response
}

let spawnSpy: ReturnType<typeof spyOn> | null = null
const realFetch = globalThis.fetch
const originalBunFile = Bun.file

beforeEach(() => {
  resetDb()
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
})

afterEach(() => {
  spawnSpy?.mockRestore()
  spawnSpy = null
  globalThis.fetch = realFetch
  Bun.file = originalBunFile
})

function stubSpawn(handler: (args: string[]) => FakeChild) {
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => handler(args)) as never)
}

function stubBunFileJson(returned: unknown) {
  // @ts-expect-error — patched for the duration of one test
  Bun.file = (_path: string) => ({
    json: async () => {
      if (returned === null) throw new Error("ENOENT")
      return returned
    },
  })
}

function pkg(overrides: Partial<Package.Info> = {}): Package.Info {
  return {
    name: "demo",
    installedVersion: "1.0.0",
    latestVersion: "1.1.0",
    installedAt: 0,
    sourceModifiedAt: 0,
    isLeaf: true,
    installedAsDependency: false,
    installedOnRequest: true,
    pinned: false,
    outdated: true,
    needsRelink: false,
    tap: "homebrew/core",
    originTap: "homebrew/core",
    trusted: true,
    description: null,
    isCask: false,
    dateConfidence: Package.DateConfidence.Authoritative,
    ...overrides,
  }
}

const EMPTY_STORE: TrustStore = { taps: new Set(), formulae: new Set(), casks: new Set() }

// Run `body` with a throwaway brew prefix wired through COLD_BREW_BREW_PREFIX so
// the on-disk tap scan reads a hermetic temp tree instead of the real machine.
async function inTapEnv(body: (prefix: string) => Promise<void>) {
  const prefix = await mkdtemp(join(tmpdir(), "cb-taps-"))
  const prior = process.env.COLD_BREW_BREW_PREFIX
  process.env.COLD_BREW_BREW_PREFIX = prefix
  resetBrewPrefixCache()
  try {
    await body(prefix)
  } finally {
    if (prior === undefined) delete process.env.COLD_BREW_BREW_PREFIX
    else process.env.COLD_BREW_BREW_PREFIX = prior
    resetBrewPrefixCache()
    await rm(prefix, { recursive: true, force: true })
  }
}

function stubList(prefix: string, lists: { formulae?: string; casks?: string }) {
  stubSpawn((args) => {
    if (args[1] === "--prefix") return fakeChild(`${prefix}\n`)
    if (args[1] === "list" && args[2] === "--formula") return fakeChild(lists.formulae ?? "")
    if (args[1] === "list" && args[2] === "--cask") return fakeChild(lists.casks ?? "")
    return fakeChild("")
  })
}

async function writeFormulaReceipt(prefix: string, name: string, version: string, source: unknown) {
  const dir = join(prefix, "Cellar", name, version)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "INSTALL_RECEIPT.json"),
    JSON.stringify({
      time: 1700000000,
      source_modified_time: 1700000000,
      installed_as_dependency: false,
      installed_on_request: true,
      built_as_bottle: true,
      poured_from_bottle: true,
      source,
    }),
  )
}

async function writeCaskReceipt(prefix: string, name: string, source: unknown) {
  const dir = join(prefix, "Caskroom", name, ".metadata")
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "INSTALL_RECEIPT.json"),
    JSON.stringify({ time: 1700000000, installed_on_request: true, source }),
  )
}

// Caskroom dir without a receipt — `brew list --cask` still reports it, but
// readCaskInstallReceipt returns null (missing-receipt path).
async function makeCaskroom(prefix: string, name: string, version: string) {
  await mkdir(join(prefix, "Caskroom", name, version), { recursive: true })
}

// `tap` is "user/repo"; write a stub `.rb` at <relpath> under its Library/Taps dir.
async function writeTapFile(prefix: string, tap: string, relpath: string) {
  const [user, repo] = tap.split("/")
  const full = join(prefix, "Library", "Taps", user!, `homebrew-${repo}`, relpath)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, "# stub")
}

describe("getInstalledPackages — tap origin resolution", () => {
  test("stepped formula resolves originTap from a root-layout tap and heals the db", async () => {
    await inTapEnv(async (prefix) => {
      // anomalyco/tap publishes opencode.rb at the tap ROOT (not Formula/).
      await writeFormulaReceipt(prefix, "opencode", "1.0", {
        tap: "cold-brew/cold-brew",
        versions: { stable: "1.0", head: null },
      })
      await writeTapFile(prefix, "anomalyco/tap", "opencode.rb")
      stubList(prefix, { formulae: "opencode 1.0\n" })

      const result = await getInstalledPackages()
      const pkg = result.find((p) => p.name === "opencode")!
      expect(pkg.originTap).toBe("anomalyco/tap")
      expect(getOriginalTap("opencode")).toBe("anomalyco/tap")
      expect(markTrusted([pkg], EMPTY_STORE)[0]!.trusted).toBe(false)
    })
  })

  test("HomebrewFormula/ layout resolves for a missing-source-tap receipt", async () => {
    await inTapEnv(async (prefix) => {
      // Receipt present but source.tap absent → "unknown" → scan kicks in.
      await writeFormulaReceipt(prefix, "widget", "1.0", { versions: { stable: "1.0", head: null } })
      await writeTapFile(prefix, "acme/tools", "HomebrewFormula/widget.rb")
      stubList(prefix, { formulae: "widget 1.0\n" })

      const pkg = (await getInstalledPackages()).find((p) => p.name === "widget")!
      expect(pkg.originTap).toBe("acme/tools")
    })
  })

  test("sharded cask layout (Casks/<letter>/<name>.rb) resolves", async () => {
    await inTapEnv(async (prefix) => {
      await writeCaskReceipt(prefix, "claude-code", { tap: "cold-brew/cold-brew" })
      await writeTapFile(prefix, "ahokinson/tap", "Casks/c/claude-code.rb")
      stubList(prefix, { casks: "claude-code 1.0\n" })

      const pkg = (await getInstalledPackages()).find((p) => p.name === "claude-code")!
      expect(pkg.originTap).toBe("ahokinson/tap")
    })
  })

  test("missing-receipt cask resolves to its on-disk tap", async () => {
    await inTapEnv(async (prefix) => {
      await makeCaskroom(prefix, "tool", "1.0")
      await writeTapFile(prefix, "vendor/tap", "Casks/tool.rb")
      stubList(prefix, { casks: "tool 1.0\n" })

      const pkg = (await getInstalledPackages()).find((p) => p.name === "tool")!
      expect(pkg.originTap).toBe("vendor/tap")
    })
  })

  test("missing-receipt cask with no tap on disk falls back to unknown (untrusted)", async () => {
    await inTapEnv(async (prefix) => {
      await makeCaskroom(prefix, "orphan", "1.0")
      stubList(prefix, { casks: "orphan 1.0\n" })

      const pkg = (await getInstalledPackages()).find((p) => p.name === "orphan")!
      expect(pkg.originTap).toBe("unknown")
      expect(markTrusted([pkg], EMPTY_STORE)[0]!.trusted).toBe(false)
    })
  })

  test("unresolvable stepped formula falls back to unknown, never an official tap", async () => {
    await inTapEnv(async (prefix) => {
      await writeFormulaReceipt(prefix, "ghosted", "1.0", {
        tap: "cold-brew/cold-brew",
        versions: { stable: "1.0", head: null },
      })
      stubList(prefix, { formulae: "ghosted 1.0\n" })

      const pkg = (await getInstalledPackages()).find((p) => p.name === "ghosted")!
      expect(pkg.originTap).toBe("unknown")
    })
  })

  test("genuine homebrew/core install shadowed by an untrusted same-named tap stays core", async () => {
    await inTapEnv(async (prefix) => {
      // grype: concrete homebrew/core receipt, but a stale anchore/grype tap
      // (root layout) sits on disk. The receipt wins; the shadow is recorded.
      await writeFormulaReceipt(prefix, "grype", "0.112.0", {
        tap: "homebrew/core",
        versions: { stable: "0.112.0", head: null },
      })
      await writeTapFile(prefix, "anchore/grype", "grype.rb")
      stubList(prefix, { formulae: "grype 0.112.0\n" })

      const pkg = (await getInstalledPackages()).find((p) => p.name === "grype")!
      expect(pkg.originTap).toBe("homebrew/core")
      expect(pkg.shadowTaps).toEqual(["anchore/grype"])
      // The disk scan must not have run for a concrete receipt tap.
      expect(getOriginalTap("grype")).toBeNull()

      const marked = markTrusted([pkg], EMPTY_STORE)[0]!
      expect(marked.trusted).toBe(true)
      expect(marked.shadowedBy).toBe("anchore/grype")
    })
  })

  test("self-heals a poisoned homebrew/core original_tap once the real tap is found", async () => {
    await inTapEnv(async (prefix) => {
      setOriginalTap("opencode", "homebrew/core") // poison from an earlier mis-resolution
      await writeFormulaReceipt(prefix, "opencode", "1.0", {
        tap: "cold-brew/cold-brew",
        versions: { stable: "1.0", head: null },
      })
      await writeTapFile(prefix, "anomalyco/tap", "opencode.rb")
      stubList(prefix, { formulae: "opencode 1.0\n" })

      const pkg = (await getInstalledPackages()).find((p) => p.name === "opencode")!
      expect(pkg.originTap).toBe("anomalyco/tap")
      expect(getOriginalTap("opencode")).toBe("anomalyco/tap")
    })
  })

  test("a still-valid stored origin is not clobbered by an arbitrary same-named tap", async () => {
    await inTapEnv(async (prefix) => {
      // opencode was healed to realvendor/tap on a prior run. Now a second
      // same-named tap (evil/tap) is also checked out and sorts first. The
      // stored origin must stand — resolution must not flip to the namesake.
      setOriginalTap("opencode", "realvendor/tap")
      await writeFormulaReceipt(prefix, "opencode", "1.0", {
        tap: "cold-brew/cold-brew",
        versions: { stable: "1.0", head: null },
      })
      await writeTapFile(prefix, "evil/tap", "opencode.rb")
      await writeTapFile(prefix, "realvendor/tap", "opencode.rb")
      stubList(prefix, { formulae: "opencode 1.0\n" })

      const pkg = (await getInstalledPackages()).find((p) => p.name === "opencode")!
      expect(pkg.originTap).toBe("realvendor/tap")
      expect(getOriginalTap("opencode")).toBe("realvendor/tap")
      expect(pkg.shadowTaps).toEqual(["evil/tap"])
    })
  })

  test("ambiguous same-named taps with no stored origin fall back to unknown (no guess persisted)", async () => {
    await inTapEnv(async (prefix) => {
      // A receipt-less/stepped package provided by two same-named third-party
      // taps and no prior stored origin: we can't tell which is real, so we must
      // not guess the alphabetically-first one (an attacker tap sorting first
      // could capture it). Resolve to "unknown" (untrusted) and persist nothing.
      await writeFormulaReceipt(prefix, "ambig", "1.0", {
        tap: "cold-brew/cold-brew",
        versions: { stable: "1.0", head: null },
      })
      await writeTapFile(prefix, "aaa/evil", "ambig.rb")
      await writeTapFile(prefix, "zzz/real", "ambig.rb")
      stubList(prefix, { formulae: "ambig 1.0\n" })

      const pkg = (await getInstalledPackages()).find((p) => p.name === "ambig")!
      expect(pkg.originTap).toBe("unknown")
      expect(getOriginalTap("ambig")).toBeNull()
      expect(markTrusted([pkg], EMPTY_STORE)[0]!.trusted).toBe(false)
    })
  })

  test("a package stepped from homebrew/core keeps its recorded core origin (stays trusted)", async () => {
    // Regression guard: cold-brew steps core formulae too (awscli, deno, …) and
    // records original_tap=homebrew/core. With no third-party tap shadowing it on
    // disk, that recorded origin must stand — not be downgraded to untrusted.
    await inTapEnv(async (prefix) => {
      setOriginalTap("awscli", "homebrew/core")
      await writeFormulaReceipt(prefix, "awscli", "1.0", {
        tap: "cold-brew/cold-brew",
        versions: { stable: "1.0", head: null },
      })
      stubList(prefix, { formulae: "awscli 1.0\n" })

      const pkg = (await getInstalledPackages()).find((p) => p.name === "awscli")!
      expect(pkg.originTap).toBe("homebrew/core")
      expect(markTrusted([pkg], EMPTY_STORE)[0]!.trusted).toBe(true)
    })
  })
})

describe("getInstalledPackages", () => {
  test("merges formula receipts with cask discovery", async () => {
    stubSpawn((args) => {
      if (args[1] === "--prefix") return fakeChild("/opt/homebrew\n")
      if (args[1] === "list" && args[2] === "--formula") return fakeChild("gcc 14.1.0\n")
      if (args[1] === "list" && args[2] === "--cask") return fakeChild("firefox 130.0\n")
      if (args[1] === "leaves") return fakeChild("gcc\n")
      return fakeChild("")
    })
    stubBunFileJson({
      time: 1700000000,
      source_modified_time: 1700000000,
      installed_as_dependency: false,
      installed_on_request: true,
      built_as_bottle: true,
      poured_from_bottle: true,
      source: { tap: "homebrew/core", versions: { stable: "14.1.0", head: null } },
    })
    const result = await getInstalledPackages()
    const names = result.map((p) => p.name).sort()
    expect(names).toContain("gcc")
    expect(names).toContain("firefox")
    expect(result.find((p) => p.name === "gcc")?.isCask).toBe(false)
    expect(result.find((p) => p.name === "firefox")?.isCask).toBe(true)
  })

  test("formula with missing receipt is dropped", async () => {
    stubSpawn((args) => {
      if (args[1] === "--prefix") return fakeChild("/opt/homebrew\n")
      if (args[1] === "list" && args[2] === "--formula") return fakeChild("ghost 1.0\n")
      return fakeChild("")
    })
    stubBunFileJson(null)
    const result = await getInstalledPackages()
    expect(result.find((p) => p.name === "ghost")).toBeUndefined()
  })

  test("cask takes its tap from the install receipt's source tap", async () => {
    stubSpawn((args) => {
      if (args[1] === "--prefix") return fakeChild("/opt/homebrew\n")
      if (args[1] === "list" && args[2] === "--cask") return fakeChild("claude-code 2.1.0\n")
      return fakeChild("")
    })
    stubBunFileJson({ time: 1700000000, installed_on_request: true, source: { tap: "ahokinson/tap" } })
    const result = await getInstalledPackages()
    const cask = result.find((p) => p.name === "claude-code")
    expect(cask?.isCask).toBe(true)
    expect(cask?.tap).toBe("ahokinson/tap")
    expect(cask?.originTap).toBe("ahokinson/tap")
    expect(cask?.installedAt).toBe(1700000000)
  })

  test("stepped cask resolves originTap from the owning tap on disk and heals the db", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "cb-taps-"))
    const priorPrefixEnv = process.env.COLD_BREW_BREW_PREFIX
    process.env.COLD_BREW_BREW_PREFIX = prefix
    resetBrewPrefixCache()
    try {
      // Stepped onto cold-brew/cold-brew, but the cask file only lives in the
      // upstream ahokinson/tap — the authoritative origin signal.
      const metaDir = join(prefix, "Caskroom", "claude-code", ".metadata")
      await mkdir(metaDir, { recursive: true })
      await writeFile(
        join(metaDir, "INSTALL_RECEIPT.json"),
        JSON.stringify({ time: 1700000000, installed_on_request: true, source: { tap: "cold-brew/cold-brew" } }),
      )
      const tapCasks = join(prefix, "Library", "Taps", "ahokinson", "homebrew-tap", "Casks")
      await mkdir(tapCasks, { recursive: true })
      await writeFile(join(tapCasks, "claude-code.rb"), "cask 'claude-code'")

      stubSpawn((args) => {
        if (args[1] === "--prefix") return fakeChild(`${prefix}\n`)
        if (args[1] === "list" && args[2] === "--cask") return fakeChild("claude-code 2.1.0\n")
        return fakeChild("")
      })

      const result = await getInstalledPackages()
      const cask = result.find((p) => p.name === "claude-code")
      expect(cask?.tap).toBe("cold-brew/cold-brew")
      expect(cask?.originTap).toBe("ahokinson/tap")
      // The polluted/absent original tap is self-healed for next time.
      expect(getOriginalTap("claude-code")).toBe("ahokinson/tap")
    } finally {
      if (priorPrefixEnv === undefined) delete process.env.COLD_BREW_BREW_PREFIX
      else process.env.COLD_BREW_BREW_PREFIX = priorPrefixEnv
      resetBrewPrefixCache()
      await rm(prefix, { recursive: true, force: true })
    }
  })
})

describe("withOutdatedInfo", () => {
  test("attaches latestVersion + outdated flag", async () => {
    stubSpawn(() =>
      fakeChild(
        JSON.stringify({
          formulae: [
            {
              name: "gcc",
              installed_versions: ["13.0"],
              current_version: "14.1.0",
              pinned: false,
              pinned_version: null,
            },
          ],
          casks: [{ name: "firefox", installed_versions: ["129"], current_version: "130.0" }],
        }),
      ),
    )
    const result = await withOutdatedInfo([
      pkg({ name: "gcc", outdated: false, latestVersion: null }),
      pkg({ name: "firefox", outdated: false, latestVersion: null }),
      pkg({ name: "ripgrep", outdated: false, latestVersion: null }),
    ])
    expect(result.find((p) => p.name === "gcc")?.latestVersion).toBe("14.1.0")
    expect(result.find((p) => p.name === "ripgrep")?.outdated).toBe(false)
  })

  test("strips tap prefix when matching", async () => {
    stubSpawn(() =>
      fakeChild(
        JSON.stringify({
          formulae: [
            {
              name: "ahokinson/tap/acli",
              installed_versions: ["1"],
              current_version: "2",
              pinned: false,
              pinned_version: null,
            },
          ],
          casks: [],
        }),
      ),
    )
    const result = await withOutdatedInfo([pkg({ name: "acli", outdated: false, latestVersion: null })])
    expect(result[0]!.outdated).toBe(true)
    expect(result[0]!.latestVersion).toBe("2")
  })

  test("flags needsRelink when target keg is already in installed_versions", async () => {
    // Repro for the "Warning: golangci-lint 2.12.2 already installed"
    // scenario: linked keg is 2.12.1, but 2.12.2 is also extracted in the
    // Cellar from a prior interrupted upgrade. brew outdated still reports it
    // as outdated, but a plain `brew upgrade` would no-op.
    stubSpawn(() =>
      fakeChild(
        JSON.stringify({
          formulae: [
            {
              name: "golangci-lint",
              installed_versions: ["2.12.1", "2.12.2"],
              current_version: "2.12.2",
              pinned: false,
              pinned_version: null,
            },
          ],
          casks: [],
        }),
      ),
    )
    const result = await withOutdatedInfo([pkg({ name: "golangci-lint", outdated: false, latestVersion: null })])
    expect(result[0]!.outdated).toBe(true)
    expect(result[0]!.needsRelink).toBe(true)
  })

  test("needsRelink stays false when target is not already in Cellar", async () => {
    stubSpawn(() =>
      fakeChild(
        JSON.stringify({
          formulae: [
            {
              name: "ripgrep",
              installed_versions: ["14.1.0"],
              current_version: "14.2.0",
              pinned: false,
              pinned_version: null,
            },
          ],
          casks: [],
        }),
      ),
    )
    const result = await withOutdatedInfo([pkg({ name: "ripgrep", outdated: false, latestVersion: null })])
    expect(result[0]!.outdated).toBe(true)
    expect(result[0]!.needsRelink).toBe(false)
  })

  test("not-outdated packages get needsRelink: false", async () => {
    stubSpawn(() => fakeChild(JSON.stringify({ formulae: [], casks: [] })))
    const result = await withOutdatedInfo([pkg({ name: "stable", outdated: false })])
    expect(result[0]!.needsRelink).toBe(false)
  })

  test("same-named formula and cask don't clobber each other's outdated info", async () => {
    // Homebrew allows a formula and a cask of the same name. The map must key
    // by kind so the cask (processed second) doesn't overwrite the formula.
    stubSpawn(() =>
      fakeChild(
        JSON.stringify({
          formulae: [
            {
              name: "grype",
              installed_versions: ["0.90.0"],
              current_version: "0.91.0",
              pinned: true,
              pinned_version: null,
            },
          ],
          casks: [{ name: "grype", installed_versions: ["1.0.0"], current_version: "2.0.0" }],
        }),
      ),
    )
    const result = await withOutdatedInfo([
      pkg({ name: "grype", isCask: false, outdated: false, latestVersion: null, pinned: false }),
      pkg({ name: "grype", isCask: true, outdated: false, latestVersion: null, pinned: false }),
    ])
    const formula = result.find((p) => !p.isCask)!
    const cask = result.find((p) => p.isCask)!
    expect(formula.latestVersion).toBe("0.91.0")
    expect(formula.pinned).toBe(true)
    expect(cask.latestVersion).toBe("2.0.0")
    expect(cask.pinned).toBe(false)
  })
})

describe("withMetadata", () => {
  test("uses cached metadata + fills uncached via brew info, then attaches publish date", async () => {
    stubSpawn(() =>
      fakeChild(
        JSON.stringify({
          formulae: [
            {
              name: "gcc",
              full_name: "gcc",
              tap: "homebrew/core",
              desc: "GNU compiler",
              homepage: null,
              versions: { stable: "14.1.0", head: null },
              pinned: false,
              outdated: true,
              installed: [],
            },
          ],
          casks: [],
        }),
      ),
    )
    globalThis.fetch = mock(async () =>
      fakeResponse([
        { sha: "a".repeat(40), commit: { message: "gcc 14.1.0", committer: { date: "2024-02-01T00:00:00Z" } } },
      ]),
    ) as unknown as typeof fetch

    const result = await withMetadata([pkg({ name: "gcc", description: null, latestVersion: null, outdated: true })])
    const gcc = result[0]!
    expect(gcc.description).toBe("GNU compiler")
    expect(gcc.sourceModifiedAt).toBe(Math.floor(Date.UTC(2024, 1, 1) / 1000))
    expect(gcc.dateConfidence).toBe("authoritative")
  })

  test("404 publish date → install-time fallback", async () => {
    stubSpawn(() =>
      fakeChild(
        JSON.stringify({
          formulae: [
            {
              name: "gcc",
              full_name: "gcc",
              tap: "homebrew/core",
              desc: "x",
              homepage: null,
              versions: { stable: "14.1.0", head: null },
              pinned: false,
              outdated: true,
              installed: [],
            },
          ],
          casks: [],
        }),
      ),
    )
    globalThis.fetch = mock(async () => fakeResponse(null, { ok: false, status: 404 })) as unknown as typeof fetch

    const result = await withMetadata([pkg({ name: "gcc", installedAt: 1_600_000_000, outdated: true })])
    expect(result[0]!.dateConfidence).toBe("install-time")
    expect(result[0]!.sourceModifiedAt).toBe(1_600_000_000)
  })
})

describe("withMetadata — cask path", () => {
  test("cask info populates description + version + installedAt + outdated", async () => {
    stubSpawn((args) => {
      if (args[1] === "info") {
        return fakeChild(
          JSON.stringify({
            formulae: [],
            casks: [
              {
                token: "firefox",
                desc: "Browser",
                homepage: null,
                version: "130.0",
                installed: "129.0",
                installed_time: 1_700_000_000,
                outdated: true,
                tap: "homebrew/cask",
                auto_updates: false,
              },
            ],
          }),
        )
      }
      return fakeChild("")
    })
    globalThis.fetch = mock(async () => fakeResponse([])) as unknown as typeof fetch

    const result = await withMetadata([
      pkg({ name: "firefox", isCask: true, tap: "homebrew/cask", outdated: false, latestVersion: null }),
    ])
    const firefox = result[0]!
    expect(firefox.description).toBe("Browser")
    expect(firefox.latestVersion).toBe("130.0")
    // installedAt in mock pkg() defaults to 0; info supplies a value, so it gets merged in
    expect(firefox.installedAt).toBe(1_700_000_000)
  })

  test("404 publish-date response also yields install-time fallback", async () => {
    stubSpawn((args) => {
      if (args[1] === "info") {
        return fakeChild(
          JSON.stringify({
            formulae: [
              {
                name: "gcc",
                full_name: "gcc",
                tap: "homebrew/core",
                desc: "x",
                homepage: null,
                versions: { stable: "14.0", head: null },
                pinned: false,
                outdated: true,
                installed: [],
              },
            ],
            casks: [],
          }),
        )
      }
      return fakeChild("")
    })
    // 404 (not 429) — null sentinel from fetchSourceLastModifiedBatch. Avoids
    // tripping rateLimitedUntil, which would leak into later test files.
    globalThis.fetch = mock(async () =>
      fakeResponse(null, {
        ok: false,
        status: 404,
      } as { ok: boolean; status: number }),
    ) as unknown as typeof fetch

    const result = await withMetadata([pkg({ name: "gcc", installedAt: 1_500_000_000, outdated: true })])
    expect(result[0]!.dateConfidence).toBe("install-time")
    expect(result[0]!.sourceModifiedAt).toBe(1_500_000_000)
  })
})

describe("withMetadata — direct cache seeding", () => {
  test("pre-seeded positive cache short-circuits the publish-date fetch", async () => {
    const { cachePublishDates, cacheMetadata } = await import("@db")
    cacheMetadata([
      { packageName: "gcc", description: "GNU", latestVersion: "14.0", tap: "homebrew/core", installedTime: null },
    ])
    cachePublishDates([{ packageName: "gcc", sourceModifiedAt: 1_700_000_000 }])

    let fetchCalls = 0
    stubSpawn(() => fakeChild(""))
    globalThis.fetch = mock(async () => {
      fetchCalls++
      return fakeResponse([])
    }) as unknown as typeof fetch

    const result = await withMetadata([pkg({ name: "gcc", outdated: true })])
    expect(result[0]!.sourceModifiedAt).toBe(1_700_000_000)
    expect(result[0]!.dateConfidence).toBe("authoritative")
    expect(fetchCalls).toBe(0)
  })

  test("pre-seeded negative cache → installedAt fallback, no fetch", async () => {
    const { cacheNegativePublishDates, cacheMetadata } = await import("@db")
    cacheMetadata([
      { packageName: "gcc", description: "GNU", latestVersion: "14.0", tap: "homebrew/core", installedTime: null },
    ])
    cacheNegativePublishDates(["gcc"])

    let fetchCalls = 0
    stubSpawn(() => fakeChild(""))
    globalThis.fetch = mock(async () => {
      fetchCalls++
      return fakeResponse([])
    }) as unknown as typeof fetch

    const result = await withMetadata([pkg({ name: "gcc", installedAt: 1_500_000_000, outdated: true })])
    expect(result[0]!.dateConfidence).toBe("install-time")
    expect(result[0]!.sourceModifiedAt).toBe(1_500_000_000)
    expect(fetchCalls).toBe(0)
  })
})

describe("withMetadata — cache reuse paths", () => {
  test("second call reuses cached metadata and publish dates (no extra fetches)", async () => {
    let infoCalls = 0
    stubSpawn((args) => {
      if (args[1] === "info") {
        infoCalls++
        return fakeChild(
          JSON.stringify({
            formulae: [
              {
                name: "gcc",
                full_name: "gcc",
                tap: "homebrew/core",
                desc: "GNU compiler",
                homepage: null,
                versions: { stable: "14.0", head: null },
                pinned: false,
                outdated: true,
                installed: [],
              },
            ],
            casks: [],
          }),
        )
      }
      return fakeChild("")
    })
    let fetchCalls = 0
    globalThis.fetch = mock(async () => {
      fetchCalls++
      return fakeResponse([
        { sha: "a".repeat(40), commit: { message: "gcc 14.0", committer: { date: "2024-02-01T00:00:00Z" } } },
      ])
    }) as unknown as typeof fetch

    // First call: populates info cache + publish-date cache
    await withMetadata([pkg({ name: "gcc", outdated: true })])
    const infoCallsAfterFirst = infoCalls
    const fetchCallsAfterFirst = fetchCalls

    // Second call: should hit cached branches
    const result = await withMetadata([pkg({ name: "gcc", outdated: true })])
    expect(result[0]!.description).toBe("GNU compiler")
    expect(infoCalls).toBe(infoCallsAfterFirst) // no new info fetches
    expect(fetchCalls).toBe(fetchCallsAfterFirst) // no new publish-date fetches
  })

  test("negatively-cached publish date falls back to installedAt", async () => {
    stubSpawn((args) => {
      if (args[1] === "info") {
        return fakeChild(
          JSON.stringify({
            formulae: [
              {
                name: "gcc",
                full_name: "gcc",
                tap: "homebrew/core",
                desc: "x",
                homepage: null,
                versions: { stable: "14.0", head: null },
                pinned: false,
                outdated: true,
                installed: [],
              },
            ],
            casks: [],
          }),
        )
      }
      return fakeChild("")
    })
    // First fetch: 404 → seeds the negative cache for gcc
    globalThis.fetch = mock(async () => fakeResponse(null, { ok: false, status: 404 })) as unknown as typeof fetch
    await withMetadata([pkg({ name: "gcc", installedAt: 1_400_000_000, outdated: true })])

    // Second call: should hit the negatively-cached branch and fall back to installedAt
    let secondFetchCalls = 0
    globalThis.fetch = mock(async () => {
      secondFetchCalls++
      return fakeResponse([])
    }) as unknown as typeof fetch
    const result = await withMetadata([pkg({ name: "gcc", installedAt: 1_400_000_000, outdated: true })])
    expect(result[0]!.dateConfidence).toBe("install-time")
    expect(result[0]!.sourceModifiedAt).toBe(1_400_000_000)
    expect(secondFetchCalls).toBe(0) // negative cache short-circuited
  })
})

describe("applyMetadata — cold-brew tap re-derivation", () => {
  test("cold-brew tap with upstream version ahead → re-flags outdated", async () => {
    stubSpawn((args) => {
      if (args[1] === "info") {
        return fakeChild(
          JSON.stringify({
            formulae: [
              {
                name: "gcc",
                full_name: "gcc",
                tap: "homebrew/core",
                desc: "x",
                homepage: null,
                versions: { stable: "14.0", head: null },
                pinned: false,
                outdated: true,
                installed: [],
              },
            ],
            casks: [],
          }),
        )
      }
      return fakeChild("")
    })
    globalThis.fetch = mock(async () => fakeResponse([])) as unknown as typeof fetch

    // Package on cold-brew tap, outdated=false from brew, but upstream latest > installed
    // → applyMetadata re-flags it outdated.
    const result = await withMetadata([
      pkg({ name: "gcc", tap: "cold-brew/cold-brew", outdated: false, installedVersion: "13.5", latestVersion: null }),
    ])
    expect(result[0]!.outdated).toBe(true)
    expect(result[0]!.latestVersion).toBe("14.0")
  })
})

describe("withAdvisories", () => {
  test("attaches summary returned by OSV", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [] }] })
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await withAdvisories([pkg({ name: "gcc", outdated: true })])
    expect(result[0]!.advisories).toEqual({
      entries: [],
      maxCvss: null,
      hasActionableFix: false,
      hasKevListed: false,
      maxEpss: null,
    })
  })

  test("packages without latestVersion get null advisories", async () => {
    const result = await withAdvisories([pkg({ name: "x", outdated: true, latestVersion: null })])
    expect(result[0]!.advisories).toBeNull()
  })
})
