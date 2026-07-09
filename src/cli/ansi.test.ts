import { describe, expect, test } from "bun:test"
import { Ansi, bold, Color, dim, plural } from "@cli/ansi"

describe("plural", () => {
  test("singular when n === 1", () => {
    expect(plural(1, "package")).toBe("package")
  })

  test("default plural appends 's'", () => {
    expect(plural(0, "package")).toBe("packages")
    expect(plural(2, "package")).toBe("packages")
  })

  test("custom plural form is honored", () => {
    expect(plural(3, "octopus", "octopi")).toBe("octopi")
  })
})

describe("Ansi / Color tables", () => {
  test("Color.ready maps to Ansi.GREEN", () => {
    expect(Color.ready).toBe(Ansi.GREEN)
  })

  test("all keys exist", () => {
    for (const k of ["DIM", "RESET", "BOLD", "YELLOW", "GREEN", "CYAN", "BLUE", "RED", "MAGENTA"] as const) {
      expect(Ansi[k]).toBeDefined()
    }
  })
})

describe("bold / dim", () => {
  // colorEnabled is captured at module load. In a non-TTY bun test run with
  // no FORCE_COLOR, codes evaluate empty — so bold/dim are pass-through.
  test("are pass-through when color is disabled", () => {
    if (Ansi.BOLD === "") {
      expect(bold("hi")).toBe("hi")
      expect(dim("hi")).toBe("hi")
    } else {
      expect(bold("hi")).toContain("hi")
      expect(dim("hi")).toContain("hi")
    }
  })
})
