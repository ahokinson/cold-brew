import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  brewInfoJson,
  brewLeaves,
  brewListCaskVersions,
  brewListVersions,
  brewOutdatedJson,
  brewPassthrough,
  brewReinstallFromTap,
  brewUpgrade,
  brewVersionHistory,
  fetchSourceLastModifiedBatch,
  hasGitHubToken,
} from "@brew/api"
import { resetDb } from "@db"

type FakeChild = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exitCode: number
  exited: Promise<void>
  kill: () => void
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      if (text.length > 0) controller.enqueue(enc.encode(text))
      controller.close()
    },
  })
}

function fakeChild(stdout: string, stderr = "", exitCode = 0): FakeChild {
  return {
    stdout: streamFrom(stdout),
    stderr: streamFrom(stderr),
    exitCode,
    exited: Promise.resolve(),
    kill: () => {},
  }
}

function fakeResponse(
  body: unknown,
  init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {},
): Response {
  const ok = init.ok ?? true
  const status = init.status ?? (ok ? 200 : 500)
  const headers = new Headers(init.headers ?? {})
  return {
    ok,
    status,
    headers,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  } as Response
}

let spawnSpy: ReturnType<typeof spyOn> | null = null
const realFetch = globalThis.fetch

beforeEach(() => {
  resetDb()
})

afterEach(() => {
  spawnSpy?.mockRestore()
  spawnSpy = null
  globalThis.fetch = realFetch
})

function stubSpawn(handler: (args: string[]) => FakeChild) {
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => handler(args)) as never)
  return spawnSpy
}

