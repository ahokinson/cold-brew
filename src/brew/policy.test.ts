import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  evaluateAllPackages,
  evaluateHoldStatus,
  formatAgeDays,
  formatHoldReason,
  getSourceAgeDays,
  isPlausibleSourceTime,
  isVersionAhead,
  parseVersion,
  partitionUpgrade,
  type UpgradePartition,
} from "@brew/policy"
import { Advisory, Hold, Package } from "@brew/types"

const FIXED_NOW = Date.UTC(2026, 4, 11, 12, 0, 0) // 2026-05-11T12:00:00Z
const realNow = Date.now

beforeAll(() => {
  Date.now = () => FIXED_NOW
})
afterAll(() => {
  Date.now = realNow
})

function dayOffset(daysAgo: number): number {
  return Math.floor((FIXED_NOW - daysAgo * 86_400_000) / 1000)
}

function pkg(overrides: Partial<Package.Info> = {}): Package.Info {
  return {
    name: "demo",
    installedVersion: "1.0.0",
    latestVersion: "1.1.0",
    installedAt: dayOffset(60),
    sourceModifiedAt: dayOffset(20),
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
    advisories: null,
    ...overrides,
  }
}

describe("parseVersion", () => {
  test("splits dotted version and appends 0 revision", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3, 0])
  })

  test("parses revision after underscore", () => {
    expect(parseVersion("8.1_1")).toEqual([8, 1, 1])
  })

  test("treats non-numeric parts as 0", () => {
    expect(parseVersion("1.a.3")).toEqual([1, 0, 3, 0])
    expect(parseVersion("1.0_x")).toEqual([1, 0, 0])
  })

  test("handles empty string", () => {
    expect(parseVersion("")).toEqual([0, 0])
  })
})

describe("isVersionAhead", () => {
  test.each<[string, string, boolean]>([
    ["1.2.0", "1.1.9", true],
    ["1.1.9", "1.2.0", false],
    ["1.2.0", "1.2.0", false],
    ["2.0.0", "1.99.99", true],
    ["1.2.0_2", "1.2.0_1", true],
    ["1.2.0_0", "1.2.0", false],
  ])("isVersionAhead(%s, %s) === %s", (a, b, expected) => {
    expect(isVersionAhead(a, b)).toBe(expected)
  })
})

describe("getSourceAgeDays", () => {
  test("returns 0 for non-finite or non-positive input", () => {
    expect(getSourceAgeDays(0)).toBe(0)
    expect(getSourceAgeDays(-1)).toBe(0)
    expect(getSourceAgeDays(NaN)).toBe(0)
  })

  test("returns floor days since UTC midnight of modified date", () => {
    expect(getSourceAgeDays(dayOffset(7))).toBe(7)
    expect(getSourceAgeDays(dayOffset(0))).toBe(0)
    expect(getSourceAgeDays(dayOffset(365))).toBe(365)
  })
})

describe("isPlausibleSourceTime", () => {
  const npmEpoch = Math.floor(Date.parse("1985-10-26T08:15:00.000Z") / 1000)
  const zipEpoch = Math.floor(Date.parse("1980-01-01T00:00:00.000Z") / 1000)

  test("rejects reproducible-build sentinel mtimes", () => {
    expect(isPlausibleSourceTime(npmEpoch)).toBe(false) // playwright-cli's npm tarball
    expect(isPlausibleSourceTime(zipEpoch)).toBe(false)
    expect(isPlausibleSourceTime(0)).toBe(false)
    expect(isPlausibleSourceTime(NaN)).toBe(false)
  })

  test("accepts real release dates", () => {
    expect(isPlausibleSourceTime(Math.floor(Date.parse("2024-01-15T00:00:00Z") / 1000))).toBe(true)
    expect(isPlausibleSourceTime(dayOffset(20))).toBe(true)
  })
})

describe("formatAgeDays", () => {
  test.each<[number, string]>([
    [0, "0d"],
    [1, "1d"],
    [29, "29d"],
    [30, "1m 0d"],
    [45, "1m 15d"],
    [364, "12m 4d"],
    [365, "1y 0m"],
    [400, "1y 1m"],
    [2 * 365 + 90, "2y 3m"],
  ])("formatAgeDays(%i) === %s", (d, expected) => {
    expect(formatAgeDays(d)).toBe(expected)
  })
})

