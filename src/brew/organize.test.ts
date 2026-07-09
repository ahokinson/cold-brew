import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  type Classifier,
  createCleanupClassifier,
  createDoctorClassifier,
  createUpdateClassifier,
  createUpgradeClassifier,
  decideExit,
  type OrganizeContext,
  organize,
  printOrganized,
  progressLabel,
  splitBlocks,
} from "@brew/organize"

function ctx(over: Partial<OrganizeContext> = {}): OrganizeContext {
  return { isManaged: () => true, state: {}, ...over }
}

describe("splitBlocks", () => {
  test("splits on header lines, preserving internal blank lines within a block", () => {
    const blocks = splitBlocks("Warning: a problem\n\n  detail line\nmore prose\n")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.header).toBe("Warning: a problem")
    expect(blocks[0]!.lines).toEqual(["Warning: a problem", "", "  detail line", "more prose"])
  })

  test("back-to-back headers open separate blocks", () => {
    const blocks = splitBlocks("Warning: one\nWarning: two\n==> three\n")
    expect(blocks.map((b) => b.header)).toEqual(["Warning: one", "Warning: two", "==> three"])
  })

  test("leading lines before the first header form a preamble block", () => {
    const blocks = splitBlocks("Your system is ready to brew.\nWarning: later\n")
    expect(blocks[0]!.header).toBe("Your system is ready to brew.")
    expect(blocks[1]!.header).toBe("Warning: later")
  })

  test("a block at EOF without a trailing terminator is still captured", () => {
    const blocks = splitBlocks("==> Pouring foo\nsome line")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.lines).toEqual(["==> Pouring foo", "some line"])
  })
})

describe("organize core", () => {
  const fake: Classifier = {
    classify: (block) => {
      if (block.header.includes("DROP")) return { kind: "drop" }
      if (block.header.includes("KEEP")) return { kind: "keep" }
      if (block.header.includes("CONDENSE")) return { kind: "condense", summary: [`summary:${block.header}`] }
      return { kind: "defer" }
    },
    finalize: () => ["finalize-line"],
  }

  test("routes verdicts to condensed/deferred in order; finalize appended last", () => {
    const raw = ["Warning: KEEP this", "Warning: DROP this", "Warning: DEFER this", "Warning: CONDENSE this"].join("\n")
    const result = organize(raw, fake, ctx())
    expect(result.condensed).toEqual(["Warning: KEEP this", "summary:Warning: CONDENSE this", "finalize-line"])
    expect(result.deferred).toEqual(["Warning: DEFER this"])
    expect(result.keptCount).toBe(1)
  })

  test("unrecognized blocks default to deferred (anti-silent-swallow)", () => {
    const result = organize("Warning: something brand new\n  detail", fake, ctx())
    expect(result.deferred).toEqual(["Warning: something brand new", "  detail"])
  })
})

describe("printOrganized", () => {
  let writes: string[] = []
  let spy: ReturnType<typeof spyOn> | null = null
  beforeEach(() => {
    writes = []
    spy = spyOn(process.stdout, "write").mockImplementation(((c: string) => {
      writes.push(String(c))
      return true
    }) as never)
  })
  afterEach(() => spy?.mockRestore())

  test("prints condensed lines, then a trailer only when something was deferred", () => {
    printOrganized({ condensed: ["kept-a"], deferred: ["weird-1", "weird-2"], keptCount: 1 })
    const out = writes.join("")
    expect(out).toContain("kept-a\n")
    expect(out).toContain("other brew output:")
    expect(out).toContain("weird-1\n")
  })

  test("no trailer when nothing deferred", () => {
    printOrganized({ condensed: ["only-condensed"], deferred: [], keptCount: 0 })
    expect(writes.join("")).not.toContain("other brew output:")
  })
})

describe("decideExit", () => {
  test("benign (nothing surfaced) is not flagged regardless of exit code", () => {
    expect(decideExit(1, { condensed: ["cleaned 2 files"], deferred: [], keptCount: 0 }).surfaced).toBe(false)
  })
  test("deferred or kept output surfaces", () => {
    expect(decideExit(0, { condensed: [], deferred: ["err"], keptCount: 0 }).surfaced).toBe(true)
    expect(decideExit(0, { condensed: ["x"], deferred: [], keptCount: 1 }).surfaced).toBe(true)
  })
  test("preserves the real exit code", () => {
    expect(decideExit(3, { condensed: [], deferred: ["e"], keptCount: 0 }).exitCode).toBe(3)
  })
})