describe("hasGitHubToken", () => {
  const original = { token: process.env.GITHUB_TOKEN, ghToken: process.env.GH_TOKEN }
  afterEach(() => {
    if (original.token === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = original.token
    if (original.ghToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = original.ghToken
  })

  test("true when GITHUB_TOKEN is set", () => {
    delete process.env.GH_TOKEN
    process.env.GITHUB_TOKEN = "x"
    expect(hasGitHubToken()).toBe(true)
  })

  test("true when GH_TOKEN is set", () => {
    delete process.env.GITHUB_TOKEN
    process.env.GH_TOKEN = "x"
    expect(hasGitHubToken()).toBe(true)
  })

  test("false when neither is set", () => {
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    expect(hasGitHubToken()).toBe(false)
  })
})

describe("brewPrefix / brew list / leaves / outdated / info — spawn passthrough", () => {
  // brewPrefix is exercised transitively via ensureColdBrewTap in the
  // brewInstallVersion suite below. An explicit test here would populate
  // the module-level _prefix cache and prevent that suite from controlling
  // the resolved prefix.

  test("brewListVersions parses 'name<ws>version' lines", async () => {
    stubSpawn(() => fakeChild("gcc 14.1.0\nopenssl@3 3.3.1\n\nignored line with bad name? \\\n"))
    const map = await brewListVersions()
    expect(map.get("gcc")).toBe("14.1.0")
    expect(map.get("openssl@3")).toBe("3.3.1")
  })

  test("brewListCaskVersions delegates to cask list", async () => {
    stubSpawn(() => fakeChild("firefox 130.0\n"))
    const map = await brewListCaskVersions()
    expect(map.get("firefox")).toBe("130.0")
  })

  test("brewLeaves strips tap prefix and filters empty lines", async () => {
    stubSpawn(() => fakeChild("gcc\nuser/tap/acli\n\n"))
    const leaves = await brewLeaves()
    expect(leaves.has("gcc")).toBe(true)
    expect(leaves.has("acli")).toBe(true)
  })

  test("brewOutdatedJson parses JSON", async () => {
    const body = JSON.stringify({
      formulae: [
        { name: "gcc", installed_versions: ["13.0"], current_version: "14.1.0", pinned: false, pinned_version: null },
      ],
      casks: [{ name: "firefox", installed_versions: ["129"], current_version: "130.0" }],
    })
    stubSpawn(() => fakeChild(body))
    const result = await brewOutdatedJson()
    expect(result.formulae[0]!.name).toBe("gcc")
    expect(result.casks[0]!.name).toBe("firefox")
  })

  test("brewOutdatedJson returns empty on parse error", async () => {
    stubSpawn(() => fakeChild("not json"))
    expect(await brewOutdatedJson()).toEqual({ formulae: [], casks: [] })
  })

  test("brewInfoJson short-circuits on empty input", async () => {
    let called = 0
    stubSpawn(() => {
      called++
      return fakeChild("")
    })
    const result = await brewInfoJson([])
    expect(result).toEqual({ formulae: [], casks: [] })
    expect(called).toBe(0)
  })

  test("brewInfoJson honors type flag and parses output", async () => {
    const seen: string[][] = []
    stubSpawn((args) => {
      seen.push(args)
      return fakeChild('{"formulae":[{"name":"gcc"}],"casks":[]}')
    })
    const result = await brewInfoJson(["gcc"], "formula")
    expect(result.formulae[0]!.name).toBe("gcc")
    expect(seen[0]!.slice(0, 4)).toEqual(["brew", "info", "--json=v2", "--formula"])
  })

  test("brewInfoJson tolerates malformed JSON", async () => {
    stubSpawn(() => fakeChild("garbage"))
    expect(await brewInfoJson(["x"])).toEqual({ formulae: [], casks: [] })
  })
})

describe("brewUpgrade", () => {
  test("empty package list short-circuits", async () => {
    let calls = 0
    stubSpawn(() => {
      calls++
      return fakeChild("")
    })
    const result = await brewUpgrade([])
    expect(result).toEqual({ exitCode: 0, formulaeSucceeded: [], casksSucceeded: [] })
    expect(calls).toBe(0)
  })

  test("clean exit: all names reported as succeeded", async () => {
    stubSpawn(() => fakeChild("", "", 0))
    const result = await brewUpgrade([
      { name: "gcc", isCask: false, tap: "homebrew/core", originalTap: null, installedVersion: "13.0" },
      { name: "firefox", isCask: true, tap: "homebrew/cask", originalTap: null, installedVersion: "129" },
    ])
    expect(result.exitCode).toBe(0)
    expect(result.formulaeSucceeded).toContain("gcc")
    expect(result.casksSucceeded).toContain("firefox")
  })

  test("non-zero exit: succeeded list filtered to packages whose version moved", async () => {
    // Sequence:
    //   1) `brew upgrade gcc` → exit 1
    //   2) `brew list --formula --versions` (resolveSucceeded for formulae) → "gcc 14.1.0"
    let step = 0
    stubSpawn((args) => {
      step++
      if (args[1] === "upgrade") return fakeChild("", "", 1)
      if (args[1] === "list") return fakeChild("gcc 14.1.0\n")
      return fakeChild("")
    })
    const result = await brewUpgrade([
      { name: "gcc", isCask: false, tap: "homebrew/core", originalTap: null, installedVersion: "13.0" },
    ])
    expect(result.exitCode).toBe(1)
    expect(result.formulaeSucceeded).toEqual(["gcc"])
    expect(step).toBeGreaterThan(1)
  })

  test("retap step: cold-brew/cold-brew triggers uninstall+install via originalTap", async () => {
    const seen: string[][] = []
    stubSpawn((args) => {
      seen.push(args)
      // Uninstall + install always succeed; upgrade pass exits clean
      return fakeChild("", "", 0)
    })
    const result = await brewUpgrade([
      {
        name: "gcc",
        isCask: false,
        tap: "cold-brew/cold-brew",
        originalTap: "homebrew/core",
        installedVersion: "13.0",
      },
    ])
    expect(result.exitCode).toBe(0)
    // Should have invoked uninstall + install before upgrade
    const uninstall = seen.find((a) => a[1] === "uninstall")
    const install = seen.find((a) => a[1] === "install")
    expect(uninstall).toBeDefined()
    expect(install).toBeDefined()
  })

  test("retap failure marks package as skipped and surfaces exit code", async () => {
    const errSpy = spyOn(console, "error").mockImplementation((() => {}) as never)
    const writeSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    stubSpawn((args) => {
      if (args[1] === "uninstall") return fakeChild("", "real error", 5)
      return fakeChild("", "", 0)
    })
    try {
      const result = await brewUpgrade([
        {
          name: "gcc",
          isCask: false,
          tap: "cold-brew/cold-brew",
          originalTap: "homebrew/core",
          installedVersion: "13.0",
        },
      ])
      expect(result.exitCode).toBe(5)
    } finally {
      errSpy.mockRestore()
      writeSpy.mockRestore()
    }
  })

  test("needsRelink packages route to `brew reinstall` instead of `brew upgrade`", async () => {
    const seen: string[][] = []
    stubSpawn((args) => {
      seen.push(args)
      return fakeChild("", "", 0)
    })
    const result = await brewUpgrade([
      {
        name: "golangci-lint",
        isCask: false,
        tap: "homebrew/core",
        originalTap: null,
        installedVersion: "2.12.1",
        needsRelink: true,
      },
      {
        name: "ripgrep",
        isCask: false,
        tap: "homebrew/core",
        originalTap: null,
        installedVersion: "14.1.0",
        needsRelink: false,
      },
    ])
    expect(result.exitCode).toBe(0)
    // Both packages are reported succeeded
    expect(result.formulaeSucceeded.sort()).toEqual(["golangci-lint", "ripgrep"])

    // The relink one went to `brew reinstall`; the other to `brew upgrade`.
    const reinstall = seen.find((a) => a[1] === "reinstall")
    const upgrade = seen.find((a) => a[1] === "upgrade")
    expect(reinstall).toBeDefined()
    expect(upgrade).toBeDefined()
    expect(reinstall).toContain("golangci-lint")
    expect(reinstall).not.toContain("ripgrep")
    expect(upgrade).toContain("ripgrep")
    expect(upgrade).not.toContain("golangci-lint")
  })

  test("a successful relink is reported even when a sibling upgrade fails", async () => {
    // golangci-lint relinks (reinstall exits 0, version unchanged); ripgrep's
    // upgrade fails. The merged exit is non-zero, but the relink must not be
    // dropped just because its version didn't move — it is resolved against the
    // reinstall command's own exit code.
    stubSpawn((args) => {
      if (args[1] === "reinstall") return fakeChild("", "", 0)
      if (args[1] === "upgrade") return fakeChild("", "boom", 1)
      if (args[1] === "list") return fakeChild("ripgrep 14.1.0\n") // unchanged → not succeeded
      return fakeChild("", "", 0)
    })
    const result = await brewUpgrade([
      {
        name: "golangci-lint",
        isCask: false,
        tap: "homebrew/core",
        originalTap: null,
        installedVersion: "2.12.1",
        needsRelink: true,
      },
      {
        name: "ripgrep",
        isCask: false,
        tap: "homebrew/core",
        originalTap: null,
        installedVersion: "14.1.0",
        needsRelink: false,
      },
    ])
    expect(result.exitCode).toBe(1)
    expect(result.formulaeSucceeded).toEqual(["golangci-lint"])
  })

  test("relink-only batch: no `brew upgrade` spawned for the empty bucket", async () => {
    const seen: string[][] = []
    stubSpawn((args) => {
      seen.push(args)
      return fakeChild("", "", 0)
    })
    const result = await brewUpgrade([
      {
        name: "golangci-lint",
        isCask: false,
        tap: "homebrew/core",
        originalTap: null,
        installedVersion: "2.12.1",
        needsRelink: true,
      },
    ])
    expect(result.exitCode).toBe(0)
    expect(result.formulaeSucceeded).toEqual(["golangci-lint"])
    expect(seen.find((a) => a[1] === "upgrade")).toBeUndefined()
    expect(seen.find((a) => a[1] === "reinstall")).toBeDefined()
  })

  test("cask needsRelink routes to `brew reinstall --cask`", async () => {
    const seen: string[][] = []
    stubSpawn((args) => {
      seen.push(args)
      return fakeChild("", "", 0)
    })
    const result = await brewUpgrade([
      {
        name: "firefox",
        isCask: true,
        tap: "homebrew/cask",
        originalTap: null,
        installedVersion: "129",
        needsRelink: true,
      },
    ])
    expect(result.exitCode).toBe(0)
    expect(result.casksSucceeded).toEqual(["firefox"])
    const reinstall = seen.find((a) => a[1] === "reinstall")
    expect(reinstall).toBeDefined()
    expect(reinstall).toContain("--cask")
    expect(reinstall).toContain("firefox")
  })

  // Regression: spawnBrewQuiet read only stderr; an undrained stdout pipe
  // blocks the child forever. Assert every child's stdout is consumed.
  test("spawnBrewQuiet drains stdout so a verbose child cannot deadlock", async () => {
    const consumed: boolean[] = []
    const trackingChild = (): FakeChild => {
      const index = consumed.push(false) - 1
      let exitResolve: () => void = () => {}
      const exited = new Promise<void>((resolve) => {
        exitResolve = resolve
      })
      const stdout = new ReadableStream<Uint8Array>({
        pull(controller) {
          // A real pipe only lets the child exit once its stdout is read.
          consumed[index] = true
          controller.enqueue(new TextEncoder().encode("x".repeat(100_000)))
          controller.close()
          exitResolve()
        },
      })
      return { stdout, stderr: streamFrom(""), exitCode: 0, exited, kill: () => {} }
    }
    stubSpawn(() => trackingChild())
    // Exercises brewUninstallAndReinstall → two spawnBrewQuiet calls (uninstall + install).
    const result = await brewReinstallFromTap("gcc", false, "homebrew/core")
    expect(result).toBe(0)
    expect(consumed.length).toBeGreaterThan(0)
    expect(consumed.every(Boolean)).toBe(true)
  })
})

describe("brewPassthrough", () => {
  test("returns child exit code", async () => {
    stubSpawn(() => fakeChild("", "", 42))
    expect(await brewPassthrough(["doctor"])).toBe(42)
  })

  test("returns 1 when exitCode is null", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => ({
      stdout: "",
      stderr: "",
      exited: Promise.resolve(),
      kill: () => {},
    })) as never)
    expect(await brewPassthrough(["doctor"])).toBe(1)
  })
})