describe("evaluateHoldStatus", () => {
  test("UpToDate when not outdated and no overriding policy", () => {
    const result = evaluateHoldStatus(pkg({ outdated: false }), 14, "default", null)
    expect(result.status).toBe(Hold.UpToDate)
    expect(result.bypassReason).toBeNull()
  })

  test("Ready when outdated and past hold window", () => {
    const result = evaluateHoldStatus(pkg({ sourceModifiedAt: dayOffset(30) }), 14, "default", null)
    expect(result.status).toBe(Hold.Ready)
    expect(result.sourceAgeDays).toBe(30)
    expect(result.holdDaysRemaining).toBe(0)
  })

  test("Held when within hold window", () => {
    const result = evaluateHoldStatus(pkg({ sourceModifiedAt: dayOffset(5) }), 14, "default", null)
    expect(result.status).toBe(Hold.Held)
    expect(result.holdDaysRemaining).toBe(9)
  })

  test("BrewPinned wins over Held but loses to ColdBrewPinned", () => {
    const heldPinned = evaluateHoldStatus(pkg({ pinned: true, sourceModifiedAt: dayOffset(2) }), 14, "default", null)
    expect(heldPinned.status).toBe(Hold.BrewPinned)
    const versionPinned = evaluateHoldStatus(pkg({ pinned: true }), 14, "default", "1.0.0")
    expect(versionPinned.status).toBe(Hold.ColdBrewPinned)
  })

  test("AlwaysHold overrides Ready, AlwaysAllow overrides Held", () => {
    const aHold = evaluateHoldStatus(pkg({ sourceModifiedAt: dayOffset(99) }), 14, "always-hold", null)
    expect(aHold.status).toBe(Hold.AlwaysHold)
    const aAllow = evaluateHoldStatus(pkg({ sourceModifiedAt: dayOffset(1) }), 14, "always-allow", null)
    expect(aAllow.status).toBe(Hold.AlwaysAllow)
  })

  test("AheadOfUpstream when installed > latest and still marked outdated", () => {
    const result = evaluateHoldStatus(
      pkg({ installedVersion: "2.0.0", latestVersion: "1.9.0", outdated: true }),
      14,
      "default",
      null,
    )
    expect(result.status).toBe(Hold.AheadOfUpstream)
  })

  test("ColdBrewPinned wins when version pin matches installed", () => {
    const result = evaluateHoldStatus(pkg(), 14, "default", "1.0.0")
    expect(result.status).toBe(Hold.ColdBrewPinned)
  })

  test("cold-brew tap with version pin → ColdBrewPinned", () => {
    const result = evaluateHoldStatus(
      pkg({ tap: "cold-brew/cold-brew", installedVersion: "0.9", latestVersion: "1.0" }),
      14,
      "default",
      "9.9.9", // not equal to installed; falls through to tap branch
    )
    expect(result.status).toBe(Hold.ColdBrewPinned)
  })

  test("falls back to installedAt when sourceModifiedAt is missing", () => {
    const result = evaluateHoldStatus(pkg({ sourceModifiedAt: 0, installedAt: dayOffset(40) }), 14, "default", null)
    expect(result.sourceAgeDays).toBe(40)
    expect(result.status).toBe(Hold.Ready)
  })

  test("auto-bypass promotes Held → Ready with cvss reason", () => {
    const advisories: Advisory.Summary = {
      entries: [
        {
          id: "CVE-2024-0001",
          source: Advisory.Source.Osv,
          kind: Advisory.Kind.Vulnerability,
          severity: Advisory.Severity.Critical,
          cvss: 9.8,
          summary: "RCE",
          fixedIn: "1.1.0",
          fixInLatest: true,
          url: null,
          kev: false,
          epss: null,
        },
      ],
      maxCvss: 9.8,
      hasActionableFix: true,
      hasKevListed: false,
      maxEpss: null,
    }
    const result = evaluateHoldStatus(pkg({ sourceModifiedAt: dayOffset(2), advisories }), 14, "default", null, 7.0)
    expect(result.status).toBe(Hold.Ready)
    expect(result.bypassReason).toBe("cvss")
  })

  test("auto-bypass never overrides AlwaysHold / BrewPinned / ColdBrewPinned", () => {
    const advisories: Advisory.Summary = {
      entries: [],
      maxCvss: 10,
      hasActionableFix: true,
      hasKevListed: false,
      maxEpss: null,
    }
    const alwaysHold = evaluateHoldStatus(pkg({ advisories }), 14, "always-hold", null, 0)
    expect(alwaysHold.status).toBe(Hold.AlwaysHold)
    expect(alwaysHold.bypassReason).toBeNull()
    const brewPinned = evaluateHoldStatus(pkg({ pinned: true, advisories }), 14, "default", null, 0)
    expect(brewPinned.status).toBe(Hold.BrewPinned)
  })

  test("auto-bypass requires hasActionableFix and threshold", () => {
    const advisories: Advisory.Summary = {
      entries: [],
      maxCvss: 5,
      hasActionableFix: false,
      hasKevListed: false,
      maxEpss: null,
    }
    const noFix = evaluateHoldStatus(pkg({ sourceModifiedAt: dayOffset(1), advisories }), 14, "default", null, 4.0)
    expect(noFix.status).toBe(Hold.Held)
    const belowThreshold = evaluateHoldStatus(
      pkg({ sourceModifiedAt: dayOffset(1), advisories: { ...advisories, hasActionableFix: true } }),
      14,
      "default",
      null,
      9.0,
    )
    expect(belowThreshold.status).toBe(Hold.Held)
  })

  // KEV signal: independent from CVSS threshold. Auto-bypass-kev must be on,
  // hasKevListed must be true, and a fix must exist. KEV wins precedence
  // when both signals trigger because it's the more specific reason.
  describe("auto-bypass-kev", () => {
    function kevAdvisories(overrides: Partial<Advisory.Summary> = {}): Advisory.Summary {
      return {
        entries: [
          {
            id: "CVE-2024-9999",
            source: Advisory.Source.Osv,
            kind: Advisory.Kind.Vulnerability,
            severity: Advisory.Severity.High,
            cvss: 5.0,
            summary: "actively exploited",
            fixedIn: "1.1.0",
            fixInLatest: true,
            url: null,
            kev: true,
            epss: null,
          },
        ],
        maxCvss: 5.0,
        hasActionableFix: true,
        hasKevListed: true,
        maxEpss: null,
        ...overrides,
      }
    }

    test("KEV-listed below CVSS threshold bypasses when autoBypassKev=true", () => {
      const result = evaluateHoldStatus(
        pkg({ sourceModifiedAt: dayOffset(2), advisories: kevAdvisories() }),
        14,
        "default",
        null,
        7.0, // CVSS would not trigger (5.0 < 7.0)
        true,
      )
      expect(result.status).toBe(Hold.Ready)
      expect(result.bypassReason).toBe("kev")
    })

    test("KEV-listed stays held when autoBypassKev=false", () => {
      const result = evaluateHoldStatus(
        pkg({ sourceModifiedAt: dayOffset(2), advisories: kevAdvisories() }),
        14,
        "default",
        null,
        7.0,
        false,
      )
      expect(result.status).toBe(Hold.Held)
      expect(result.bypassReason).toBeNull()
    })

    test("KEV wins precedence over CVSS when both trigger", () => {
      const advisories = kevAdvisories({ maxCvss: 9.8 })
      const result = evaluateHoldStatus(
        pkg({ sourceModifiedAt: dayOffset(2), advisories }),
        14,
        "default",
        null,
        7.0, // CVSS would also trigger
        true,
      )
      expect(result.status).toBe(Hold.Ready)
      expect(result.bypassReason).toBe("kev")
    })

    test("non-KEV above CVSS threshold still gets cvss reason", () => {
      const advisories = kevAdvisories({ hasKevListed: false, maxCvss: 9.8 })
      const result = evaluateHoldStatus(
        pkg({ sourceModifiedAt: dayOffset(2), advisories }),
        14,
        "default",
        null,
        7.0,
        true,
      )
      expect(result.status).toBe(Hold.Ready)
      expect(result.bypassReason).toBe("cvss")
    })

    test("KEV without actionable fix stays held", () => {
      const advisories = kevAdvisories({ hasActionableFix: false })
      const result = evaluateHoldStatus(
        pkg({ sourceModifiedAt: dayOffset(2), advisories }),
        14,
        "default",
        null,
        Number.POSITIVE_INFINITY,
        true,
      )
      expect(result.status).toBe(Hold.Held)
    })

    test("evaluateAllPackages threads autoBypassKev through", () => {
      const packages = [
        pkg({
          name: "kevpkg",
          sourceModifiedAt: dayOffset(2),
          advisories: kevAdvisories(),
        }),
      ]
      const result = evaluateAllPackages(
        packages,
        14,
        () => "default",
        () => null,
        Number.POSITIVE_INFINITY,
        true,
      )
      expect(result[0]!.bypassReason).toBe("kev")
    })
  })

  // EPSS signal: configurable threshold (0–1) drives an independent bypass
  // path. Sits between KEV and CVSS in precedence — predicted exploitation
  // is stronger than theoretical severity but weaker than confirmed.
  describe("auto-bypass-epss", () => {
    function epssAdvisories(overrides: Partial<Advisory.Summary> = {}): Advisory.Summary {
      return {
        entries: [
          {
            id: "CVE-2024-9999",
            source: Advisory.Source.Osv,
            kind: Advisory.Kind.Vulnerability,
            severity: Advisory.Severity.Medium,
            cvss: 5.0,
            summary: "predicted exploitation",
            fixedIn: "1.1.0",
            fixInLatest: true,
            url: null,
            kev: false,
            epss: 0.72,
          },
        ],
        maxCvss: 5.0,
        hasActionableFix: true,
        hasKevListed: false,
        maxEpss: 0.72,
        ...overrides,
      }
    }

    test("EPSS at or above threshold bypasses with reason=epss", () => {
      const result = evaluateHoldStatus(
        pkg({ sourceModifiedAt: dayOffset(2), advisories: epssAdvisories() }),
        14,
        "default",
        null,
        9.0, // CVSS would not trigger
        false, // KEV disabled
        0.5, // EPSS threshold
      )
      expect(result.status).toBe(Hold.Ready)
      expect(result.bypassReason).toBe("epss")
    })

    test("EPSS below threshold stays held", () => {
      const result = evaluateHoldStatus(
        pkg({ sourceModifiedAt: dayOffset(2), advisories: epssAdvisories({ maxEpss: 0.1 }) }),
        14,
        "default",
        null,
        9.0,
        false,
        0.5,
      )
      expect(result.status).toBe(Hold.Held)
    })

    test("EPSS disabled (null threshold) means no EPSS bypass even when score is high", () => {
      const result = evaluateHoldStatus(
        pkg({ sourceModifiedAt: dayOffset(2), advisories: epssAdvisories() }),
        14,
        "default",
        null,
        9.0,
        false,
        null,
      )
      expect(result.status).toBe(Hold.Held)
    })

    test("KEV wins precedence when both KEV and EPSS trigger", () => {
      const advisories = epssAdvisories({ hasKevListed: true })
      const result = evaluateHoldStatus(
        pkg({ sourceModifiedAt: dayOffset(2), advisories }),
        14,
        "default",
        null,
        9.0,
        true,
        0.5,
      )
      expect(result.bypassReason).toBe("kev")
    })

    test("EPSS wins over CVSS when both trigger", () => {
      // maxCvss 9.8 (≥ 7.0) and EPSS 0.72 (≥ 0.5) — EPSS is more specific.
      const advisories = epssAdvisories({ maxCvss: 9.8 })
      const result = evaluateHoldStatus(
        pkg({ sourceModifiedAt: dayOffset(2), advisories }),
        14,
        "default",
        null,
        7.0,
        false,
        0.5,
      )
      expect(result.bypassReason).toBe("epss")
    })

    test("evaluateAllPackages threads autoBypassEpss through", () => {
      const packages = [
        pkg({
          name: "epsspkg",
          sourceModifiedAt: dayOffset(2),
          advisories: epssAdvisories(),
        }),
      ]
      const result = evaluateAllPackages(
        packages,
        14,
        () => "default",
        () => null,
        Number.POSITIVE_INFINITY,
        false,
        0.5,
      )
      expect(result[0]!.bypassReason).toBe("epss")
    })
  })
})

