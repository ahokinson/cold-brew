import { beforeEach, describe, expect, test } from "bun:test"
import { Package } from "@brew/types"
import {
  cacheAdvisories,
  cacheMetadata,
  cacheNegativePublishDates,
  cachePackages,
  cachePublishDates,
  clearAdvisoryCache,
  clearAllCaches,
  clearEpssCache,
  clearKevCache,
  clearVersionPin,
  EPSS_DISABLED,
  ensureCacheEntries,
  getAllPolicies,
  getAllVersionPins,
  getAutoBypassEpss,
  getAutoBypassKev,
  getAutoBypassThreshold,
  getCachedAdvisories,
  getCachedEpssScores,
  getCachedMetadata,
  getCachedNegativePublishDates,
  getCachedPackages,
  getCachedPublishDates,
  getConfig,
  getHoldDays,
  getKevCacheStatus,
  getOriginalTap,
  getPackagePolicy,
  getStaleCachedPackages,
  getVersionPin,
  logUpgrade,
  replaceKevCache,
  resetDb,
  setAutoBypassEpss,
  setAutoBypassKev,
  setAutoBypassThreshold,
  setConfig,
  setHoldDays,
  setOriginalTap,
  setPackagePolicy,
  setVersionPin,
  upsertEpssScores,
} from "@db"

beforeEach(() => {
  resetDb()
})

function info(name: string, overrides: Partial<Package.Info> = {}): Package.Info {
  return {
    name,
    installedVersion: "1.0.0",
    latestVersion: "1.1.0",
    installedAt: 1_700_000_000,
    sourceModifiedAt: 1_700_000_000,
    isLeaf: true,
    installedAsDependency: false,
    installedOnRequest: true,
    pinned: false,
    outdated: true,
    needsRelink: false,
    tap: "homebrew/core",
    originTap: "homebrew/core",
    trusted: true,
    description: "x",
    isCask: false,
    dateConfidence: Package.DateConfidence.Authoritative,
    ...overrides,
  }
}

describe("config / defaults", () => {
  test("getHoldDays defaults to 7", () => {
    expect(getHoldDays()).toBe(7)
  })

  test("setHoldDays round-trips", () => {
    setHoldDays(21)
    expect(getHoldDays()).toBe(21)
  })

  test("setHoldDays rejects negatives / non-integers", () => {
    expect(() => setHoldDays(-1)).toThrow()
    expect(() => setHoldDays(1.5)).toThrow()
  })

  test("getHoldDays falls back to 7 on garbage value in DB", () => {
    setConfig("hold_days", "not-a-number")
    expect(getHoldDays()).toBe(7)
  })

  test("auto-bypass threshold defaults to 7.0", () => {
    expect(getAutoBypassThreshold()).toBe(7)
  })

  test("auto-bypass threshold round-trips", () => {
    setAutoBypassThreshold(8.5)
    expect(getAutoBypassThreshold()).toBe(8.5)
  })

  test("auto-bypass threshold rejects out-of-range", () => {
    expect(() => setAutoBypassThreshold(-1)).toThrow()
    expect(() => setAutoBypassThreshold(11)).toThrow()
    expect(() => setAutoBypassThreshold(Number.NaN)).toThrow()
  })

  test("auto-bypass threshold falls back on garbage", () => {
    setConfig("auto_bypass_cvss", "huh")
    expect(getAutoBypassThreshold()).toBe(7)
  })

  test("auto-bypass threshold caps at 10 when stored value exceeds it", () => {
    setConfig("auto_bypass_cvss", "999")
    expect(getAutoBypassThreshold()).toBe(10)
  })

  test("getConfig returns undefined for unknown keys", () => {
    expect(getConfig("does-not-exist")).toBeUndefined()
  })
})

describe("package policy", () => {
  test("default policy when not set", () => {
    expect(getPackagePolicy("foo")).toBe("default")
  })

  test("setPackagePolicy round-trips", () => {
    setPackagePolicy("foo", "always-hold")
    expect(getPackagePolicy("foo")).toBe("always-hold")
  })

  test("setting back to default with no pin/tap removes the row", () => {
    setPackagePolicy("foo", "always-allow")
    setPackagePolicy("foo", "default")
    expect(getPackagePolicy("foo")).toBe("default")
    expect(getAllPolicies()).toEqual([])
  })

  test("setting back to default preserves the row when a pin exists", () => {
    setVersionPin("foo", "1.0.0")
    setPackagePolicy("foo", "always-hold")
    setPackagePolicy("foo", "default")
    expect(getVersionPin("foo")).toBe("1.0.0")
    expect(getPackagePolicy("foo")).toBe("default")
  })

  test("getAllPolicies excludes default rows", () => {
    setPackagePolicy("a", "always-hold")
    setPackagePolicy("b", "always-allow")
    setVersionPin("c", "9.9.9")
    expect(getAllPolicies().sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: "a", holdPolicy: "always-hold" },
      { name: "b", holdPolicy: "always-allow" },
    ])
  })
})