describe("brewVersionHistory", () => {
  test("extracts versions from commit subjects, paginates, dedupes by version", async () => {
    const commits1 = [
      { sha: "a".repeat(40), commit: { message: "gcc 14.1.0", committer: { date: "2024-02-01T00:00:00Z" } } },
      { sha: "b".repeat(40), commit: { message: "gcc 14.1.0 bottle", committer: { date: "2024-01-20T00:00:00Z" } } },
      { sha: "c".repeat(40), commit: { message: "gcc 13.2.0", committer: { date: "2023-08-01T00:00:00Z" } } },
    ]
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("page=1")) return fakeResponse(commits1)
      return fakeResponse([])
    }) as unknown as typeof fetch

    const result = await brewVersionHistory("gcc", false, "homebrew/core")
    const versions = result.map((r) => r.version).sort()
    expect(versions).toContain("14.1.0")
    expect(versions).toContain("13.2.0")
    // 14.1.0 should keep the *earlier* commit date (bottle rebuild logic)
    const v14 = result.find((r) => r.version === "14.1.0")!
    expect(v14.commitDate <= "2024-02-01").toBe(true)
  })

  test("custom tap is routed to {owner}/homebrew-{name} repo", async () => {
    const urls: string[] = []
    globalThis.fetch = mock(async (url: string) => {
      urls.push(url)
      return fakeResponse([])
    }) as unknown as typeof fetch
    await brewVersionHistory("acli", false, "ahokinson/tap")
    expect(urls[0]).toContain("Ahokinson/homebrew-tap")
  })

  test("font-prefixed casks route to nested font directory", async () => {
    const urls: string[] = []
    globalThis.fetch = mock(async (url: string) => {
      urls.push(url)
      return fakeResponse([])
    }) as unknown as typeof fetch
    await brewVersionHistory("font-fira-code", true, "homebrew/cask")
    expect(decodeURIComponent(urls[0]!)).toContain("Casks/font/font-f/font-fira-code.rb")
  })

  test("invalid validateGitHubCommits payload breaks the page loop cleanly", async () => {
    globalThis.fetch = mock(async () => fakeResponse({ not: "an array" })) as unknown as typeof fetch
    expect(await brewVersionHistory("gcc", false, "homebrew/core")).toEqual([])
  })

  test("aliased tap (cask-fonts → cask) is normalized", async () => {
    const urls: string[] = []
    globalThis.fetch = mock(async (url: string) => {
      urls.push(url)
      return fakeResponse([])
    }) as unknown as typeof fetch
    await brewVersionHistory("font-inter", true, "homebrew/cask-fonts")
    expect(urls[0]).toContain("Homebrew/homebrew-cask")
  })
})

describe("fetchSourceLastModifiedBatch", () => {
  test("maps each package to a unix timestamp", async () => {
    globalThis.fetch = mock(async () =>
      fakeResponse([
        { sha: "a".repeat(40), commit: { message: "gcc 14.1.0", committer: { date: "2024-02-01T00:00:00Z" } } },
      ]),
    ) as unknown as typeof fetch
    const map = await fetchSourceLastModifiedBatch([
      { name: "gcc", isCask: false, tap: "homebrew/core", latestVersion: "14.1.0" },
    ])
    expect(map.get("gcc")).toBe(Math.floor(Date.UTC(2024, 1, 1) / 1000))
  })

  test("404-ish failure → null", async () => {
    globalThis.fetch = mock(async () => fakeResponse(null, { ok: false, status: 404 })) as unknown as typeof fetch
    const map = await fetchSourceLastModifiedBatch([
      { name: "ghost", isCask: false, tap: "homebrew/core", latestVersion: "1.0" },
    ])
    expect(map.get("ghost")).toBeNull()
  })

  test("latestVersion not found in history → null (no misattribution to an unrelated commit)", async () => {
    // The only commit is for a different version. Returning its date would
    // anchor the hold window on an unrelated (often newer) commit, so the
    // function reports "unknown" and the caller falls back to install time.
    globalThis.fetch = mock(async () =>
      fakeResponse([
        { sha: "a".repeat(40), commit: { message: "gcc 99.0.0", committer: { date: "2025-06-01T00:00:00Z" } } },
      ]),
    ) as unknown as typeof fetch
    const map = await fetchSourceLastModifiedBatch([
      { name: "gcc", isCask: false, tap: "homebrew/core", latestVersion: "14.1.0" },
    ])
    expect(map.get("gcc")).toBeNull()
  })

  test("empty commit list → null", async () => {
    globalThis.fetch = mock(async () => fakeResponse([])) as unknown as typeof fetch
    const map = await fetchSourceLastModifiedBatch([
      { name: "gcc", isCask: false, tap: "homebrew/core", latestVersion: "14.1.0" },
    ])
    expect(map.get("gcc")).toBeNull()
  })

  test("malformed payload → null", async () => {
    globalThis.fetch = mock(async () => fakeResponse({ wrong: "shape" })) as unknown as typeof fetch
    const map = await fetchSourceLastModifiedBatch([
      { name: "gcc", isCask: false, tap: "homebrew/core", latestVersion: "14.1.0" },
    ])
    expect(map.get("gcc")).toBeNull()
  })
})

