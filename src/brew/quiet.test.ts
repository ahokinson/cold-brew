import { describe, expect, test } from "bun:test"
import { createTrustWarningFilter, isBrewNoiseLine, stripAnsi } from "@brew/quiet"

describe("stripAnsi", () => {
  test("removes CSI sequences", () => {
    expect(stripAnsi("\x1b[34m==>\x1b[0m Fetching foo")).toBe("==> Fetching foo")
  })

  test("leaves plain text unchanged", () => {
    expect(stripAnsi("==> Pouring foo")).toBe("==> Pouring foo")
  })
})

describe("isBrewNoiseLine — drops", () => {
  const drops: Array<[string, string]> = [
    ["Fetching", "==> Fetching foo"],
    ["Fetching dependencies", "==> Fetching dependencies for bar: a, b, and c"],
    ["Fetching downloads for", "==> Fetching downloads for: foo, bar"],
    ["Downloading https", "==> Downloading https://example.com/foo.tar.gz"],
    ["Downloading from", "==> Downloading from https://github.com/foo/releases/x"],
    ["Already downloaded", "Already downloaded: /Users/me/Library/Caches/Homebrew/foo.bottle.tar.gz"],
    ["Summary", "==> Summary"],
    ["beer emoji", "🍺  /usr/local/Cellar/foo/1.2.3: 42 files, 1.2MB"],
    ["Running brew cleanup", "==> Running `brew cleanup foo`..."],
    ["Disable cleanup notice", "Disable this behaviour by setting HOMEBREW_NO_INSTALL_CLEANUP."],
    ["Pruned symlinks", "==> Pruned 0 symbolic links and 0 directories from /usr/local"],
    ["Backing up Cask", "==> Backing up Cask firefox latest --> 130.0"],
    ["Removing Cask", "==> Removing Cask firefox"],
    ["Linking Binary", "==> Linking Binary 'foo' to '/usr/local/bin/foo'"],
    ["Purging files", "==> Purging files for version 130.0 of Cask firefox"],
    ["Caskroom path", "==> Caskroom is /usr/local/Caskroom"],
    ["ANSI-prefixed noise", "\x1b[34m==>\x1b[0m Fetching foo"],
  ]

  for (const [name, line] of drops) {
    test(name, () => {
      expect(isBrewNoiseLine(line)).toBe(true)
    })
  }
})

describe("isBrewNoiseLine — keeps", () => {
  const keeps: Array<[string, string]> = [
    ["Caveats header", "==> Caveats"],
    ["Caveats body prose", "To start foo now and restart at login: brew services start foo"],
    ["Pouring milestone", "==> Pouring foo--1.2.3.arm64_sonoma.bottle.tar.gz"],
    ["Upgrading header", "==> Upgrading foo"],
    ["Upgrading dependents", "==> Upgrading 2 dependents of upgraded formulae:"],
    ["Installing dependencies", "==> Installing dependencies for foo: bar"],
    ["Warning line", "Warning: foo: deprecated"],
    ["Error line", "Error: foo failed to install"],
    ["blank line", ""],
    ["whitespace-only line", "   "],
    ["unknown ==> header", "==> Some new brew header"],
  ]

  for (const [name, line] of keeps) {
    test(name, () => {
      expect(isBrewNoiseLine(line)).toBe(false)
    })
  }
})

describe("createTrustWarningFilter", () => {
  // The real block brew prints before `brew upgrade --formula`/`--cask`.
  const block = [
    "Warning: The following taps are not trusted:",
    "  anchore/grype",
    "  anchore/syft",
    "",
    "Homebrew is currently ignoring formulae, casks and commands from these taps because tap trust is required.",
    "Trust specific formulae, casks or commands with:",
    "  brew trust --formula <user>/<tap>/<formula>",
    "  brew trust --cask <user>/<tap>/<cask>",
    "",
    "You can trust all formulae, casks and commands from these taps with:",
    "  brew trust anchore/grype anchore/syft",
    "Untap them with:",
    "  brew untap anchore/grype anchore/syft",
    "To disable trust checks:",
    "  export HOMEBREW_NO_REQUIRE_TAP_TRUST=1",
    "This is not recommended and will be removed in a later release.",
  ]

  function drive(lines: string[]): string[] {
    const filter = createTrustWarningFilter()
    return lines.filter((line) => filter(line))
  }

  test("drops the entire untrusted-taps block, keeps surrounding output", () => {
    const passed = drive([
      "==> Upgrading 1 outdated package:",
      ...block,
      "==> Upgrading grype",
      "🍺  /opt/homebrew/Cellar/grype/0.114.0",
    ])
    expect(passed).toEqual([
      "==> Upgrading 1 outdated package:",
      "==> Upgrading grype",
      // beer line is dropped by the composed isBrewNoiseLine
    ])
  })

  test("block at very start (no preceding output) is fully dropped", () => {
    expect(drive([...block, "==> Upgrading grype"])).toEqual(["==> Upgrading grype"])
  })

  test("defensive re-sync: a ==> line ends the block even without the terminator", () => {
    const truncated = block.slice(0, 5) // start + taps, no terminator
    const passed = drive([...truncated, "==> Upgrading grype"])
    expect(passed).toEqual(["==> Upgrading grype"])
  })

  test("non-trust output is unaffected and still composes with isBrewNoiseLine", () => {
    const passed = drive(["==> Upgrading foo", "==> Fetching foo", "Warning: foo: deprecated"])
    expect(passed).toEqual(["==> Upgrading foo", "Warning: foo: deprecated"])
  })
})
