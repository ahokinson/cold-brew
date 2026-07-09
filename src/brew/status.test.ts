import { describe, expect, test } from "bun:test"
import { Status } from "@brew/status"
import { type Advisory, Hold, type Package } from "@brew/types"
import type { Theme } from "@tui/context/theme"

// Inline stub avoids importing theme.tsx (which pulls in the @opentui/solid
// JSX runtime — not loaded by bun test). Distinct sentinel strings per key
// let assertions verify the right branch was taken.
const theme = new Proxy({} as Theme, {
  get(_target, prop) {
    if (typeof prop === "symbol") return undefined
    return `theme.${String(prop)}`
  },
}) as Theme

function ws(overrides: Partial<Package.WithStatus> = {}): Package.WithStatus {
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
    dateConfidence: "authoritative",
    status: Hold.Ready,
    sourceAgeDays: 0,
    holdDaysRemaining: 0,
    advisories: null,
    provenance: null,
    bypassReason: null,
    ...overrides,
  }
}

describe("Status.isReady / isHeld", () => {
  test("isReady covers Ready and AlwaysAllow", () => {
    expect(Status.isReady(ws({ status: Hold.Ready }))).toBe(true)
    expect(Status.isReady(ws({ status: Hold.AlwaysAllow }))).toBe(true)
    expect(Status.isReady(ws({ status: Hold.Held }))).toBe(false)
  })

  test("isHeld covers Held, AlwaysHold, BrewPinned", () => {
    expect(Status.isHeld(ws({ status: Hold.Held }))).toBe(true)
    expect(Status.isHeld(ws({ status: Hold.AlwaysHold }))).toBe(true)
    expect(Status.isHeld(ws({ status: Hold.BrewPinned }))).toBe(true)
    expect(Status.isHeld(ws({ status: Hold.Ready }))).toBe(false)
  })
})

describe("Status.isActionable / section / sectionLabel", () => {
  test("non-leaf packages are never actionable", () => {
    expect(Status.isActionable(ws({ isLeaf: false }))).toBe(false)
  })

  test.each([Hold.UpToDate, Hold.ColdBrewPinned, Hold.AheadOfUpstream])("not actionable for %s", (status) => {
    expect(Status.isActionable(ws({ status }))).toBe(false)
  })

  test("actionable for Ready and Held", () => {
    expect(Status.isActionable(ws({ status: Hold.Ready }))).toBe(true)
    expect(Status.isActionable(ws({ status: Hold.Held }))).toBe(true)
  })

  test("section routes stable statuses to SECTION_STABLE", () => {
    expect(Status.section(ws({ status: Hold.UpToDate }))).toBe(Status.SECTION_STABLE)
    expect(Status.section(ws({ status: Hold.ColdBrewPinned }))).toBe(Status.SECTION_STABLE)
    expect(Status.section(ws({ status: Hold.AheadOfUpstream }))).toBe(Status.SECTION_STABLE)
    expect(Status.section(ws({ status: Hold.Held }))).toBe(Status.SECTION_ACTIONABLE)
  })

  test("sectionLabel", () => {
    expect(Status.sectionLabel(Status.SECTION_ACTIONABLE)).toBe("actionable")
    expect(Status.sectionLabel(Status.SECTION_STABLE)).toBe("stable")
    expect(Status.sectionLabel(999)).toBeNull()
  })
})

describe("Status.glyph", () => {
  test("returns a non-empty glyph for every Hold.Status", () => {
    for (const status of [
      Hold.UpToDate,
      Hold.Ready,
      Hold.Held,
      Hold.BrewPinned,
      Hold.AlwaysHold,
      Hold.AlwaysAllow,
      Hold.ColdBrewPinned,
      Hold.AheadOfUpstream,
    ]) {
      const g = Status.glyph(status)
      expect(typeof g).toBe("string")
      expect(g.length).toBeGreaterThan(0)
    }
  })
})

