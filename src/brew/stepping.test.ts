import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { resolveIntermediateUpgrades } from "@brew/stepping"
import { Hold, type Package } from "@brew/types"
import { resetDb, setOriginalTap } from "@db"

const realFetch = globalThis.fetch

beforeEach(() => {
  resetDb()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

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

const NOW = Date.UTC(2026, 4, 11)

function ws(overrides: Partial<Package.WithStatus> = {}): Package.WithStatus {
  return {
    name: "demo",
    installedVersion: "1.0.0",
    latestVersion: "2.0.0",
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
    dateConfidence: "authoritative",
    status: Hold.Held,
    sourceAgeDays: 5,
    holdDaysRemaining: 9,
    advisories: null,
    provenance: null,
    bypassReason: null,
    ...overrides,
  }
}

function commitISO(daysAgo: number): string {
  return `${new Date(NOW - daysAgo * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`
}

function ghCommit(
  version: string,
  daysAgo: number,
  shaFill = "a",
): {
  sha: string
  commit: { message: string; committer: { date: string } }
} {
  return {
    sha: shaFill.repeat(40),
    commit: { message: `demo ${version}`, committer: { date: commitISO(daysAgo) } },
  }
}

describe("resolveIntermediateUpgrades", () => {
  test("picks the highest version that satisfies the hold window", async () => {
    globalThis.fetch = mock(async () =>
      fakeResponse([
        ghCommit("1.0.5", 20, "a"),
        ghCommit("1.1.0", 60, "b"),
        ghCommit("1.9.0", 1, "c"), // too fresh — inside hold window
      ]),
    ) as unknown as typeof fetch
    const { intermediate, stillHeld } = await resolveIntermediateUpgrades([ws()], 14, NOW)
    expect(stillHeld).toEqual([])
    expect(intermediate).toHaveLength(1)
    expect(intermediate[0]!.version).toBe("1.1.0")
    expect(intermediate[0]!.effectiveTap).toBe("homebrew/core")
  })

  test("skips equal-to-latest entries", async () => {
    globalThis.fetch = mock(async () => fakeResponse([ghCommit("2.0.0", 30)])) as unknown as typeof fetch
    const { intermediate, stillHeld } = await resolveIntermediateUpgrades([ws()], 14, NOW)
    expect(intermediate).toEqual([])
    expect(stillHeld).toHaveLength(1)
  })

  test("non-Held statuses are routed to stillHeld without consulting history", async () => {
    let fetchCalls = 0
    globalThis.fetch = mock(async () => {
      fetchCalls++
      return fakeResponse([])
    }) as unknown as typeof fetch
    const { intermediate, stillHeld } = await resolveIntermediateUpgrades([ws({ status: Hold.AlwaysHold })], 14, NOW)
    expect(intermediate).toEqual([])
    expect(stillHeld).toHaveLength(1)
    expect(fetchCalls).toBe(0)
  })

  test("cold-brew/cold-brew packages are routed via recorded original tap", async () => {
    setOriginalTap("demo", "homebrew/core")
    const urls: string[] = []
    globalThis.fetch = mock(async (url: string) => {
      urls.push(url)
      return fakeResponse([ghCommit("1.1.0", 30)])
    }) as unknown as typeof fetch
    const { intermediate } = await resolveIntermediateUpgrades(
      [ws({ tap: "cold-brew/cold-brew", status: Hold.Ready })],
      14,
      NOW,
    )
    expect(intermediate[0]!.effectiveTap).toBe("homebrew/core")
    expect(urls[0]).toContain("Homebrew/homebrew-core")
  })

  test("missing latestVersion → stillHeld without history call", async () => {
    let fetchCalls = 0
    globalThis.fetch = mock(async () => {
      fetchCalls++
      return fakeResponse([])
    }) as unknown as typeof fetch
    const { intermediate, stillHeld } = await resolveIntermediateUpgrades([ws({ latestVersion: null })], 14, NOW)
    expect(intermediate).toEqual([])
    expect(stillHeld).toHaveLength(1)
    expect(fetchCalls).toBe(0)
  })

  test("cold-brew tap with NO recorded original: derives fallback AND records it", async () => {
    // No setOriginalTap call beforehand. Expect stepping to use the fallback
    // (homebrew/core for non-cask) and persist it to the DB.
    const { getOriginalTap } = await import("@db")
    expect(getOriginalTap("demo")).toBeNull()

    globalThis.fetch = mock(async () => fakeResponse([ghCommit("1.5.0", 30)])) as unknown as typeof fetch

    await resolveIntermediateUpgrades([ws({ tap: "cold-brew/cold-brew", status: Hold.Held })], 14, NOW)
    // Side effect: fallback tap got persisted
    expect(getOriginalTap("demo")).toBe("homebrew/core")
  })

  test("brewVersionHistory throwing → package stays held (catch path)", async () => {
    // Trigger a real throw from fetch — abort signal works.
    globalThis.fetch = mock(async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const { intermediate, stillHeld } = await resolveIntermediateUpgrades([ws()], 14, NOW)
    expect(intermediate).toEqual([])
    expect(stillHeld).toHaveLength(1)
  })

  test("parse-equal-but-string-different versions: compareVersions returns 0 (post-loop branch)", async () => {
    // Versions "1.5" and "1.5.0" are distinct strings — brewVersionHistory
    // doesn't dedupe them — but parseVersion yields identical arrays.
    // compareVersions then iterates the whole loop without a mismatch and
    // returns 0 at the trailing return.
    globalThis.fetch = mock(async () =>
      fakeResponse([
        { sha: "a".repeat(40), commit: { message: "demo 1.5", committer: { date: commitISO(30) } } },
        { sha: "b".repeat(40), commit: { message: "demo 1.5.0", committer: { date: commitISO(40) } } },
      ]),
    ) as unknown as typeof fetch
    const { intermediate } = await resolveIntermediateUpgrades([ws()], 14, NOW)
    expect(intermediate).toHaveLength(1)
    // Either version may win since they're parse-equal; just confirm we picked one.
    expect(["1.5", "1.5.0"]).toContain(intermediate[0]!.version)
  })

  test("'unknown' tap → stillHeld without history call", async () => {
    let fetchCalls = 0
    globalThis.fetch = mock(async () => {
      fetchCalls++
      return fakeResponse([])
    }) as unknown as typeof fetch
    const { intermediate, stillHeld } = await resolveIntermediateUpgrades([ws({ tap: "unknown" })], 14, NOW)
    expect(intermediate).toEqual([])
    expect(stillHeld).toHaveLength(1)
    expect(fetchCalls).toBe(0)
  })
})
