import { describe, expect, test } from "bun:test"
import { Advisory } from "@brew/types"

describe("Advisory.Severity.fromCvss", () => {
  test.each<[number | null, Advisory.Severity]>([
    [null, "unknown"],
    [0, "unknown"],
    [0.1, "low"],
    [3.9, "low"],
    [4.0, "medium"],
    [6.9, "medium"],
    [7.0, "high"],
    [8.9, "high"],
    [9.0, "critical"],
    [10, "critical"],
  ])("fromCvss(%p) === %s", (cvss, expected) => {
    expect(Advisory.Severity.fromCvss(cvss)).toBe(expected)
  })
})

describe("Advisory.Severity.rank", () => {
  test("orders severities critical > high > medium > low > unknown", () => {
    const ranks = (["critical", "high", "medium", "low", "unknown"] as const).map(Advisory.Severity.rank)
    expect(ranks).toEqual([4, 3, 2, 1, 0])
  })
})

describe("Advisory.Kind.vulnerabilities / typosquats", () => {
  const summary: Advisory.Summary = {
    entries: [
      {
        id: "CVE-1",
        source: "osv",
        kind: "vulnerability",
        severity: "high",
        cvss: 7.5,
        summary: "",
        fixedIn: "1.1",
        fixInLatest: true,
        url: null,
        kev: false,
        epss: null,
      },
      {
        id: "MAL-1",
        source: "osv",
        kind: "typosquat",
        severity: "unknown",
        cvss: null,
        summary: "",
        fixedIn: null,
        fixInLatest: false,
        url: null,
        kev: false,
        epss: null,
      },
    ],
    maxCvss: 7.5,
    hasActionableFix: true,
    hasKevListed: false,
    maxEpss: null,
  }

  test("vulnerabilities returns only Vulnerability entries", () => {
    expect(Advisory.Kind.vulnerabilities(summary).map((e) => e.id)).toEqual(["CVE-1"])
  })

  test("typosquats returns only Typosquat entries", () => {
    expect(Advisory.Kind.typosquats(summary).map((e) => e.id)).toEqual(["MAL-1"])
  })

  test("both return empty for null/undefined input", () => {
    expect(Advisory.Kind.vulnerabilities(null)).toEqual([])
    expect(Advisory.Kind.typosquats(undefined)).toEqual([])
  })
})
