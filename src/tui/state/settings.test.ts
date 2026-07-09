import { beforeEach, describe, expect, test } from "bun:test"
import { getHoldDays, resetDb, setHoldDays } from "@db"
import { createSettingsState } from "@tui/state/settings"

beforeEach(() => {
  resetDb()
})

function makeState() {
  let reevaluateCalls = 0
  const messages: string[] = []
  const state = createSettingsState(
    () => {
      reevaluateCalls++
    },
    (msg) => {
      messages.push(msg)
    },
  )
  return {
    state,
    get reevaluateCalls() {
      return reevaluateCalls
    },
    messages,
  }
}

describe("createSettingsState", () => {
  test("openSettings copies current hold days into editing buffer", () => {
    setHoldDays(21)
    const { state } = makeState()
    state.openSettings()
    expect(state.settingsOpen()).toBe(true)
    expect(state.editingHoldDays()).toBe("21")
  })

  test("closeSettings commits valid edits and triggers reevaluate + message", () => {
    setHoldDays(7)
    const { state, messages } = makeState()
    state.openSettings()
    state.setEditingHoldDays("14")
    state.closeSettings()
    expect(state.settingsOpen()).toBe(false)
    expect(getHoldDays()).toBe(14)
    expect(messages.some((m) => m.includes("7") && m.includes("14"))).toBe(true)
  })

  test("close with same value: no reevaluate, no message", () => {
    setHoldDays(7)
    const wrap = makeState()
    wrap.state.openSettings()
    wrap.state.closeSettings()
    expect(wrap.reevaluateCalls).toBe(0)
    expect(wrap.messages).toEqual([])
  })

  test("invalid input falls back to previous value", () => {
    setHoldDays(7)
    const { state } = makeState()
    state.openSettings()
    state.setEditingHoldDays("not-a-number")
    state.commitHoldDays()
    expect(state.editingHoldDays()).toBe("7")
    expect(getHoldDays()).toBe(7)
  })

  test("clamps to max (365)", () => {
    setHoldDays(7)
    const { state } = makeState()
    state.openSettings()
    state.setEditingHoldDays("9999")
    state.commitHoldDays()
    expect(getHoldDays()).toBe(365)
    expect(state.editingHoldDays()).toBe("365")
  })

  test("clamps negative input to 0", () => {
    setHoldDays(7)
    const { state } = makeState()
    state.openSettings()
    state.setEditingHoldDays("-5")
    state.commitHoldDays()
    expect(getHoldDays()).toBe(0)
    expect(state.editingHoldDays()).toBe("0")
  })

  test("increment / decrement", () => {
    setHoldDays(7)
    const { state } = makeState()
    state.openSettings()
    state.incrementHoldDays()
    expect(state.editingHoldDays()).toBe("8")
    state.decrementHoldDays()
    state.decrementHoldDays()
    expect(state.editingHoldDays()).toBe("6")
  })

  test("decrement stops at 0; increment stops at 365", () => {
    const { state } = makeState()
    state.openSettings()
    state.setEditingHoldDays("0")
    state.decrementHoldDays()
    expect(state.editingHoldDays()).toBe("0")
    state.setEditingHoldDays("365")
    state.incrementHoldDays()
    expect(state.editingHoldDays()).toBe("365")
  })

  test("increment/decrement falls back to current hold days when buffer is non-numeric", () => {
    setHoldDays(7)
    const { state } = makeState()
    state.openSettings()
    state.setEditingHoldDays("nope")
    state.incrementHoldDays()
    expect(state.editingHoldDays()).toBe("8")
    state.setEditingHoldDays("nope")
    state.decrementHoldDays()
    expect(state.editingHoldDays()).toBe("6")
  })
})
