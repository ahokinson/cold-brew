import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { handleStatus } from "@cli/status"
import { resetDb } from "@db"

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
let logSpy: ReturnType<typeof spyOn> | null = null
let warnSpy: ReturnType<typeof spyOn> | null = null
const realFetch = globalThis.fetch
const realBunFile = Bun.file
let logs: string[] = []

beforeEach(() => {
  resetDb()
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  logs = []
  logSpy = spyOn(console, "log").mockImplementation(((msg: string) => {
    logs.push(String(msg))
  }) as never)
  warnSpy = spyOn(console, "warn").mockImplementation((() => {}) as never)
})

afterEach(() => {
  spawnSpy?.mockRestore()
  spawnSpy = null
  logSpy?.mockRestore()
  warnSpy?.mockRestore()
  globalThis.fetch = realFetch
  Bun.file = realBunFile
})

// Drive handleStatus with multiple outdated packages so the sort comparator
// actually runs (single-package case never invokes it).
test("handleStatus sorts ready before held, then alphabetical", async () => {
  const formulae = [
    { name: "ripgrep", installed: "13.0", latest: "14.0" }, // alphabetically late, ready (very old)
    { name: "alpha", installed: "0.9", latest: "1.0" }, // alphabetically early, fresh → held
  ]
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
    if (args[1] === "--prefix") return fakeChild("/opt/homebrew\n")
    if (args[1] === "list" && args[2] === "--formula") {
      return fakeChild(`${formulae.map((f) => `${f.name} ${f.installed}`).join("\n")}\n`)
    }
    if (args[1] === "list" && args[2] === "--cask") return fakeChild("")
    if (args[1] === "leaves") return fakeChild(`${formulae.map((f) => f.name).join("\n")}\n`)
    if (args[1] === "outdated") {
      return fakeChild(
        JSON.stringify({
          formulae: formulae.map((f) => ({
            name: f.name,
            installed_versions: [f.installed],
            current_version: f.latest,
            pinned: false,
            pinned_version: null,
          })),
          casks: [],
        }),
      )
    }
    if (args[1] === "info") {
      return fakeChild(
        JSON.stringify({
          formulae: formulae.map((f) => ({
            name: f.name,
            full_name: f.name,
            tap: "homebrew/core",
            desc: "x",
            homepage: null,
            versions: { stable: f.latest, head: null },
            pinned: false,
            outdated: true,
            installed: [],
          })),
          casks: [],
        }),
      )
    }
    return fakeChild("")
  }) as never)
  Bun.file = ((path: string) => ({
    json: async () => {
      // Distinct source_modified_time per package: ripgrep is OLD (ready), alpha is NEW (held)
      const isAlpha = path.includes("/alpha/")
      return {
        time: isAlpha ? Math.floor(Date.now() / 1000) - 86400 : 1_400_000_000,
        source_modified_time: isAlpha ? Math.floor(Date.now() / 1000) - 86400 : 1_400_000_000,
        installed_as_dependency: false,
        installed_on_request: true,
        built_as_bottle: true,
        poured_from_bottle: true,
        source: { tap: "homebrew/core", versions: { stable: "0.9", head: null } },
      }
    },
  })) as typeof Bun.file
  globalThis.fetch = mock(async () => fakeResponse([])) as unknown as typeof fetch

  const exit = await handleStatus()
  expect(exit).toBe(0)
  const out = logs.join("\n")
  // Both packages should appear
  expect(out).toContain("ripgrep")
  expect(out).toContain("alpha")
  // Ready section comes first — ripgrep before alpha despite alphabetical order
  const ripgrepIdx = out.indexOf("ripgrep")
  const alphaIdx = out.indexOf("alpha")
  expect(ripgrepIdx).toBeGreaterThan(-1)
  expect(alphaIdx).toBeGreaterThan(-1)
  // ripgrep (ready, old) renders BEFORE alpha (held, fresh)
  expect(ripgrepIdx).toBeLessThan(alphaIdx)
})

describe("handleStatus alphabetical fallback", () => {
  // Two packages in the SAME ready bucket — comparator falls through to localeCompare.
  test("alphabetical when both are ready", async () => {
    const formulae = [
      { name: "zebra", installed: "1.0", latest: "2.0" },
      { name: "alpha", installed: "1.0", latest: "2.0" },
    ]
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      if (args[1] === "--prefix") return fakeChild("/opt/homebrew\n")
      if (args[1] === "list" && args[2] === "--formula") {
        return fakeChild(`${formulae.map((f) => `${f.name} ${f.installed}`).join("\n")}\n`)
      }
      if (args[1] === "list" && args[2] === "--cask") return fakeChild("")
      if (args[1] === "leaves") return fakeChild(`${formulae.map((f) => f.name).join("\n")}\n`)
      if (args[1] === "outdated") {
        return fakeChild(
          JSON.stringify({
            formulae: formulae.map((f) => ({
              name: f.name,
              installed_versions: [f.installed],
              current_version: f.latest,
              pinned: false,
              pinned_version: null,
            })),
            casks: [],
          }),
        )
      }
      if (args[1] === "info") {
        return fakeChild(
          JSON.stringify({
            formulae: formulae.map((f) => ({
              name: f.name,
              full_name: f.name,
              tap: "homebrew/core",
              desc: "x",
              homepage: null,
              versions: { stable: f.latest, head: null },
              pinned: false,
              outdated: true,
              installed: [],
            })),
            casks: [],
          }),
        )
      }
      return fakeChild("")
    }) as never)
    Bun.file = ((_path: string) => ({
      // Old enough to be ready for both
      json: async () => ({
        time: 1_400_000_000,
        source_modified_time: 1_400_000_000,
        installed_as_dependency: false,
        installed_on_request: true,
        built_as_bottle: true,
        poured_from_bottle: true,
        source: { tap: "homebrew/core", versions: { stable: "1.0", head: null } },
      }),
    })) as typeof Bun.file
    globalThis.fetch = mock(async () => fakeResponse([])) as unknown as typeof fetch

    const exit = await handleStatus()
    expect(exit).toBe(0)
    const out = logs.join("\n")
    expect(out.indexOf("alpha")).toBeLessThan(out.indexOf("zebra"))
  })
})