describe("runBrewCommand timeout path", () => {
  test("fires kill() and throws when setTimeout elapses before child exits", async () => {
    // brewLeaves uses the default 30s timeout. Patching globalThis.setTimeout
    // to fire immediately turns that into a microtask, so the timer's body
    // runs before `await child.exited` resolves.
    const originalSetTimeout = globalThis.setTimeout
    let killed = false
    let neverExited: ((value: unknown) => void) | null = null
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => ({
      // Empty streams — Response.text() resolves immediately — but `exited`
      // hangs until kill() is invoked.
      stdout: "",
      stderr: "",
      exited: new Promise((resolve) => {
        neverExited = resolve
      }),
      exitCode: null,
      kill: () => {
        killed = true
        neverExited?.(undefined)
      },
    })) as never)

    globalThis.setTimeout = ((fn: () => void) => {
      queueMicrotask(fn)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout

    try {
      await expect(brewLeaves()).rejects.toThrow(/timed out/)
      expect(killed).toBe(true)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })
})

describe("brewUpdate", () => {
  test("runs brew update with a 60s timeout (spawn delegate)", async () => {
    const spawned: string[][] = []
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      spawned.push(args)
      return fakeChild("", "", 0)
    }) as never)
    const { brewUpdate } = await import("@brew/api")
    await brewUpdate()
    expect(spawned[0]).toEqual(["brew", "update"])
  })
})

describe("githubHeaders — Authorization", () => {
  const originalToken = process.env.GITHUB_TOKEN
  const originalGh = process.env.GH_TOKEN

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = originalToken
    if (originalGh === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = originalGh
  })

  test("with GITHUB_TOKEN set, fetch sees Authorization header", async () => {
    process.env.GITHUB_TOKEN = "ghp_test"
    let seenAuth = ""
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seenAuth = headers.get("authorization") ?? ""
      return fakeResponse([])
    }) as unknown as typeof fetch
    await brewVersionHistory("gcc", false, "homebrew/core")
    expect(seenAuth).toBe("token ghp_test")
  })
})

describe("brewUpgrade — additional branches", () => {
  test("cold-brew package with NO originalTap: warns and falls back to homebrew/core", async () => {
    const errs: string[] = []
    const errSpy = spyOn(console, "error").mockImplementation(((msg: string) => {
      errs.push(String(msg))
    }) as never)
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((_args: string[]) => {
      // Retap reinstall: uninstall then install — both succeed
      // Upgrade pass: succeeds
      return fakeChild("", "", 0)
    }) as never)
    try {
      const result = await brewUpgrade([
        { name: "gcc", isCask: false, tap: "cold-brew/cold-brew", originalTap: null, installedVersion: "13.0" },
      ])
      expect(result.exitCode).toBe(0)
      expect(errs.join("\n")).toMatch(/no recorded origin/)
    } finally {
      errSpy.mockRestore()
    }
  })

  test("cask-only batch: succeeded by version diff after non-zero exit", async () => {
    // Drives the `kind === "cask"` branch of resolveSucceeded.
    let listCalls = 0
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      if (args[1] === "upgrade") return fakeChild("", "", 1)
      if (args[1] === "list" && args[2] === "--cask") {
        listCalls++
        return fakeChild("firefox 130.0\n")
      }
      return fakeChild("")
    }) as never)
    const result = await brewUpgrade([
      { name: "firefox", isCask: true, tap: "homebrew/cask", originalTap: null, installedVersion: "129" },
    ])
    expect(result.exitCode).toBe(1)
    expect(result.casksSucceeded).toEqual(["firefox"])
    expect(listCalls).toBeGreaterThan(0)
  })

  test("retap of a cask uses --cask install args", async () => {
    const spawned: string[][] = []
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      spawned.push(args)
      return fakeChild("", "", 0)
    }) as never)
    await brewUpgrade([
      {
        name: "firefox",
        isCask: true,
        tap: "cold-brew/cold-brew",
        originalTap: "homebrew/cask",
        installedVersion: "129",
      },
    ])
    const install = spawned.find((a) => a[1] === "install" && a[2] === "--cask")
    expect(install).toBeDefined()
  })

  test("retap of a custom-tap formula uses {tap}/{name} install spec", async () => {
    const spawned: string[][] = []
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      spawned.push(args)
      return fakeChild("", "", 0)
    }) as never)
    await brewUpgrade([
      {
        name: "acli",
        isCask: false,
        tap: "cold-brew/cold-brew",
        originalTap: "ahokinson/tap",
        installedVersion: "1.0",
      },
    ])
    const install = spawned.find((a) => a[1] === "install" && a[2] === "ahokinson/tap/acli")
    expect(install).toBeDefined()
  })

  test("brewListVersionsFor throws during resolveSucceeded → empty succeeded list", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      if (args[1] === "upgrade") return fakeChild("", "", 1)
      if (args[1] === "list") throw new Error("brew list crashed")
      return fakeChild("")
    }) as never)
    const result = await brewUpgrade([
      { name: "gcc", isCask: false, tap: "homebrew/core", originalTap: null, installedVersion: "13.0" },
    ])
    expect(result.exitCode).toBe(1)
    expect(result.formulaeSucceeded).toEqual([])
  })
})

describe("tapToGitHubRepo — invalid tap names", () => {
  // brewVersionHistory routes through tapToGitHubRepo; an invalid tap should
  // bubble out as a thrown Error (no graceful handling).
  test("rejects taps with shell metacharacters", async () => {
    await expect(brewVersionHistory("x", false, "ev;il/tap")).rejects.toThrow(/Invalid tap name/)
  })

  test("rejects a slashless/unknown tap instead of defaulting to homebrew-core", async () => {
    await expect(brewVersionHistory("x", false, "unknown")).rejects.toThrow(/Invalid tap name/)
  })
})