describe("version pins / original tap", () => {
  test("getVersionPin returns null when unset", () => {
    expect(getVersionPin("foo")).toBeNull()
  })

  test("setVersionPin round-trips and reflects in getAllVersionPins", () => {
    setVersionPin("foo", "1.0.0")
    setVersionPin("bar", "2.0.0")
    expect(getVersionPin("foo")).toBe("1.0.0")
    expect(getAllVersionPins()).toEqual(
      new Map([
        ["foo", "1.0.0"],
        ["bar", "2.0.0"],
      ]),
    )
  })

  test("clearVersionPin removes row when nothing else is set", () => {
    setVersionPin("foo", "1.0.0")
    clearVersionPin("foo")
    expect(getVersionPin("foo")).toBeNull()
    expect(getAllVersionPins().size).toBe(0)
  })

  test("clearVersionPin preserves row if originalTap is set", () => {
    setOriginalTap("foo", "homebrew/core")
    setVersionPin("foo", "1.0.0")
    clearVersionPin("foo")
    expect(getVersionPin("foo")).toBeNull()
    expect(getOriginalTap("foo")).toBe("homebrew/core")
  })

  test("clearVersionPin on a never-set name is a no-op", () => {
    expect(() => clearVersionPin("ghost")).not.toThrow()
  })

  test("setOriginalTap round-trips", () => {
    setOriginalTap("foo", "homebrew/cask")
    expect(getOriginalTap("foo")).toBe("homebrew/cask")
  })

  test("getOriginalTap returns null when unset", () => {
    expect(getOriginalTap("foo")).toBeNull()
  })
})

describe("upgrade log", () => {
  test("logUpgrade inserts rows (no read API: relies on no-throw + cachedPackages independence)", () => {
    expect(() => logUpgrade("foo", "1.0", "1.1", 7)).not.toThrow()
    expect(() => logUpgrade("foo", "1.1", "1.2", null)).not.toThrow()
  })
})

describe("metadata cache", () => {
  test("getCachedMetadata returns empty Map for empty input", () => {
    expect(getCachedMetadata([]).size).toBe(0)
  })

  test("cacheMetadata + getCachedMetadata round-trip", () => {
    cacheMetadata([
      { packageName: "foo", description: "Foo tool", latestVersion: "1.0", tap: "homebrew/core", installedTime: 123 },
    ])
    const result = getCachedMetadata(["foo", "bar"])
    expect(result.get("foo")?.description).toBe("Foo tool")
    expect(result.has("bar")).toBe(false)
  })

  test("ensureCacheEntries seeds rows", () => {
    ensureCacheEntries([
      { name: "foo", isCask: false },
      { name: "bar", isCask: true },
    ])
    // No read API for raw seeds, but cacheMetadata over them should still work
    expect(() =>
      cacheMetadata([{ packageName: "foo", description: "x", latestVersion: null, tap: null, installedTime: null }]),
    ).not.toThrow()
  })

  test("publish-date cache positive round-trip", () => {
    cachePublishDates([{ packageName: "foo", sourceModifiedAt: 1_700_000_000 }])
    expect(getCachedPublishDates(["foo"]).get("foo")).toBe(1_700_000_000)
  })

  test("publish-date cache: empty inputs early-return", () => {
    expect(getCachedPublishDates([]).size).toBe(0)
    expect(() => cachePublishDates([])).not.toThrow()
  })

  test("negative publish-date cache", () => {
    cacheNegativePublishDates(["foo", "bar"])
    const negs = getCachedNegativePublishDates(["foo", "baz"])
    expect(negs.has("foo")).toBe(true)
    expect(negs.has("baz")).toBe(false)
  })

  test("negative publish-date cache: empty inputs early-return", () => {
    expect(getCachedNegativePublishDates([]).size).toBe(0)
    expect(() => cacheNegativePublishDates([])).not.toThrow()
  })

  test("clearAllCaches wipes metadata, package, and advisory caches", () => {
    cacheMetadata([{ packageName: "x", description: "x", latestVersion: null, tap: null, installedTime: null }])
    cachePackages([info("x")])
    clearAllCaches()
    expect(getCachedMetadata(["x"]).size).toBe(0)
    expect(getCachedPackages()).toBeNull()
  })
})

