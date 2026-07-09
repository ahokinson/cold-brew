import { describe, expect, test } from "bun:test"
import { computeCvssScore } from "@brew/cvss"

describe("computeCvssScore — version dispatch", () => {
  test("returns null for unrecognized prefix", () => {
    expect(computeCvssScore("CVSS:2.0/AV:N/AC:L/Au:N/C:N/I:N/A:P")).toBeNull()
    expect(computeCvssScore("not-a-vector")).toBeNull()
    expect(computeCvssScore("")).toBeNull()
  })
})

describe("CVSS v3.1", () => {
  // Computed directly from the v3.1 spec formulas.
  test.each<[string, number]>([
    // Worst-case scope U → 9.8
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
    // Worst-case scope C → clamped to 10
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10.0],
    // All-low impact, network exploit → 7.3
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:L", 7.3],
    // No impact → 0
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N", 0],
    // Local, high-priv, user interaction required, single-A impact
    ["CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:H", 4.0],
  ])("scores %s as %f", (vector, expected) => {
    expect(computeCvssScore(vector)).toBeCloseTo(expected, 1)
  })

  test("accepts CVSS:3.0 prefix", () => {
    expect(computeCvssScore("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeGreaterThan(0)
  })

  test("returns null for missing scope", () => {
    expect(computeCvssScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/C:H/I:H/A:H")).toBeNull()
  })

  test("returns null for unknown metric value", () => {
    expect(computeCvssScore("CVSS:3.1/AV:Z/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeNull()
  })

  test("returns null for malformed vector body", () => {
    expect(computeCvssScore("CVSS:3.1/")).toBeNull()
    expect(computeCvssScore("CVSS:3.1/AV")).toBeNull()
  })
})

describe("CVSS v4.0", () => {
  // Per FIRST v4 reference calculator
  test.each<[string, number]>([
    // Minimal critical
    ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H", 10],
    // All impact N → spec shortcut returns 0
    ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N", 0],
    // Physical attack vector, low impact
    ["CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:L/VA:L/SC:L/SI:L/SA:L", 0.6],
  ])("scores %s ≈ %f", (vector, expected) => {
    expect(computeCvssScore(vector)).toBeCloseTo(expected, 0)
  })

  test("returns null when required metric is missing", () => {
    // PR omitted
    expect(computeCvssScore("CVSS:4.0/AV:N/AC:L/AT:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H")).toBeNull()
  })

  test("returns null for malformed vector body", () => {
    expect(computeCvssScore("CVSS:4.0/")).toBeNull()
    expect(computeCvssScore("CVSS:4.0/AV")).toBeNull()
  })

  test("threat/environmental X defaults do not change score relative to omitting them", () => {
    const base = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H"
    const withX = `${base}/E:X/CR:X/IR:X/AR:X`
    expect(computeCvssScore(withX)).toBe(computeCvssScore(base))
  })

  test("score is within [0, 10] for many random-looking vectors", () => {
    const vectors = [
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:P/VC:H/VI:L/VA:N/SC:L/SI:N/SA:H",
      "CVSS:4.0/AV:A/AC:H/AT:P/PR:N/UI:N/VC:L/VI:H/VA:L/SC:N/SI:S/SA:L",
      "CVSS:4.0/AV:L/AC:L/AT:N/PR:H/UI:A/VC:N/VI:L/VA:H/SC:H/SI:L/SA:N",
    ]
    for (const v of vectors) {
      const score = computeCvssScore(v)
      expect(score).not.toBeNull()
      expect(score!).toBeGreaterThanOrEqual(0)
      expect(score!).toBeLessThanOrEqual(10)
    }
  })
})
