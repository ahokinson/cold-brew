import { describe, expect, test } from "bun:test"
import { isValidPackageName, validateGitHubCommits } from "@brew/validate"

describe("isValidPackageName", () => {
  test.each([
    ["python@3.12"],
    ["c++utilities"],
    ["gcc"],
    ["openssl@3"],
    ["foo-bar"],
    ["foo_bar"],
    ["foo.bar"],
    ["a"],
    ["1password"],
  ])("accepts %s", (name) => {
    expect(isValidPackageName(name)).toBe(true)
  })

  test.each([
    [""],
    ["-leading-dash"],
    [".leading-dot"],
    ["@leading-at"],
    ["foo/bar"],
    ["foo bar"],
    ["foo;rm"],
    ["foo`x`"],
    ["foo$bar"],
    ["foo\nbar"],
  ])("rejects %p", (name) => {
    expect(isValidPackageName(name)).toBe(false)
  })
})

describe("validateGitHubCommits", () => {
  const sha = "a".repeat(40)
  const validCommit = {
    sha,
    commit: { message: "fix", committer: { date: "2024-01-15T12:00:00Z" } },
  }

  test("returns valid commits unchanged", () => {
    expect(validateGitHubCommits([validCommit])).toEqual([validCommit])
  })

  test("returns empty array for empty input", () => {
    expect(validateGitHubCommits([])).toEqual([])
  })

  test("throws on non-array", () => {
    expect(() => validateGitHubCommits(null)).toThrow(/array of commits/)
    expect(() => validateGitHubCommits({})).toThrow()
    expect(() => validateGitHubCommits("nope")).toThrow()
  })

  test("filters out malformed entries instead of throwing", () => {
    const malformed: unknown[] = [
      null,
      "string",
      { sha: "tooshort", commit: validCommit.commit },
      { sha, commit: null },
      { sha, commit: { message: 123, committer: { date: "2024-01-01" } } },
      { sha, commit: { message: "ok", committer: null } },
      { sha, commit: { message: "ok", committer: { date: 0 } } },
      { sha, commit: { message: "ok", committer: { date: "not-a-date" } } },
      validCommit,
    ]
    const result = validateGitHubCommits(malformed)
    expect(result).toEqual([validCommit])
  })

  test("rejects uppercase SHA only if not 40 hex chars", () => {
    const upperSha = "A".repeat(40)
    const c = { sha: upperSha, commit: validCommit.commit }
    expect(validateGitHubCommits([c])).toEqual([c])
  })

  test("rejects SHA with non-hex characters", () => {
    const bad = { sha: "g".repeat(40), commit: validCommit.commit }
    expect(validateGitHubCommits([bad])).toEqual([])
  })
})