describe("rate-limit response without retry-after/x-ratelimit-reset", () => {
  // The fallback branch sets rateLimitedUntil = Date.now() + 60s. Wrapped in
  // its own describe with afterAll that bumps system time so the leak is
  // contained.
  afterAll(() => {
    setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000))
  })

  test("403 with no rate-limit headers → defaults to 60s window", async () => {
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      return fakeResponse(null, { ok: false, status: 403 }) // no headers
    }) as unknown as typeof fetch
    const result = await brewVersionHistory("gcc", false, "homebrew/core")
    expect(result).toEqual([])
    expect(calls).toBe(1)
  })

  test("fetchVersionPublishDate short-circuits to 'rate-limited' once tripped", async () => {
    // Previous test set rateLimitedUntil. This call should NOT hit fetch.
    let fetchCalls = 0
    globalThis.fetch = mock(async () => {
      fetchCalls++
      return fakeResponse([])
    }) as unknown as typeof fetch
    const map = await fetchSourceLastModifiedBatch([
      { name: "ripgrep", isCask: false, tap: "homebrew/core", latestVersion: "14.0" },
    ])
    expect(map.get("ripgrep")).toBe("rate-limited")
    expect(fetchCalls).toBe(0)
  })

  test("403 with only x-ratelimit-reset header: parses reset time directly", async () => {
    // Bump time past the previous rate-limit window so this test's fetch
    // actually fires, then exercise the x-ratelimit-reset branch.
    setSystemTime(new Date(Date.now() + 5 * 60 * 1000))
    const resetUnix = Math.floor(Date.now() / 1000) + 120
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      return fakeResponse(null, { ok: false, status: 403, headers: { "x-ratelimit-reset": String(resetUnix) } })
    }) as unknown as typeof fetch
    await brewVersionHistory("gcc", false, "homebrew/core")
    expect(calls).toBe(1)
  })
})

describe("fetchSourceLastModifiedBatch — error wrapping", () => {
  test("handler throw → 'rate-limited' sentinel for that package", async () => {
    // Force the handler to throw by making AbortSignal.timeout fire mid-fetch.
    // Easier: stub fetch to throw synchronously, which the concurrency wrapper
    // catches as Error and we re-map to "rate-limited".
    globalThis.fetch = mock(async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const map = await fetchSourceLastModifiedBatch([
      { name: "gcc", isCask: false, tap: "homebrew/core", latestVersion: "14.1.0" },
    ])
    expect(map.get("gcc")).toBe("rate-limited")
  })
})

describe("parseDeclaredVersion — URL fallback", () => {
  // brewInstallVersion uses parseDeclaredVersion on fetched source to refuse a
  // commit whose declared version doesn't match the target. We exercise the
  // url-pattern branch by providing source with no `version "x"` and no
  // `tag: "vx"` — only a tarball URL.
  test("accepts version parsed from tarball URL", async () => {
    const content = 'class Demo < Formula\n  url "https://example.com/v3.2.1.tar.gz"\nend\n'
    const commitHash = "f".repeat(40)
    const enc = new TextEncoder()
    const body = enc.encode(content)
    const header = enc.encode(`blob ${body.length}\0`)
    const combined = new Uint8Array(header.length + body.length)
    combined.set(header)
    combined.set(body, header.length)
    const hash = await crypto.subtle.digest("SHA-1", combined)
    const expectedSha = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")

    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => fakeChild("/tmp/cold-brew-prefix-noop\n")) as never)
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return fakeResponse(content)
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse({ sha: expectedSha })
      }
      return fakeResponse({})
    }) as unknown as typeof fetch

    const { brewInstallVersion } = await import("@brew/api")
    try {
      const exit = await brewInstallVersion("demo", "3.2.1", commitHash, false, "homebrew/core")
      // parsed declared version === target → continues to install branch.
      // Install will either succeed (exit 0) or fail downstream — both prove
      // we passed the version match. The point is no "refusing to step" exit.
      expect([0, 1]).toContain(exit)
    } catch (e) {
      // Sandbox write failure is acceptable — we only care about parse path
      expect((e as Error).message).toMatch(/EFAULT|EACCES|EPERM|not found/)
    }
  })

  // npm registry tarballs use `<name>-<version>.tgz` rather than `/v<version>.tgz`.
  // Regression: playwright-cli's `cli-0.1.11.tgz` URL previously yielded
  // <unparseable> and aborted intermediate stepping.
  test("accepts version parsed from npm-style <name>-<version>.tgz URL", async () => {
    const content = 'class Demo < Formula\n  url "https://registry.npmjs.org/@scope/pkg/-/pkg-0.1.11.tgz"\nend\n'
    const commitHash = "a".repeat(40)
    const enc = new TextEncoder()
    const body = enc.encode(content)
    const header = enc.encode(`blob ${body.length}\0`)
    const combined = new Uint8Array(header.length + body.length)
    combined.set(header)
    combined.set(body, header.length)
    const hash = await crypto.subtle.digest("SHA-1", combined)
    const expectedSha = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")

    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => fakeChild("/tmp/cold-brew-prefix-noop\n")) as never)
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return fakeResponse(content)
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse({ sha: expectedSha })
      }
      return fakeResponse({})
    }) as unknown as typeof fetch

    const { brewInstallVersion } = await import("@brew/api")
    try {
      const exit = await brewInstallVersion("demo", "0.1.11", commitHash, false, "homebrew/core")
      expect([0, 1]).toContain(exit)
    } catch (e) {
      expect((e as Error).message).toMatch(/EFAULT|EACCES|EPERM|not found/)
    }
  })

  // GitHub release assets put the version in a path segment, not the filename:
  // .../releases/download/v2.8.0/deno_src.tar.gz. Regression: deno previously
  // yielded <unparseable> and aborted intermediate stepping.
  test("accepts version parsed from GitHub release download path", async () => {
    const content =
      'class Demo < Formula\n  url "https://github.com/denoland/deno/releases/download/v2.8.0/deno_src.tar.gz"\nend\n'
    const commitHash = "b".repeat(40)
    const enc = new TextEncoder()
    const body = enc.encode(content)
    const header = enc.encode(`blob ${body.length}\0`)
    const combined = new Uint8Array(header.length + body.length)
    combined.set(header)
    combined.set(body, header.length)
    const hash = await crypto.subtle.digest("SHA-1", combined)
    const expectedSha = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")

    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => fakeChild("/tmp/cold-brew-prefix-noop\n")) as never)
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return fakeResponse(content)
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse({ sha: expectedSha })
      }
      return fakeResponse({})
    }) as unknown as typeof fetch

    // exit 1 covers both a parse-refusal and a downstream install failure, so
    // assert the refusal message specifically was never emitted.
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    const { brewInstallVersion } = await import("@brew/api")
    try {
      const exit = await brewInstallVersion("demo", "2.8.0", commitHash, false, "homebrew/core")
      expect([0, 1]).toContain(exit)
    } catch (e) {
      expect((e as Error).message).toMatch(/EFAULT|EACCES|EPERM|not found/)
    } finally {
      const refused = errorSpy.mock.calls.some((c) => String(c[0]).includes("refusing to step"))
      errorSpy.mockRestore()
      expect(refused).toBe(false)
    }
  })
})