describe("evaluateAllPackages", () => {
  test("maps each package through evaluateHoldStatus with per-name policy and pin", () => {
    const packages = [pkg({ name: "a" }), pkg({ name: "b", sourceModifiedAt: dayOffset(1) })]
    const policyFor = (n: string): Hold.Policy => (n === "a" ? "always-allow" : "default")
    const versionPinFor = () => null
    const result = evaluateAllPackages(packages, 14, policyFor, versionPinFor)
    expect(result[0]!.status).toBe(Hold.AlwaysAllow)
    expect(result[1]!.status).toBe(Hold.Held)
  })
})

describe("partitionUpgrade", () => {
  function withStatus(overrides: Partial<Package.WithStatus>): Package.WithStatus {
    return {
      ...pkg(),
      status: Hold.Ready,
      sourceAgeDays: 0,
      holdDaysRemaining: 0,
      advisories: null,
      provenance: null,
      bypassReason: null,
      ...overrides,
    }
  }

  test("ready outdated → upgrade; held outdated → held; up-to-date → neither", () => {
    const result: UpgradePartition = partitionUpgrade([
      withStatus({ name: "ready", status: Hold.Ready, outdated: true }),
      withStatus({ name: "held", status: Hold.Held, outdated: true }),
      withStatus({ name: "uptodate", status: Hold.UpToDate, outdated: false }),
      withStatus({ name: "allow-up-to-date", status: Hold.AlwaysAllow, outdated: false }),
    ])
    expect(result.upgrade.map((p) => p.name)).toEqual(["ready"])
    expect(result.held.map((p) => p.name)).toEqual(["held"])
  })

  test("skips ColdBrewPinned and AheadOfUpstream", () => {
    const result = partitionUpgrade([
      withStatus({ name: "pinned", status: Hold.ColdBrewPinned, outdated: true }),
      withStatus({ name: "ahead", status: Hold.AheadOfUpstream, outdated: true }),
    ])
    expect(result.upgrade).toEqual([])
    expect(result.held).toEqual([])
  })

  test("AlwaysAllow that is outdated routes to upgrade (Status.isReady true)", () => {
    const result = partitionUpgrade([withStatus({ name: "allow", status: Hold.AlwaysAllow, outdated: true })])
    expect(result.upgrade.map((p) => p.name)).toEqual(["allow"])
  })

  test("AlwaysHold routes to held bucket", () => {
    const result = partitionUpgrade([withStatus({ name: "h", status: Hold.AlwaysHold, outdated: true })])
    expect(result.held.map((p) => p.name)).toEqual(["h"])
  })
})

