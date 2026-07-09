import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { isCustomTap, NATIVE_TAPS, syncTapFormulas } from "@brew/tap"

describe("isCustomTap", () => {
  test("returns false for native taps", () => {
    for (const native of NATIVE_TAPS) {
      expect(isCustomTap(native)).toBe(false)
    }
  })

  test("returns true for any other tap string", () => {
    expect(isCustomTap("cold-brew/cold-brew")).toBe(true)
    expect(isCustomTap("ahokinson/tap")).toBe(true)
    expect(isCustomTap("unknown")).toBe(true)
    expect(isCustomTap("")).toBe(true)
  })
})

describe("syncTapFormulas", () => {
  // tests/setup.ts pins COLD_BREW_BREW_PREFIX to a tmp dir, so the formula
  // writes here land under $TMPDIR rather than the user's real Homebrew.
  const prefix = process.env.COLD_BREW_BREW_PREFIX!
  const tapPath = join(prefix, "Library", "Taps", "cold-brew", "homebrew-cold-brew")
  let spawnSpy: ReturnType<typeof spyOn> | null = null
  let logSpy: ReturnType<typeof spyOn> | null = null

  beforeEach(() => {
    // Wipe the tap dir so the .git presence varies cleanly between tests.
    rmSync(tapPath, { recursive: true, force: true })
    logSpy = spyOn(console, "log").mockImplementation((() => {}) as never)
  })

  afterEach(() => {
    spawnSpy?.mockRestore()
    spawnSpy = null
    logSpy?.mockRestore()
  })

  test("runs git init + commit on a fresh tap", async () => {
    const spawnedArgs: string[][] = []
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      spawnedArgs.push(args)
      return { stdout: "", stderr: "", exited: Promise.resolve(), exitCode: 0, kill: () => {} } as never
    }) as never)

    const exitCode = await syncTapFormulas()
    expect(exitCode).toBe(0)

    expect(spawnedArgs.find((a) => a[0] === "git" && a[1] === "init")).toBeDefined()
    expect(spawnedArgs.find((a) => a[0] === "git" && a[1] === "add")).toBeDefined()
    const commit = spawnedArgs.find((a) => a[0] === "git" && a[1] === "commit")
    expect(commit).toBeDefined()
    expect(commit!).toContain("--allow-empty")
  })

  test("skips git init when .git already exists", async () => {
    // Pre-create the tap dir + .git so ensureGitRepo's stat() succeeds.
    mkdirSync(join(tapPath, ".git"), { recursive: true })
    mkdirSync(join(tapPath, "Formula"), { recursive: true })
    mkdirSync(join(tapPath, "Casks"), { recursive: true })

    const spawnedArgs: string[][] = []
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
      spawnedArgs.push(args)
      return { stdout: "", stderr: "", exited: Promise.resolve(), exitCode: 0, kill: () => {} } as never
    }) as never)

    await syncTapFormulas()
    expect(spawnedArgs.find((a) => a[0] === "git" && a[1] === "init")).toBeUndefined()
  })
})