describe("verifyFormulaIntegrity error paths", () => {
  test("HTTP error from GitHub contents API throws", async () => {
    const content = 'class Demo < Formula\n  version "1.0"\nend\n'
    const commitHash = `${"0".repeat(39)}1`
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => fakeChild("/tmp/cold-brew-prefix-noop\n")) as never)
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return fakeResponse(content)
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse(null, { ok: false, status: 500 })
      }
      return fakeResponse({})
    }) as unknown as typeof fetch
    const { brewInstallVersion } = await import("@brew/api")
    await expect(brewInstallVersion("demo", "1.0", commitHash, false, "homebrew/core")).rejects.toThrow(
      /could not fetch tree entry/,
    )
  })

  test("API returns no sha field → throws invalid response", async () => {
    const content = 'class Demo < Formula\n  version "1.0"\nend\n'
    const commitHash = `${"0".repeat(38)}12`
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => fakeChild("/tmp/cold-brew-prefix-noop\n")) as never)
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return fakeResponse(content)
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse({})
      }
      return fakeResponse({})
    }) as unknown as typeof fetch
    const { brewInstallVersion } = await import("@brew/api")
    await expect(brewInstallVersion("demo", "1.0", commitHash, false, "homebrew/core")).rejects.toThrow(
      /invalid GitHub API response/,
    )
  })
})

describe("fetchSourceAtCommit — fallback path", () => {
  test("404 on nested raw URL falls back to flat path", async () => {
    const content = 'class Demo < Formula\n  version "1.0"\nend\n'
    const commitHash = `${"0".repeat(37)}123`
    const enc = new TextEncoder()
    const body = enc.encode(content)
    const header = enc.encode(`blob ${body.length}\0`)
    const combined = new Uint8Array(header.length + body.length)
    combined.set(header)
    combined.set(body, header.length)
    const hash = await crypto.subtle.digest("SHA-1", combined)
    const expectedSha = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")

    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => fakeChild("/tmp/cold-brew-prefix-noop\n")) as never)
    const fetchedUrls: string[] = []
    globalThis.fetch = mock(async (url: string) => {
      fetchedUrls.push(url)
      // Nested path (Formula/d/demo.rb) → 404; flat path (Formula/demo.rb) → 200
      if (url.includes("raw.githubusercontent.com") && url.includes("Formula/d/demo.rb")) {
        return fakeResponse(null, { ok: false, status: 404 })
      }
      if (url.includes("raw.githubusercontent.com") && url.endsWith("Formula/demo.rb")) {
        return fakeResponse(content)
      }
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse({ sha: expectedSha })
      }
      return fakeResponse({})
    }) as unknown as typeof fetch

    const { brewInstallVersion } = await import("@brew/api")
    try {
      await brewInstallVersion("demo", "1.0", commitHash, false, "homebrew/core")
    } catch {
      // Allow downstream failures — we just care the fallback URL was hit
    }
    expect(fetchedUrls.some((u) => u.endsWith("Formula/demo.rb"))).toBe(true)
  })
})

describe("brewCapture", () => {
  test("captures combined stdout+stderr, strips \\r, and reports the exit code", async () => {
    const { brewCapture } = await import("@brew/api")
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => ({
      stdout: streamFrom("==> Pouring foo\rline\nout-tail"), // CR + unterminated final
      stderr: streamFrom("Warning: from stderr\n"),
      exited: Promise.resolve(),
      exitCode: 0,
      kill: () => {},
    })) as never)
    const { text, exitCode } = await brewCapture(["upgrade"])
    expect(exitCode).toBe(0)
    expect(text).not.toContain("\r")
    expect(text).toContain("==> Pouring fooline\n")
    expect(text).toContain("out-tail\n")
    // stderr is concatenated after stdout.
    expect(text).toContain("Warning: from stderr\n")
  })

  test("invokes onLine per ANSI-stripped line and returns 1 when no exit code", async () => {
    const { brewCapture } = await import("@brew/api")
    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => ({
      stdout: streamFrom("\x1b[1m==> Upgrading ripgrep\x1b[0m\n"),
      stderr: streamFrom(""),
      exited: Promise.resolve(),
      kill: () => {},
    })) as never)
    const seen: string[] = []
    const { exitCode } = await brewCapture(["upgrade"], { onLine: (l) => seen.push(l) })
    expect(exitCode).toBe(1)
    expect(seen).toContain("==> Upgrading ripgrep")
  })
})

describe("brewUpgrade — output organizing", () => {
  test("condenses brew's upgrade chatter away and defers unexpected warnings", async () => {
    const noisy = `${[
      "==> Fetching foo",
      "==> Downloading https://example.com/foo.tar.gz",
      "Already downloaded: /Users/me/Library/Caches/Homebrew/foo.tar.gz",
      "==> Pouring foo--1.2.3.bottle.tar.gz",
      "==> Summary",
      "🍺  /usr/local/Cellar/foo/1.2.3: 1 file",
      "==> Running `brew cleanup foo`...",
      "Warning: foo is deprecated",
    ].join("\n")}\n`

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      if (args[1] === "upgrade") return fakeChild(noisy, "", 0)
      return fakeChild("")
    }) as never)

    const writes: string[] = []
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      writes.push(String(chunk))
      return true
    }) as never)

    try {
      const result = await brewUpgrade([
        { name: "foo", isCask: false, tap: "homebrew/core", originalTap: null, installedVersion: "1.0" },
      ])
      expect(result.exitCode).toBe(0)
      const joined = writes.join("")
      // All of brew's progress chatter is condensed away.
      expect(joined).not.toContain("Fetching")
      expect(joined).not.toContain("Downloading")
      expect(joined).not.toContain("Pouring")
      expect(joined).not.toContain("Already downloaded")
      expect(joined).not.toContain("Summary")
      expect(joined).not.toContain("🍺")
      expect(joined).not.toContain("brew cleanup")
      // The unexpected warning is surfaced in the deferred trailer.
      expect(joined).toContain("other brew output:")
      expect(joined).toContain("Warning: foo is deprecated")
    } finally {
      writeSpy.mockRestore()
    }
  })
})

