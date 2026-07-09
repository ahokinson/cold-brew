import { describe, expect, test } from "bun:test"
import { Icon, placeholder } from "@tui/icons"

describe("placeholder", () => {
  test("emits half as many double-dash glyphs as the column width", () => {
    expect(placeholder(0)).toBe("")
    expect(placeholder(1)).toBe("╌") // ceil(1/2) = 1
    expect(placeholder(2)).toBe("╌") // ceil(2/2) = 1
    expect(placeholder(4)).toBe("╌╌")
    expect(placeholder(6)).toBe("╌".repeat(3))
  })
})

describe("Icon table", () => {
  test("every entry has a char and a column count", () => {
    for (const [key, icon] of Object.entries(Icon)) {
      expect(typeof icon.char).toBe("string")
      expect(icon.char.length).toBeGreaterThan(0)
      expect(typeof icon.columns).toBe("number")
      expect(icon.columns).toBeGreaterThan(0)
      // sanity: ASCII keys
      expect(/^[a-zA-Z]/.test(key)).toBe(true)
    }
  })
})
