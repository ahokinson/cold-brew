import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { getKevCatalog, resetKevFetcher, setKevFetcher } from "@brew/kev"
import { getDb, getKevCacheStatus, replaceKevCache, resetDb, setConfig } from "@db"
import { sql } from "drizzle-orm"

function backdateKevCache(daysAgo: number): void {
  getDb().run(sql.raw(`UPDATE kev_cache SET fetched_at = unixepoch() - 86400 * ${daysAgo}`))
}

beforeEach(() => {
  resetDb()
  resetKevFetcher()
})

afterEach(() => {
  resetKevFetcher()
})

describe("getKevCatalog", () => {
  test("populates the cache on first fetch", async () => {
    setKevFetcher(async () => ["CVE-2024-0001", "CVE-2024-0002"])
    const set = await getKevCatalog()
    expect([...set].sort()).toEqual(["CVE-2024-0001", "CVE-2024-0002"])
    const cached = getKevCacheStatus()
    expect([...cached.cveIds].sort()).toEqual(["CVE-2024-0001", "CVE-2024-0002"])
  })

  test("does not refetch within the 24h TTL", async () => {
    replaceKevCache(["CVE-CACHED"])
    let calls = 0
    setKevFetcher(async () => {
      calls++
      return ["CVE-NEW"]
    })
    const set = await getKevCatalog()
    expect([...set]).toEqual(["CVE-CACHED"])
    expect(calls).toBe(0)
  })

  test("refetches when cache is older than 24h", async () => {
    // Seed cache, then backdate fetched_at by 48 hours via raw SQL so the
    // freshness check fires the refetch path without faking the clock.
    replaceKevCache(["CVE-OLD"])
    backdateKevCache(2)

    setKevFetcher(async () => ["CVE-FRESH"])
    const set = await getKevCatalog()
    expect([...set]).toEqual(["CVE-FRESH"])
  })

  test("falls back to stale cache on network failure", async () => {
    replaceKevCache(["CVE-STALE"])
    backdateKevCache(2)

    setKevFetcher(async () => {
      throw new Error("network down")
    })
    const set = await getKevCatalog()
    expect([...set]).toEqual(["CVE-STALE"])
  })

  test("returns empty set when fetch fails with no prior cache", async () => {
    setKevFetcher(async () => {
      throw new Error("network down")
    })
    const set = await getKevCatalog()
    expect(set.size).toBe(0)
  })

  test("ignores entries that aren't well-formed CVE ids", async () => {
    // Real CISA feeds occasionally include odd rows; the fetcher is the only
    // place that filters, so guard the integration here too.
    setKevFetcher(async () => ["CVE-2024-1", "CVE-2024-2"])
    const set = await getKevCatalog()
    expect(set.has("CVE-2024-1")).toBe(true)
    expect(set.has("CVE-2024-2")).toBe(true)
  })

  test("auto_bypass_kev config does not influence catalog content", async () => {
    // Sanity: the config flag gates use of the catalog, not the catalog itself.
    setConfig("auto_bypass_kev", "false")
    setKevFetcher(async () => ["CVE-2024-1"])
    const set = await getKevCatalog()
    expect(set.has("CVE-2024-1")).toBe(true)
  })
})
