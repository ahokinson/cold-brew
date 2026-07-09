import { describe, expect, test } from "bun:test"
import { runBatchesWithLimit, runWithConcurrencyLimit } from "@brew/concurrency"

describe("runWithConcurrencyLimit", () => {
  test("processes every item and preserves order", async () => {
    const items = [1, 2, 3, 4, 5]
    const result = await runWithConcurrencyLimit(items, 2, async (n) => n * n)
    expect(result).toEqual([1, 4, 9, 16, 25])
  })

  test("respects the concurrency limit", async () => {
    let inFlight = 0
    let peak = 0
    const result = await runWithConcurrencyLimit([0, 1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return n
    })
    expect(result).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(peak).toBeLessThanOrEqual(3)
  })

  test("isolates errors per item", async () => {
    const result = await runWithConcurrencyLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom")
      return n
    })
    expect(result[0]).toBe(1)
    expect(result[1]).toBeInstanceOf(Error)
    expect((result[1] as Error).message).toBe("boom")
    expect(result[2]).toBe(3)
  })

  test("wraps non-Error throws into Error", async () => {
    const result = await runWithConcurrencyLimit([1], 1, async () => {
      throw "string-throw"
    })
    expect(result[0]).toBeInstanceOf(Error)
    expect((result[0] as Error).message).toBe("string-throw")
  })

  test("invokes onProgress for every completion", async () => {
    const events: Array<[number, number]> = []
    await runWithConcurrencyLimit(
      [1, 2, 3],
      2,
      async (n) => n,
      (c, t) => events.push([c, t]),
    )
    expect(events).toHaveLength(3)
    expect(events[2]).toEqual([3, 3])
  })

  test("handles empty input without spawning workers", async () => {
    const result = await runWithConcurrencyLimit<number, number>([], 4, async (n) => n)
    expect(result).toEqual([])
  })
})

describe("runBatchesWithLimit", () => {
  test("chunks items and runs handler per batch", async () => {
    const items = ["a", "b", "c", "d", "e"]
    const result = await runBatchesWithLimit(items, 2, 2, async (batch) => batch.join(","))
    expect(result).toEqual(["a,b", "c,d", "e"])
  })

  test("propagates per-batch errors via Error sentinel", async () => {
    const result = await runBatchesWithLimit(["a", "b"], 1, 1, async () => {
      throw new Error("nope")
    })
    expect(result.every((r) => r instanceof Error)).toBe(true)
  })
})