describe("progressLabel", () => {
  test("maps brew progress markers to short labels", () => {
    expect(progressLabel("==> Upgrading ripgrep")).toBe("upgrading ripgrep")
    expect(progressLabel("==> Pouring openssl@3.bottle.tar.gz")).toBe("pouring openssl@3.bottle.tar.gz")
    expect(progressLabel("==> Fetching wget")).toBe("fetching wget")
    expect(progressLabel("==> Downloading https://example.com/x.tar.gz")).toBe("downloading…")
  })
  test("returns null for non-progress lines", () => {
    expect(progressLabel("🍺  /opt/homebrew/Cellar/wget/1.0")).toBeNull()
    expect(progressLabel("Warning: whatever")).toBeNull()
  })
})

describe("createUpdateClassifier", () => {
  test("drops the report blocks, scalars, and noise", () => {
    const raw = [
      "==> Updating Homebrew...",
      "==> Updated Homebrew from f7c3d09a3d to c3e4d276c9.",
      "Updated 2 taps (anomalyco/tap and homebrew/core).",
      "==> New Formulae",
      "arf: Modern R console",
      "",
      "You have 17 outdated formulae installed.",
      "You can upgrade them with brew upgrade",
      "or list them with brew outdated.",
    ].join("\n")
    const result = organize(raw, createUpdateClassifier(), ctx())
    expect(result.condensed).toEqual([])
    expect(result.deferred).toEqual([])
  })

  test("defers genuine errors so a broken update is never hidden", () => {
    const raw = [
      "Error: Failure while executing; `git fetch` exited with 128.",
      "fatal: unable to access 'https://github.com/...': Could not resolve host",
    ].join("\n")
    const result = organize(raw, createUpdateClassifier(), ctx())
    expect(result.deferred).toContain("Error: Failure while executing; `git fetch` exited with 128.")
  })
})

describe("createCleanupClassifier", () => {
  test("rolls removals + freed space into one condensed line", () => {
    const raw = [
      "Removing: /Users/x/Library/Caches/Homebrew/foo... (3 files, 4.2MB)",
      "Removing: /Users/x/Library/Caches/Homebrew/bar... (1 file, 2KB)",
      "==> This operation has freed approximately 1.2GB of disk space.",
    ].join("\n")
    const result = organize(raw, createCleanupClassifier(), ctx())
    expect(result.condensed.join("")).toContain("cleaned 2 files, freed 1.2GB")
    expect(result.deferred).toEqual([])
  })

  test("managed orphan-keg block dropped; unmanaged kept", () => {
    const raw = [
      "Warning: Some installed kegs have no formulae!",
      "You should find replacements for the following formulae:",
      "  playwright-cli",
      "  osv-scanner",
      "",
    ].join("\n")
    expect(organize(raw, createCleanupClassifier(), ctx({ isManaged: () => true })).condensed).toEqual([])
    const unmanaged = organize(raw, createCleanupClassifier(), ctx({ isManaged: (n) => n !== "osv-scanner" }))
    expect(unmanaged.condensed.join("\n")).toContain("Warning: Some installed kegs have no formulae!")
    expect(unmanaged.keptCount).toBe(1)
  })

  test("held-version skip warnings are dropped (expected for held packages)", () => {
    const raw = [
      "Warning: Skipping awscli: most recent version 2.35.6 not installed",
      "Warning: Skipping deno: most recent version 2.8.3 not installed",
    ].join("\n")
    const result = organize(raw, createCleanupClassifier(), ctx())
    expect(result.condensed).toEqual([])
    expect(result.deferred).toEqual([])
  })

  test("an unexpected warning is deferred, not silently dropped", () => {
    const result = organize("Warning: something cleanup didn't expect\n  detail", createCleanupClassifier(), ctx())
    expect(result.deferred.join("\n")).toContain("Warning: something cleanup didn't expect")
  })
})