describe("formatHoldReason", () => {
  function ws(overrides: Partial<Package.WithStatus>): Package.WithStatus {
    return {
      ...pkg(),
      status: Hold.Ready,
      sourceAgeDays: 30,
      holdDaysRemaining: 0,
      advisories: null,
      provenance: null,
      bypassReason: null,
      ...overrides,
    }
  }

  test("each status has a non-empty reason", () => {
    for (const status of [
      Hold.Held,
      Hold.AlwaysHold,
      Hold.BrewPinned,
      Hold.AlwaysAllow,
      Hold.Ready,
      Hold.UpToDate,
      Hold.ColdBrewPinned,
      Hold.AheadOfUpstream,
    ]) {
      const reason = formatHoldReason(ws({ status, holdDaysRemaining: 3 }))
      expect(reason.length).toBeGreaterThan(0)
    }
  })

  test("Held reports remaining days", () => {
    expect(formatHoldReason(ws({ status: Hold.Held, holdDaysRemaining: 5 }))).toContain("5d left")
  })

  test("AheadOfUpstream surfaces latest version", () => {
    expect(formatHoldReason(ws({ status: Hold.AheadOfUpstream, latestVersion: "9.0" }))).toContain("9.0")
    expect(formatHoldReason(ws({ status: Hold.AheadOfUpstream, latestVersion: null }))).toContain("?")
  })

  test("ColdBrewPinned reports installed version", () => {
    expect(formatHoldReason(ws({ status: Hold.ColdBrewPinned, installedVersion: "3.2.1" }))).toContain("3.2.1")
  })
})