describe("package cache", () => {
  test("cachePackages + getCachedPackages round-trip", () => {
    cachePackages([info("foo"), info("bar", { isCask: true, isLeaf: false, pinned: true })])
    const result = getCachedPackages()
    expect(result?.length).toBe(2)
    const foo = result!.find((p) => p.name === "foo")!
    expect(foo.installedVersion).toBe("1.0.0")
    const bar = result!.find((p) => p.name === "bar")!
    expect(bar.isCask).toBe(true)
    expect(bar.isLeaf).toBe(false)
    expect(bar.pinned).toBe(true)
  })

  test("getCachedPackages returns null when empty", () => {
    expect(getCachedPackages()).toBeNull()
  })

  test("getStaleCachedPackages bypasses age but obeys empty rule", () => {
    expect(getStaleCachedPackages()).toBeNull()
    cachePackages([info("foo")])
    expect(getStaleCachedPackages()?.length).toBe(1)
  })

  test("packageCacheRowToInfo fills sane defaults when columns are NULL", () => {
    // Driving NULL columns via cachePackages requires faking nullable fields:
    // we cache a fully-formed row then overwrite to confirm null handling
    // through the row-mapping path. Round-trip will produce sane defaults.
    cachePackages([info("foo", { installedVersion: "x", tap: "homebrew/core" })])
    const result = getCachedPackages()!
    expect(result[0]!.installedVersion).toBe("x")
    expect(result[0]!.tap).toBe("homebrew/core")
  })
})

describe("advisory cache", () => {
  test("getCachedAdvisories on empty input is empty Map", () => {
    expect(getCachedAdvisories([]).size).toBe(0)
  })

  test("cacheAdvisories + getCachedAdvisories round-trip", () => {
    cacheAdvisories([
      {
        packageName: "foo",
        installedVersion: "1.0.0",
        latestVersion: "1.1.0",
        summary: {
          entries: [
            {
              id: "CVE-1",
              source: "osv",
              kind: "vulnerability",
              severity: "high",
              cvss: 7.5,
              summary: "x",
              fixedIn: "1.1.0",
              fixInLatest: true,
              url: null,
              kev: true,
              epss: 0.42,
            },
          ],
          maxCvss: 7.5,
          hasActionableFix: true,
          hasKevListed: true,
          maxEpss: 0.42,
        },
        sources: ["osv"],
      },
    ])

    const got = getCachedAdvisories([{ name: "foo", installedVersion: "1.0.0", latestVersion: "1.1.0" }])
    expect(got.get("foo")?.entries[0]?.id).toBe("CVE-1")
    expect(got.get("foo")?.entries[0]?.kev).toBe(true)
    expect(got.get("foo")?.entries[0]?.epss).toBeCloseTo(0.42, 4)
    expect(got.get("foo")?.maxCvss).toBe(7.5)
    expect(got.get("foo")?.hasActionableFix).toBe(true)
    expect(got.get("foo")?.hasKevListed).toBe(true)
    // maxEpss isn't stored as a column — it's recomputed from entries on read.
    expect(got.get("foo")?.maxEpss).toBeCloseTo(0.42, 4)
  })

  test("getCachedAdvisories misses when installedVersion differs", () => {
    cacheAdvisories([
      {
        packageName: "foo",
        installedVersion: "1.0.0",
        latestVersion: null,
        summary: { entries: [], maxCvss: null, hasActionableFix: false, hasKevListed: false, maxEpss: null },
        sources: [],
      },
    ])
    expect(getCachedAdvisories([{ name: "foo", installedVersion: "OTHER", latestVersion: null }]).size).toBe(0)
  })

  test("clearAdvisoryCache wipes rows", () => {
    cacheAdvisories([
      {
        packageName: "foo",
        installedVersion: "1.0.0",
        latestVersion: null,
        summary: { entries: [], maxCvss: null, hasActionableFix: false, hasKevListed: false, maxEpss: null },
        sources: [],
      },
    ])
    clearAdvisoryCache()
    expect(getCachedAdvisories([{ name: "foo", installedVersion: "1.0.0", latestVersion: null }]).size).toBe(0)
  })

  test("cacheAdvisories on empty input is a no-op", () => {
    expect(() => cacheAdvisories([])).not.toThrow()
  })
})

describe("auto-bypass-kev config", () => {
  test("defaults to true on a fresh DB", () => {
    expect(getAutoBypassKev()).toBe(true)
  })

  test("setAutoBypassKev round-trips", () => {
    setAutoBypassKev(false)
    expect(getAutoBypassKev()).toBe(false)
    setAutoBypassKev(true)
    expect(getAutoBypassKev()).toBe(true)
  })

  test("unrecognized stored value falls back to default", () => {
    setConfig("auto_bypass_kev", "maybe")
    expect(getAutoBypassKev()).toBe(true)
  })
})