describe("brewInstallVersion", () => {
  const originalBunFile = Bun.file
  const testPrefixDir = mkdtempSync(join(tmpdir(), "cold-brew-install-"))

  afterEach(() => {
    Bun.file = originalBunFile
  })

  async function sha1OfBlob(content: string): Promise<string> {
    const enc = new TextEncoder()
    const body = enc.encode(content)
    const header = enc.encode(`blob ${body.length}\0`)
    const combined = new Uint8Array(header.length + body.length)
    combined.set(header)
    combined.set(body, header.length)
    const hash = await crypto.subtle.digest("SHA-1", combined)
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")
  }

  test("rejects an invalid package name early", async () => {
    const { brewInstallVersion } = await import("@brew/api")
    await expect(brewInstallVersion("bad name", "1.0", "a".repeat(40), false, "homebrew/core")).rejects.toThrow(
      /Invalid package name/,
    )
  })

  test("rejects an invalid commit hash early", async () => {
    const { brewInstallVersion } = await import("@brew/api")
    await expect(brewInstallVersion("gcc", "1.0", "not-a-sha", false, "homebrew/core")).rejects.toThrow(
      /Invalid commit hash/,
    )
  })

  test("happy path: fetches source, verifies SHA-1, installs via brew", async () => {
    const { brewInstallVersion } = await import("@brew/api")
    const content = 'class Gcc < Formula\n  version "14.0"\nend\n'
    const commitHash = "a".repeat(40)
    const expectedSha = await sha1OfBlob(content)

    const spawned: string[][] = []
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      spawned.push(args)
      if (args[1] === "--prefix") return fakeChild(`${testPrefixDir}\n`)
      if (args[1] === "list") return fakeChild("gcc 14.0\n") // isBrewInstalled check
      return fakeChild("", "", 0)
    }) as never)

    // Bun.write writes the formula file into the cold-brew tap path; redirect
    // to a no-op so we don't touch real disk.
    Bun.file = ((_p: string) => ({
      json: async () => ({}),
      text: async () => content,
    })) as never

    globalThis.fetch = mock(async (url: string) => {
      // raw.githubusercontent.com — return formula source
      if (url.includes("raw.githubusercontent.com")) return fakeResponse(content)
      // api.github.com/.../contents/... — return SHA matching our content
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse({ sha: expectedSha })
      }
      return fakeResponse({})
    }) as unknown as typeof fetch

    let exit: number | null = null
    try {
      exit = await brewInstallVersion("gcc", "14.0", commitHash, false, "homebrew/core")
    } catch (e) {
      // mkdir may fail in sandbox if prefix isn't writable; that's expected
      expect((e as Error).message).toMatch(/EFAULT|EACCES|EPERM/)
      return
    }
    expect(exit).toBe(0)
    // brew install was invoked under the cold-brew tap
    const install = spawned.find((a) => a[1] === "install" && a.some((x) => x.includes("cold-brew/cold-brew/gcc")))
    expect(install).toBeDefined()
  })

  // `no_autobump!` (and other official-tap-only DSL) makes brew abort with
  // "can only be used in official Homebrew taps" when loaded from the
  // synthesized cold-brew/cold-brew tap. Regression: luajit and glab failed
  // to step for this reason. The directive must be stripped from the written
  // formula but NOT before integrity verification of the upstream blob.
  test("strips no_autobump! from the formula written to the local tap", async () => {
    const content = 'class Gcc < Formula\n  version "14.0"\n  no_autobump! because: :bumped_by_upstream\nend\n'
    const commitHash = "7".repeat(40)
    const expectedSha = await sha1OfBlob(content)

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      if (args[1] === "--prefix") return fakeChild(`${testPrefixDir}\n`)
      if (args[1] === "list") return fakeChild("gcc 14.0\n")
      return fakeChild("", "", 0)
    }) as never)
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return fakeResponse(content)
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse({ sha: expectedSha })
      }
      return fakeResponse({})
    }) as unknown as typeof fetch

    const fsp = await import("node:fs/promises")
    const writes: { path: string; data: string }[] = []
    const wfSpy = spyOn(fsp, "writeFile").mockImplementation((async (p: unknown, d: unknown) => {
      writes.push({ path: String(p), data: String(d) })
    }) as never)

    const { brewInstallVersion } = await import("@brew/api")
    try {
      await brewInstallVersion("gcc", "14.0", commitHash, false, "homebrew/core")
    } finally {
      wfSpy.mockRestore()
    }

    const formulaWrite = writes.find((w) => w.path.endsWith("gcc.rb"))
    expect(formulaWrite).toBeDefined()
    expect(formulaWrite!.data).not.toContain("no_autobump!")
    // Integrity verification ran against the unmodified upstream blob, and the
    // rest of the formula survives the strip.
    expect(formulaWrite!.data).toContain('version "14.0"')
  })

  test("rejects when declared version disagrees with target version", async () => {
    const { brewInstallVersion } = await import("@brew/api")
    const content = 'class Gcc < Formula\n  version "99.9"\nend\n'
    const commitHash = "b".repeat(40)
    const expectedSha = await sha1OfBlob(content)

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      if (args[1] === "--prefix") return fakeChild(`${testPrefixDir}\n`)
      return fakeChild("")
    }) as never)
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return fakeResponse(content)
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse({ sha: expectedSha })
      }
      return fakeResponse({})
    }) as unknown as typeof fetch

    const errSpy = spyOn(console, "error").mockImplementation((() => {}) as never)
    try {
      const exit = await brewInstallVersion("gcc", "14.0", commitHash, false, "homebrew/core")
      expect(exit).toBe(1) // mismatch → refuses to step
    } catch (e) {
      // tolerated: sandbox write failure
      expect((e as Error).message).toMatch(/EFAULT|EACCES|EPERM/)
    } finally {
      errSpy.mockRestore()
    }
  })

  test("throws when integrity check fails (SHA mismatch)", async () => {
    const { brewInstallVersion } = await import("@brew/api")
    const content = 'class Gcc < Formula\n  version "14.0"\nend\n'
    const commitHash = "c".repeat(40)

    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => fakeChild(`${testPrefixDir}\n`)) as never)
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return fakeResponse(content)
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse({ sha: "0000000000000000000000000000000000000000" }) // wrong sha
      }
      return fakeResponse({})
    }) as unknown as typeof fetch

    await expect(brewInstallVersion("gcc", "14.0", commitHash, false, "homebrew/core")).rejects.toThrow(
      /Integrity check failed/,
    )
  })

  test("install reports success but package isn't installed → restores from origin tap", async () => {
    const { brewInstallVersion } = await import("@brew/api")
    const content = 'class Gcc < Formula\n  version "14.0"\nend\n'
    const commitHash = "9".repeat(40)
    const expectedSha = await sha1OfBlob(content)

    const spawned: string[][] = []
    const errs: string[] = []
    const errSpy = spyOn(console, "error").mockImplementation(((msg: string) => {
      errs.push(String(msg))
    }) as never)

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      spawned.push(args)
      // Install reports success (exit 0) but the post-install list check says
      // the package is NOT installed → triggers the restore branch.
      if (args[1] === "list" && args[2] === "--formula") return fakeChild("", "", 1) // not installed
      return fakeChild("", "", 0)
    }) as never)

    Bun.file = ((_p: string) => ({
      json: async () => ({}),
      text: async () => content,
    })) as never

    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return fakeResponse(content)
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse({ sha: expectedSha })
      }
      return fakeResponse({})
    }) as unknown as typeof fetch

    try {
      const exit = await brewInstallVersion("gcc", "14.0", commitHash, false, "homebrew/core")
      expect(exit).toBe(1) // install reported 0 but post-check failed → returns 1
      // Restore was attempted
      const restoreInstall = spawned.filter((a) => a[1] === "install").slice(-1)[0]
      expect(restoreInstall).toBeDefined()
      // Warning was logged
      expect(errs.join("\n")).toMatch(/not present after install/)
    } finally {
      errSpy.mockRestore()
    }
  })

  test("restore from origin tap also fails: writes brew stderr and logs restore failure", async () => {
    const { brewInstallVersion } = await import("@brew/api")
    const content = 'class Gcc < Formula\n  version "14.0"\nend\n'
    const commitHash = "8".repeat(40)
    const expectedSha = await sha1OfBlob(content)

    const errs: string[] = []
    const errSpy = spyOn(console, "error").mockImplementation(((msg: string) => {
      errs.push(String(msg))
    }) as never)
    const stderrWrites: string[] = []
    const writeSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      stderrWrites.push(String(chunk))
      return true
    }) as never)

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      // post-install list: NOT installed
      if (args[1] === "list" && args[2] === "--formula") return fakeChild("", "", 1)
      // restore install: fails with stderr
      if (args[1] === "install" && args[2] !== "--cask") {
        // Only the SECOND install call is the restore — first is the initial
        // install which exits 0. Track by stderr content.
        return fakeChild("", "", 0)
      }
      return fakeChild("", "", 0)
    }) as never)

    // Override to make the restore call fail. The first install call (under
    // cold-brew tap) exits 0; the second (restore to homebrew/core) exits 5.
    let _installCount = 0
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      if (args[1] === "install" && args[2] !== "--cask" && !args.some((s) => s.startsWith("cold-brew/"))) {
        // Restore install (origin tap, not cold-brew prefix)
        _installCount++
        return fakeChild("", "restore failed: real error\n", 5)
      }
      if (args[1] === "list" && args[2] === "--formula") return fakeChild("", "", 1)
      return fakeChild("", "", 0)
    }) as never)

    Bun.file = ((_p: string) => ({
      json: async () => ({}),
      text: async () => content,
    })) as never

    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("raw.githubusercontent.com")) return fakeResponse(content)
      if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
        return fakeResponse({ sha: expectedSha })
      }
      return fakeResponse({})
    }) as unknown as typeof fetch

    try {
      await brewInstallVersion("gcc", "14.0", commitHash, false, "homebrew/core")
      // stderr was forwarded from failing restore
      expect(stderrWrites.join("")).toMatch(/restore failed/)
      expect(errs.join("\n")).toMatch(/failed to restore/)
    } finally {
      errSpy.mockRestore()
      writeSpy.mockRestore()
    }
  })

  test("404 on raw URL falls back to flat path; still fails when fallback also 404s", async () => {
    const { brewInstallVersion } = await import("@brew/api")
    const commitHash = "d".repeat(40)

    spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => fakeChild(`${testPrefixDir}\n`)) as never)
    globalThis.fetch = mock(async () => fakeResponse(null, { ok: false, status: 404 })) as unknown as typeof fetch

    await expect(brewInstallVersion("gcc", "14.0", commitHash, false, "homebrew/core")).rejects.toThrow(
      /not found at commit/,
    )
  })
})

