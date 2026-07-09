export interface GitHubCommit {
  sha: string
  commit: {
    message: string
    committer: { date: string }
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i

// Homebrew package names: alphanumeric start, may contain letters, digits,
// dots, underscores, hyphens, @ (for versioned formulae like python@3.12),
// and + (for packages like c++utilities).  No path separators or shell
// metacharacters are allowed.
const PACKAGE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.@+-]*$/

export function isValidPackageName(name: string): boolean {
  return PACKAGE_NAME_PATTERN.test(name)
}

function isValidISODate(value: string): boolean {
  const ts = new Date(value).getTime()
  return Number.isFinite(ts)
}

export function validateGitHubCommits(data: unknown): GitHubCommit[] {
  if (!Array.isArray(data)) {
    throw new Error("Expected array of commits from GitHub API")
  }

  const commits: GitHubCommit[] = []
  for (const item of data) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.sha === "string" &&
      SHA_PATTERN.test(item.sha) &&
      item.commit &&
      typeof item.commit === "object" &&
      typeof item.commit.message === "string" &&
      item.commit.committer &&
      typeof item.commit.committer === "object" &&
      typeof item.commit.committer.date === "string" &&
      isValidISODate(item.commit.committer.date)
    ) {
      commits.push(item as GitHubCommit)
    }
    // Skip malformed entries rather than crashing — downstream code
    // handles empty arrays gracefully
  }

  return commits
}
