import { describe, expect, test } from "bun:test"
import { dispatchBindings, type KeyBinding, type KeyEvent } from "@ahokinson/press/keyboard"
import { matchFor } from "@tui/keys"

describe("matchFor", () => {
  test("uppercase letter → lowercase name + shift:true", () => {
    expect(matchFor("G")).toEqual({ name: "g", shift: true })
    expect(matchFor("U")).toEqual({ name: "u", shift: true })
    expect(matchFor("D")).toEqual({ name: "d", shift: true })
    expect(matchFor("R")).toEqual({ name: "r", shift: true })
  })

  test("lowercase letter → shift:false so a shifted press can't fall through", () => {
    expect(matchFor("g")).toEqual({ name: "g", shift: false })
    expect(matchFor("u")).toEqual({ name: "u", shift: false })
  })

  test("non-letter keys stay shift-agnostic", () => {
    expect(matchFor("?")).toEqual({ name: "?" })
    expect(matchFor(",")).toEqual({ name: "," })
    expect(matchFor("escape")).toEqual({ name: "escape" })
    expect(matchFor("tab")).toEqual({ name: "tab" })
  })
})

describe("dispatch with shifted bindings", () => {
  const ev = (over: Partial<KeyEvent>): KeyEvent =>
    ({ name: "", ctrl: false, meta: false, shift: false, sequence: "", ...over }) as KeyEvent

  function bindings(fired: string[]): KeyBinding[] {
    return [
      // Order mirrors layout.tsx: unshifted variant listed before shifted one.
      { match: matchFor("g"), run: () => fired.push("top") },
      { match: matchFor("G"), run: () => fired.push("bottom") },
      { match: matchFor("u"), run: () => fired.push("upgrade-one") },
      { match: matchFor("U"), run: () => fired.push("upgrade-all") },
    ]
  }

  test("Shift+g reaches jump-to-bottom, not jump-to-top", () => {
    const fired: string[] = []
    dispatchBindings(() => bindings(fired))(ev({ name: "g", shift: true }))
    expect(fired).toEqual(["bottom"])
  })

  test("plain g still reaches jump-to-top", () => {
    const fired: string[] = []
    dispatchBindings(() => bindings(fired))(ev({ name: "g", shift: false }))
    expect(fired).toEqual(["top"])
  })

  test("Shift+u reaches upgrade-all, not upgrade-one", () => {
    const fired: string[] = []
    dispatchBindings(() => bindings(fired))(ev({ name: "u", shift: true }))
    expect(fired).toEqual(["upgrade-all"])
  })
})