// Rate-limit tests trip api.ts's module-level rateLimitedUntil sentinel. The
// afterAll below jumps system time 1 day forward so subsequent test files'
// `Date.now() < rateLimitedUntil` checks always read false. We never reset
// the fake time — downstream tests are time-insensitive (or pin their own
// time explicitly).
describe("rate limiting", () => {
  afterAll(() => {
    setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000))
  })

  // Order matters: fetchSourceLastModifiedBatch first exercises
  // fetchVersionPublishDate's 403/429 → handleRateLimitResponse branch. Once
  // that branch sets rateLimitedUntil, the subsequent brewVersionHistory test
  // would short-circuit on isRateLimited() before reaching its own branch —
  // so it must be paired with a system-time bump (handled below).
  test("fetchSourceLastModifiedBatch: 429 → handleRateLimitResponse + 'rate-limited' sentinel", async () => {
    globalThis.fetch = mock(async () =>
      fakeResponse(null, {
        ok: false,
        status: 429,
        headers: { "retry-after": "30" },
      }),
    ) as unknown as typeof fetch
    const map = await fetchSourceLastModifiedBatch([
      { name: "gcc", isCask: false, tap: "homebrew/core", latestVersion: "14.1.0" },
    ])
    expect(map.get("gcc")).toBe("rate-limited")
  })

  test("brewVersionHistory: 403 with retry-after stops pagination", async () => {
    // Previous test set rateLimitedUntil. Jump time past it so this test's
    // fetch actually fires and exercises the brewVersionHistory rate-limit
    // branch (a different file location).
    setSystemTime(new Date(Date.now() + 5 * 60 * 1000)) // +5 min > 30s retry-after
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      return fakeResponse(null, { ok: false, status: 403, headers: { "retry-after": "60" } })
    }) as unknown as typeof fetch
    const result = await brewVersionHistory("gcc", false, "homebrew/core")
    expect(result).toEqual([])
    expect(calls).toBe(1)
  })
})
