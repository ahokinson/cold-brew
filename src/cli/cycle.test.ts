import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { runMaintenanceCycle } from "@cli/cycle"
import { resetDb } from "@db"

// Block-level condensing is covered in src/brew/organize.test.ts. These tests
// drive the orchestrator end-to-end.
//
// The cycle runs 4 brew subcommands in sequence (update, upgrade, cleanup,
// doctor) and tallies failures. Tests stub Bun.spawn to fake the subprocess
// layer and globalThis.fetch for advisories. process.stdout.write is suppressed
// so the organized passthrough doesn't spam the test output.

let writeSpy: ReturnType<typeof spyOn> | null = null

beforeEach(() => {
  writeSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never)
})

afterEach(() => {
  writeSpy?.mockRestore()
})

type RmcFakeChild = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exitCode: number
  exited: Promise<void>
  kill: () => void
}

function rmcStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      if (text) c.enqueue(enc.encode(text))
      c.close()
    },
  })
}

function rmcChild(stdout = "", stderr = "", exitCode = 0): RmcFakeChild {
  return {
    stdout: rmcStream(stdout),
    stderr: rmcStream(stderr),
    exitCode,
    exited: Promise.resolve(),
    kill: () => {},
  }
}

// Routes brew subcommands invoked by the cycle (including handleUpgrade's
// downstream `preparePackages` calls) to canned responses. Caller can override
// per-subcommand via `overrides` keyed by the brew subcommand name.
function rmcStubBrew(overrides: Partial<Record<string, () => RmcFakeChild>> = {}) {
  return spyOn(Bun, "spawn").mockImplementation(((args: string[]) => {
    const sub = args[1] ?? ""
    const override = overrides[sub]
    if (override) return override()
    switch (sub) {
      case "--prefix":
        return rmcChild("/opt/homebrew\n")
      case "list":
        return rmcChild("") // no formulae or casks installed
      case "leaves":
        return rmcChild("")
      case "outdated":
        return rmcChild('{"formulae":[],"casks":[]}')
      case "info":
        return rmcChild('{"formulae":[],"casks":[]}')
      case "update":
        return rmcChild("")
      case "upgrade":
        return rmcChild("")
      case "reinstall":
        return rmcChild("")
      case "cleanup":
        return rmcChild("")
      case "doctor":
        return rmcChild("")
      default:
        return rmcChild("")
    }
  }) as never)
}

describe("runMaintenanceCycle", () => {
  let spawnSpy: ReturnType<typeof spyOn> | null = null
  let logSpy: ReturnType<typeof spyOn> | null = null
  let warnSpy: ReturnType<typeof spyOn> | null = null
  const realFetch = globalThis.fetch
  const logs: string[] = []

  beforeEach(() => {
    resetDb()
    logs.length = 0
    logSpy = spyOn(console, "log").mockImplementation(((...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }) as never)
    warnSpy = spyOn(console, "warn").mockImplementation((() => {}) as never)
    globalThis.fetch = (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch
    process.env.GITHUB_TOKEN = "test"
  })

  afterEach(() => {
    spawnSpy?.mockRestore()
    logSpy?.mockRestore()
    warnSpy?.mockRestore()
    spawnSpy = null
    globalThis.fetch = realFetch
    delete process.env.GITHUB_TOKEN
  })

  test("happy path: all 4 steps succeed, exit 0, no failure summary", async () => {
    spawnSpy = rmcStubBrew()
    const exitCode = await runMaintenanceCycle()
    expect(exitCode).toBe(0)

    const headers = logs.filter((line) => line.includes("==>"))
    expect(headers.some((l) => l.includes("Updating Homebrew..."))).toBe(true)
    expect(headers.some((l) => l.includes("Upgrading packages..."))).toBe(true)
    expect(headers.some((l) => l.includes("Cleaning up..."))).toBe(true)
    expect(headers.some((l) => l.includes("Running doctor..."))).toBe(true)

    expect(logs.some((l) => l.includes("reported issues"))).toBe(false)
  })

  test("non-zero exit with no surfaced output is treated as clean (new decideExit semantics)", async () => {
    // brew exits non-zero but cold-brew recognized and dropped everything — no
    // deferred or kept block — so the step is not flagged.
    spawnSpy = rmcStubBrew({
      doctor: () => rmcChild("", "", 1),
    })
    const exitCode = await runMaintenanceCycle()
    expect(exitCode).toBe(0)
    expect(logs.some((l) => l.includes("reported issues"))).toBe(false)
  })

  test("failure aggregation: a step that surfaces unrecognized output is flagged with its exit code", async () => {
    spawnSpy = rmcStubBrew({
      cleanup: () => rmcChild("", "boom", 3),
    })
    const exitCode = await runMaintenanceCycle()
    expect(exitCode).toBe(3)
    expect(logs.some((l) => l.toLowerCase().includes("cleaning up") && l.includes("reported issues"))).toBe(true)
  })

  test("multiple surfacing failures: first non-zero exit wins, summary lists all", async () => {
    spawnSpy = rmcStubBrew({
      update: () => rmcChild("", "Error: git fetch failed", 7),
      doctor: () =>
        rmcChild("Warning: Some installed formulae or casks are missing dependencies.\n  brew install foo\n", "", 9),
    })
    const exitCode = await runMaintenanceCycle()
    expect(exitCode).toBe(7) // first surfacing failure
    const summary = logs.find((l) => l.includes("reported issues"))
    expect(summary).toBeDefined()
    expect(summary).toContain("updating homebrew")
    expect(summary).toContain("running doctor")
  })

  test("surfaced output on a benign exit-0 step still yields a non-zero cycle exit", async () => {
    // brew doctor exits 0 but emits an unrecognized warning cold-brew defers to
    // the trailer. The "reported issues" summary prints, so the exit code must
    // reflect it rather than reporting success.
    spawnSpy = rmcStubBrew({
      doctor: () => rmcChild("Warning: Something totally unexpected happened\n  some detail\n", "", 0),
    })
    const exitCode = await runMaintenanceCycle()
    expect(exitCode).toBe(1)
    expect(logs.some((l) => l.toLowerCase().includes("running doctor") && l.includes("reported issues"))).toBe(true)
  })

  test("cold-brew tap warning from doctor triggers the dim trailer without flagging a failure", async () => {
    spawnSpy = rmcStubBrew({
      doctor: () =>
        rmcChild(
          "Warning: Some taps are not on the default git origin branch and may not receive\n" +
            "updates. If this is a surprise to you, check out the default branch with:\n" +
            "  git -C $(brew --repository cold-brew/cold-brew) checkout master\n\n",
        ),
    })
    const exitCode = await runMaintenanceCycle()
    expect(exitCode).toBe(0)
    expect(logs.some((l) => l.includes("tap warnings for cold-brew/cold-brew are expected"))).toBe(true)
    // The branch warning is cold-brew's expected local-tap noise → dropped, not flagged.
    expect(logs.some((l) => l.includes("reported issues"))).toBe(false)
  })
})