describe("Status.color / tapColor / severityColor / severityGlyph", () => {
  test("color returns a theme value for every status", () => {
    for (const status of [
      Hold.UpToDate,
      Hold.Ready,
      Hold.Held,
      Hold.BrewPinned,
      Hold.AlwaysHold,
      Hold.AlwaysAllow,
      Hold.ColdBrewPinned,
      Hold.AheadOfUpstream,
    ]) {
      expect(typeof Status.color(status, theme)).toBe("string")
    }
  })

  test("tapColor distinguishes cold-brew, custom, native", () => {
    expect(Status.tapColor("cold-brew/cold-brew", theme)).toBe(theme.accent)
    expect(Status.tapColor("someuser/sometap", theme)).toBe(theme.lavender)
    expect(Status.tapColor("homebrew/core", theme)).toBe(theme.textDim)
    expect(Status.tapColor("homebrew/cask", theme)).toBe(theme.textDim)
  })

  test("severityColor maps each severity to a theme key", () => {
    for (const sev of ["critical", "high", "medium", "low", "unknown"] as const) {
      expect(typeof Status.severityColor(sev, theme)).toBe("string")
    }
  })

  test("severityGlyph: alert for high/medium/critical; empty for low/unknown", () => {
    expect(Status.severityGlyph("critical").length).toBeGreaterThan(0)
    expect(Status.severityGlyph("high").length).toBeGreaterThan(0)
    expect(Status.severityGlyph("medium").length).toBeGreaterThan(0)
    expect(Status.severityGlyph("low")).toBe("")
    expect(Status.severityGlyph("unknown")).toBe("")
  })
})

describe("Status.isTooNew", () => {
  test("false when holdDays === 0 or not outdated or UpToDate", () => {
    expect(Status.isTooNew(ws(), 0)).toBe(false)
    expect(Status.isTooNew(ws({ outdated: false }), 14)).toBe(false)
    expect(Status.isTooNew(ws({ status: Hold.UpToDate }), 14)).toBe(false)
  })

  test("true when sourceAgeDays < ceil(holdDays/3)", () => {
    expect(Status.isTooNew(ws({ sourceAgeDays: 4 }), 14)).toBe(true) // ceil(14/3)=5
    expect(Status.isTooNew(ws({ sourceAgeDays: 5 }), 14)).toBe(false)
  })
})

describe("Status.topSeverity", () => {
  test("null when no vulnerabilities", () => {
    expect(Status.topSeverity(ws({ advisories: null }))).toBeNull()
    expect(
      Status.topSeverity(
        ws({ advisories: { entries: [], maxCvss: null, hasActionableFix: false, hasKevListed: false, maxEpss: null } }),
      ),
    ).toBeNull()
  })

  test("returns first vulnerability severity", () => {
    const advisories: Advisory.Summary = {
      entries: [
        {
          id: "CVE-1",
          source: "osv",
          kind: "vulnerability",
          severity: "high",
          cvss: 7.5,
          summary: "",
          fixedIn: null,
          fixInLatest: false,
          url: null,
          kev: false,
          epss: null,
        },
      ],
      maxCvss: 7.5,
      hasActionableFix: false,
      hasKevListed: false,
      maxEpss: null,
    }
    expect(Status.topSeverity(ws({ advisories }))).toBe("high")
  })
})

describe("Status.ageColor", () => {
  test("dim when not actionable", () => {
    expect(Status.ageColor(ws({ status: Hold.UpToDate, isLeaf: true, outdated: false }), theme, 14)).toBe(theme.textDim)
  })

  test("delegates to color() when held", () => {
    expect(Status.ageColor(ws({ status: Hold.Held }), theme, 14)).toBe(Status.color(Hold.Held, theme))
  })

  test("ready when holdDays === 0", () => {
    expect(Status.ageColor(ws({ status: Hold.Ready }), theme, 0)).toBe(theme.ready)
  })

  test("buckets by age multiplier", () => {
    const base = ws({ status: Hold.Ready })
    expect(Status.ageColor({ ...base, sourceAgeDays: 5 }, theme, 14)).toBe(theme.maroon) // < holdDays
    expect(Status.ageColor({ ...base, sourceAgeDays: 20 }, theme, 14)).toBe(theme.stale) // < 2x
    expect(Status.ageColor({ ...base, sourceAgeDays: 40 }, theme, 14)).toBe(theme.ready) // < 4x
    expect(Status.ageColor({ ...base, sourceAgeDays: 80 }, theme, 14)).toBe(theme.textDim) // < 8x
    expect(Status.ageColor({ ...base, sourceAgeDays: 200 }, theme, 14)).toBe(theme.overdue) // >= 8x
  })
})
