import { describe, expect, test } from "bun:test"
import { commitDateToAgeDays, formatBypass, formatDate } from "@brew/format"

describe("formatBypass", () => {
  test("returns 'CVSS bypass' for cvss reason", () => {
    expect(formatBypass("cvss")).toBe("CVSS bypass")
  })

  test("returns 'KEV bypass' for kev reason", () => {
    expect(formatBypass("kev")).toBe("KEV bypass")
  })

  test("returns 'EPSS bypass' for epss reason", () => {
    expect(formatBypass("epss")).toBe("EPSS bypass")
  })

  test("returns empty string when no reason", () => {
    expect(formatBypass(null)).toBe("")
  })
})

describe("formatDate", () => {
  test("formats a known unix seconds value to en-US short date", () => {
    // 2024-06-15 00:00:00 UTC
    const result = formatDate(1718409600)
    expect(result).toMatch(/Jun/)
    expect(result).toMatch(/2024/)
  })
})

describe("commitDateToAgeDays", () => {
  test("ages a recent date as non-negative integer", () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(commitDateToAgeDays(today)).toBeGreaterThanOrEqual(0)
  })

  test("ages a historical date in days", () => {
    const days = commitDateToAgeDays("2020-01-01")
    expect(days).toBeGreaterThan(365 * 5)
  })
})
