import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { getEpssScores, resetEpssFetcher, setEpssFetcher } from "@brew/epss"
import { getDb, resetDb, upsertEpssScores } from "@db"
import { sql } from "drizzle-orm"

function backdateEpssCache(daysAgo: number): void {
  getDb().run(sql.raw(`UPDATE epss_cache SET fetched_at = unixepoch() - 86400 * ${daysAgo}`))
}

beforeEach(() => {
  resetDb()
  resetEpssFetcher()
})

afterEach(() => {
  resetEpssFetcher()
})

describe("getEpssScores", () => {
  test("returns empty map when no CVE ids are supplied", async () => {
    setEpssFetcher(async () => {
      throw new Error("should not be called")
    })
    const result = await getEpssScores([])
    expect(result.size).toBe(0)
  })

  test("filters out non-CVE ids before fetching", async () => {
    let called: readonly string[] = []
    setEpssFetcher(async (ids) => {
      called = ids
      return new Map(ids.map((id) => [id, { score: 0.1, percentile: 0.5 }]))
    })
    const result = await getEpssScores(["GHSA-aaaa-bbbb", "MAL-2024-1", "CVE-2024-1"])
    expect([...called]).toEqual(["CVE-2024-1"])
    expect(result.has("GHSA-aaaa-bbbb")).toBe(false)
    expect(result.get("CVE-2024-1")?.score).toBeCloseTo(0.1, 4)
  })

  test("caches results and skips refetch within the 24h TTL", async () => {
    let calls = 0
    setEpssFetcher(async (ids) => {
      calls++
      return new Map(ids.map((id) => [id, { score: 0.42, percentile: 0.9 }]))
    })
    await getEpssScores(["CVE-2024-1"])
    await getEpssScores(["CVE-2024-1"])
    expect(calls).toBe(1)
  })

  test("refetches when the cache row is older than 24h", async () => {
    upsertEpssScores(new Map([["CVE-2024-1", { score: 0.1, percentile: 0.5 }]]))
    backdateEpssCache(2)

    let calls = 0
    setEpssFetcher(async (ids) => {
      calls++
      return new Map(ids.map((id) => [id, { score: 0.99, percentile: 0.99 }]))
    })
    const result = await getEpssScores(["CVE-2024-1"])
    expect(calls).toBe(1)
    expect(result.get("CVE-2024-1")?.score).toBeCloseTo(0.99, 4)
  })

  test("falls back to cached subset on network failure", async () => {
    upsertEpssScores(new Map([["CVE-2024-1", { score: 0.5, percentile: 0.7 }]]))
    setEpssFetcher(async () => {
      throw new Error("network down")
    })

    // CVE-2024-2 missing from cache → fetch fails → result only has the
    // CVE-2024-1 entry; we don't blow up the whole advisory pass.
    const result = await getEpssScores(["CVE-2024-1", "CVE-2024-2"])
    expect(result.get("CVE-2024-1")?.score).toBeCloseTo(0.5, 4)
    expect(result.has("CVE-2024-2")).toBe(false)
  })

  test("returns empty map when fetch fails with no prior cache", async () => {
    setEpssFetcher(async () => {
      throw new Error("network down")
    })
    const result = await getEpssScores(["CVE-2024-1"])
    expect(result.size).toBe(0)
  })

  test("dedupes input CVE ids", async () => {
    let called: readonly string[] = []
    setEpssFetcher(async (ids) => {
      called = ids
      return new Map(ids.map((id) => [id, { score: 0.3, percentile: 0.6 }]))
    })
    await getEpssScores(["CVE-2024-1", "CVE-2024-1", "CVE-2024-1"])
    expect([...called]).toEqual(["CVE-2024-1"])
  })
})