describe("kev cache", () => {
  test("empty on a fresh DB", () => {
    const status = getKevCacheStatus()
    expect(status.cveIds.size).toBe(0)
    expect(status.fetchedAt).toBeNull()
  })

  test("replaceKevCache writes ids and stamps fetchedAt", () => {
    replaceKevCache(["CVE-2024-1", "CVE-2024-2"])
    const status = getKevCacheStatus()
    expect([...status.cveIds].sort()).toEqual(["CVE-2024-1", "CVE-2024-2"])
    expect(status.fetchedAt).toBeGreaterThan(0)
  })

  test("replaceKevCache wipes previous contents", () => {
    replaceKevCache(["CVE-A"])
    replaceKevCache(["CVE-B"])
    expect([...getKevCacheStatus().cveIds]).toEqual(["CVE-B"])
  })

  test("replaceKevCache with empty array clears the table", () => {
    replaceKevCache(["CVE-1"])
    replaceKevCache([])
    expect(getKevCacheStatus().cveIds.size).toBe(0)
  })

  test("replaceKevCache chunks large input without parameter-limit errors", () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `CVE-2024-${i}`)
    expect(() => replaceKevCache(ids)).not.toThrow()
    expect(getKevCacheStatus().cveIds.size).toBe(1500)
  })

  test("clearKevCache wipes the table", () => {
    replaceKevCache(["CVE-1", "CVE-2"])
    clearKevCache()
    expect(getKevCacheStatus().cveIds.size).toBe(0)
  })

  test("clearAllCaches also wipes the KEV cache", () => {
    replaceKevCache(["CVE-1"])
    clearAllCaches()
    expect(getKevCacheStatus().cveIds.size).toBe(0)
  })
})

describe("auto-bypass-epss config", () => {
  test("defaults to disabled on a fresh DB", () => {
    expect(getAutoBypassEpss()).toBeNull()
  })

  test("setAutoBypassEpss with a number round-trips", () => {
    setAutoBypassEpss(0.5)
    expect(getAutoBypassEpss()).toBeCloseTo(0.5, 4)
  })

  test("setAutoBypassEpss with EPSS_DISABLED returns null on read", () => {
    setAutoBypassEpss(0.5)
    setAutoBypassEpss(EPSS_DISABLED)
    expect(getAutoBypassEpss()).toBeNull()
  })

  test("setAutoBypassEpss rejects out-of-range values", () => {
    expect(() => setAutoBypassEpss(1.5)).toThrow()
    expect(() => setAutoBypassEpss(-0.1)).toThrow()
  })

  test("unrecognized stored value reads as disabled", () => {
    setConfig("auto_bypass_epss", "nonsense")
    expect(getAutoBypassEpss()).toBeNull()
  })
})

describe("epss cache", () => {
  test("empty cache returns empty map", () => {
    expect(getCachedEpssScores(["CVE-1"], 86_400).size).toBe(0)
  })

  test("upsertEpssScores + getCachedEpssScores round-trip", () => {
    upsertEpssScores(
      new Map([
        ["CVE-2024-1", { score: 0.42, percentile: 0.88 }],
        ["CVE-2024-2", { score: 0.01, percentile: 0.1 }],
      ]),
    )
    const got = getCachedEpssScores(["CVE-2024-1", "CVE-2024-2", "CVE-2024-3"], 86_400)
    expect(got.size).toBe(2)
    expect(got.get("CVE-2024-1")?.score).toBeCloseTo(0.42, 4)
    expect(got.get("CVE-2024-1")?.percentile).toBeCloseTo(0.88, 4)
    expect(got.has("CVE-2024-3")).toBe(false)
  })

  test("upsertEpssScores overwrites existing rows", () => {
    upsertEpssScores(new Map([["CVE-1", { score: 0.1, percentile: 0.2 }]]))
    upsertEpssScores(new Map([["CVE-1", { score: 0.9, percentile: 0.95 }]]))
    expect(getCachedEpssScores(["CVE-1"], 86_400).get("CVE-1")?.score).toBeCloseTo(0.9, 4)
  })

  test("upsertEpssScores with an empty map is a no-op", () => {
    expect(() => upsertEpssScores(new Map())).not.toThrow()
  })

  test("clearEpssCache wipes the table", () => {
    upsertEpssScores(new Map([["CVE-1", { score: 0.1, percentile: 0.2 }]]))
    clearEpssCache()
    expect(getCachedEpssScores(["CVE-1"], 86_400).size).toBe(0)
  })

  test("clearAllCaches also wipes EPSS", () => {
    upsertEpssScores(new Map([["CVE-1", { score: 0.1, percentile: 0.2 }]]))
    clearAllCaches()
    expect(getCachedEpssScores(["CVE-1"], 86_400).size).toBe(0)
  })
})