describe("createDoctorClassifier", () => {
  test("drops preamble, trust block, ready line; keeps missing-deps", () => {
    const raw = [
      "Please note that these warnings are just used to help the Homebrew maintainers",
      "with debugging if you file an issue.",
      "",
      "Warning: The following taps are not trusted:",
      "  anchore/grype",
      "",
      "To disable trust checks:",
      "  export HOMEBREW_NO_REQUIRE_TAP_TRUST=1",
      "This is not recommended and will be removed in a later release.",
      "Warning: Some installed formulae or casks are missing dependencies.",
      "  brew install python@3.13",
    ].join("\n")
    const result = organize(raw, createDoctorClassifier(), ctx())
    expect(result.condensed.join("\n")).toContain("Warning: Some installed formulae or casks are missing dependencies.")
    expect(result.condensed.join("\n")).not.toContain("not trusted")
    expect(result.condensed.join("\n")).not.toContain("Please note")
    expect(result.deferred).toEqual([])
    expect(result.keptCount).toBe(1)
  })

  test("default-branch warning for cold-brew's local tap is dropped and fires the callback", () => {
    let fired = false
    const raw = [
      "Warning: Some taps are not on the default git origin branch and may not receive",
      "updates. If this is a surprise to you, check out the default branch with:",
      "  git -C $(brew --repository cold-brew/cold-brew) checkout master",
      "",
    ].join("\n")
    const result = organize(
      raw,
      createDoctorClassifier(),
      ctx({
        onColdBrewTapWarning: () => {
          fired = true
        },
      }),
    )
    expect(fired).toBe(true)
    expect(result.condensed).toEqual([])
    expect(result.deferred).toEqual([])
  })

  test("default-branch warning for a foreign tap is kept", () => {
    const raw = [
      "Warning: Some taps are not on the default git origin branch and may not receive",
      "updates. If this is a surprise to you, check out the default branch with:",
      "  git -C $(brew --repository acme/widgets) checkout main",
      "",
    ].join("\n")
    const result = organize(raw, createDoctorClassifier(), ctx())
    expect(result.keptCount).toBe(1)
    expect(result.condensed.join("\n")).toContain("acme/widgets")
  })

  test("an unrecognized doctor warning is deferred to the trailer", () => {
    const raw = [
      "Warning: You have some Casks that have been deprecated by the original maintainer.",
      "  some-cask",
    ].join("\n")
    const result = organize(raw, createDoctorClassifier(), ctx())
    expect(result.deferred.join("\n")).toContain("deprecated by the original maintainer")
    expect(result.condensed).toEqual([])
  })

  test("'ready to brew' is dropped (no issues = no output)", () => {
    const result = organize("Your system is ready to brew.", createDoctorClassifier(), ctx())
    expect(result.condensed).toEqual([])
    expect(result.deferred).toEqual([])
  })
})

describe("createUpgradeClassifier", () => {
  test("drops all of brew's upgrade chatter and the trust block", () => {
    const raw = [
      "==> Upgrading 2 outdated packages:",
      "ripgrep 14.1.0 -> 14.1.1",
      "==> Fetching ripgrep",
      "==> Downloading https://...",
      "==> Pouring ripgrep--14.1.1.bottle.tar.gz",
      "🍺  /opt/homebrew/Cellar/ripgrep/14.1.1: 13 files, 5.2MB",
      "Warning: The following taps are not trusted:",
      "  anchore/grype",
      "This is not recommended and will be removed in a later release.",
    ].join("\n")
    const result = organize(raw, createUpgradeClassifier(), ctx({ isManaged: () => false }))
    expect(result.condensed).toEqual([])
    expect(result.deferred).toEqual([])
  })

  test("defers genuine build errors and caveats", () => {
    const errors = organize("Error: openssl@3 failed to build\nsee the log", createUpgradeClassifier(), ctx())
    expect(errors.deferred.join("\n")).toContain("Error: openssl@3 failed to build")

    const caveats = organize("==> Caveats\nAdd this to your PATH", createUpgradeClassifier(), ctx())
    expect(caveats.deferred.join("\n")).toContain("Add this to your PATH")
  })
})
