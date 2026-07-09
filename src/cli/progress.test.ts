import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { statusClear, statusUpdate } from "@cli/progress"

// `isTTY` is captured at module load and can't be changed afterwards, so the
// branch each function takes depends on the parent process. Tests verify the
// behavior that matches whichever branch was selected.
const isTTY = !!process.stderr.isTTY

describe("progress", () => {
  let writeSpy: ReturnType<typeof spyOn> | null = null
  let lastWritten = ""

  afterEach(() => {
    writeSpy?.mockRestore()
    writeSpy = null
    lastWritten = ""
  })

  test("statusUpdate writes a status line when TTY, no-op otherwise", () => {
    writeSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      lastWritten = String(chunk)
      return true
    }) as never)
    statusUpdate("loading...")
    if (isTTY) {
      expect(writeSpy).toHaveBeenCalledTimes(1)
      expect(lastWritten).toContain("loading...")
      expect(lastWritten).toContain("\x1b[") // ANSI escape
    } else {
      expect(writeSpy).not.toHaveBeenCalled()
    }
  })

  test("statusClear writes a clear sequence when TTY, no-op otherwise", () => {
    writeSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      lastWritten = String(chunk)
      return true
    }) as never)
    statusClear()
    if (isTTY) {
      expect(writeSpy).toHaveBeenCalledTimes(1)
      expect(lastWritten).toContain("\r")
      expect(lastWritten).toContain("\x1b[K")
    } else {
      expect(writeSpy).not.toHaveBeenCalled()
    }
  })
})
