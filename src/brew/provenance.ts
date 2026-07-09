import { githubRequestHeaders, hasGitHubToken, repoConfig } from "@brew/api"
import { runWithConcurrencyLimit } from "@brew/concurrency"
import { type Package, Provenance } from "@brew/types"
import { cacheProvenance, getCachedProvenance, getKnownAuthors, recordAuthors } from "@db"

const GITHUB_API = "https://api.github.com"
const FETCH_TIMEOUT_MILLISECONDS = 10_000
const MAX_CONCURRENT_PROVENANCE = 5
// Cap the number of commits examined per formula. Real-world abuse signals
// land in the last few commits; pulling more burns rate-limit budget without
// adding signal.
const MAX_COMMITS_PER_FORMULA = 20
// Maximum patch length per commit we'll regex-scan. Large diffs are usually
// version bumps with lots of `bottle do` block churn; the suspicious-pattern
// signals show up in the first kilobytes if they're there at all.
const MAX_PATCH_BYTES = 32 * 1024

interface GhCommitListItem {
  sha: string
  html_url?: string
  author?: { login?: string | null } | null
  commit?: { author?: { name?: string; date?: string } | null }
}

interface GhCommitDetail {
  sha: string
  html_url?: string
  author?: { login?: string | null } | null
  commit?: { author?: { name?: string; date?: string } | null }
  files?: Array<{ filename?: string; patch?: string }>
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: githubRequestHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
  })
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`)
  return response.json()
}

function authorOf(commit: GhCommitListItem | GhCommitDetail): string | null {
  // Prefer GitHub login when present; fall back to git author name so that
  // unattached commits (no linked GH account) still contribute to the
  // known-authors set.
  return commit.author?.login || commit.commit?.author?.name || null
}

const SYSTEM_CALL_PATTERN = /^\+[^+\n]*\bsystem\s+["'](curl|wget|sh|bash|\/bin\/sh|fetch)\b/m
const INREPLACE_PATTERN = /^\+[^+\n]*\binreplace\b/m

function findHeuristicFlags(patch: string, commitSha: string, commitUrl: string): Provenance.Flag[] {
  const sample = patch.length > MAX_PATCH_BYTES ? patch.slice(0, MAX_PATCH_BYTES) : patch
  const flags: Provenance.Flag[] = []
  const systemMatch = sample.match(SYSTEM_CALL_PATTERN)
  if (systemMatch) {
    flags.push({
      kind: Provenance.FlagKind.SystemCall,
      detail: systemMatch[0].trim().slice(0, 120),
      commitSha,
      commitUrl,
    })
  }
  const inreplaceMatch = sample.match(INREPLACE_PATTERN)
  if (inreplaceMatch) {
    flags.push({
      kind: Provenance.FlagKind.Inreplace,
      detail: inreplaceMatch[0].trim().slice(0, 120),
      commitSha,
      commitUrl,
    })
  }
  return flags
}

interface ProvenanceTarget {
  name: string
  isCask: boolean
  tap: string
  installedAt: number
}

// Default network implementations. Held as named consts so the test hooks
// below and resetProvenanceFetchers share one definition (no duplication).
const defaultListFetcher = async (repo: string, path: string, since: string): Promise<GhCommitListItem[]> => {
  const url = `${GITHUB_API}/repos/${repo}/commits?path=${encodeURIComponent(path)}&since=${encodeURIComponent(since)}&per_page=${MAX_COMMITS_PER_FORMULA}`
  const body = await getJson(url)
  return Array.isArray(body) ? (body as GhCommitListItem[]) : []
}

const defaultDetailFetcher = async (repo: string, sha: string): Promise<GhCommitDetail | null> => {
  const url = `${GITHUB_API}/repos/${repo}/commits/${sha}`
  try {
    const body = await getJson(url)
    return body as GhCommitDetail
  } catch {
    return null
  }
}

// Hook for tests: stub the network without touching globalThis.fetch.
let listFetcher = defaultListFetcher
let detailFetcher = defaultDetailFetcher

export function setProvenanceListFetcher(
  fn: (repo: string, path: string, since: string) => Promise<GhCommitListItem[]>,
): void {
  listFetcher = fn
}

export function setProvenanceDetailFetcher(fn: (repo: string, sha: string) => Promise<GhCommitDetail | null>): void {
  detailFetcher = fn
}

export function resetProvenanceFetchers(): void {
  listFetcher = defaultListFetcher
  detailFetcher = defaultDetailFetcher
}

async function buildSummary(target: ProvenanceTarget, rangeFrom: number): Promise<Provenance.Summary> {
  const { repo, path } = repoConfig(target.tap, target.isCask)
  const since = new Date(rangeFrom * 1000).toISOString()
  const list = await listFetcher(repo, path(target.name), since)
  if (list.length === 0) {
    return { flags: [], commitsScanned: 0, rangeFrom }
  }

  // Seed the known-authors set on first observation. If the table is empty
  // for this formula, every author on the historical list is "known" — we
  // can't claim someone is new if we have nothing to compare against. The
  // *next* run is when new-maintainer detection starts firing.
  const known = getKnownAuthors(target.name)
  const seenThisRun = new Set<string>()
  for (const commit of list) {
    const author = authorOf(commit)
    if (author) seenThisRun.add(author)
  }
  const firstRun = known.size === 0
  if (firstRun) {
    recordAuthors(target.name, seenThisRun)
  }

  const flags: Provenance.Flag[] = []
  // Fetch per-commit detail concurrently for the patch scan. The list
  // endpoint doesn't return file diffs.
  const sliced = list.slice(0, MAX_COMMITS_PER_FORMULA)
  const details = await runWithConcurrencyLimit(sliced, MAX_CONCURRENT_PROVENANCE, (commit) =>
    detailFetcher(repo, commit.sha),
  )

  const newAuthorsToRecord = new Set<string>()
  for (let i = 0; i < sliced.length; i++) {
    const commit = sliced[i]!
    const detail = details[i]
    const author = authorOf(commit)
    const sha = commit.sha
    const url = commit.html_url ?? `https://github.com/${repo}/commit/${sha}`

    if (!firstRun && author && !known.has(author) && !newAuthorsToRecord.has(author)) {
      flags.push({
        kind: Provenance.FlagKind.NewMaintainer,
        detail: `${author} has not authored this formula before`,
        commitSha: sha,
        commitUrl: url,
      })
      newAuthorsToRecord.add(author)
    }

    if (detail && !(detail instanceof Error)) {
      for (const file of detail.files ?? []) {
        if (!file.patch) continue
        // Only scan the formula file itself; sibling file changes
        // (e.g. font casks touching multiple files) aren't informative for
        // this formula's provenance.
        if (file.filename && !file.filename.endsWith(`/${target.name}.rb`) && file.filename !== `${target.name}.rb`) {
          continue
        }
        flags.push(...findHeuristicFlags(file.patch, sha, url))
      }
    }
  }
  if (newAuthorsToRecord.size > 0) recordAuthors(target.name, newAuthorsToRecord)

  return { flags, commitsScanned: sliced.length, rangeFrom }
}

// Returns a Map keyed by package name. Packages outside the supported scope
// (no tap support, no token, fetch failure) are absent — the caller treats
// missing entries as `provenance: null`.
//
// Scope for v1: `homebrew/core` only. Casks and third-party taps have
// different exposure shapes and will land in a follow-on.
export async function fetchProvenanceBatch(
  packages: readonly Package.Info[],
  onProgress?: (completed: number, total: number) => void,
): Promise<Map<string, Provenance.Summary>> {
  const result = new Map<string, Provenance.Summary>()
  if (!hasGitHubToken()) return result

  const targets = packages.filter(
    (pkg) => pkg.outdated && pkg.tap === "homebrew/core" && !pkg.isCask && pkg.installedAt > 0,
  )
  if (targets.length === 0) return result

  // Try cache first. Hits short-circuit the network entirely.
  const uncached: Package.Info[] = []
  for (const pkg of targets) {
    const cached = getCachedProvenance(pkg.name)
    if (cached) {
      result.set(pkg.name, cached)
    } else {
      uncached.push(pkg)
    }
  }
  if (uncached.length === 0) return result

  let completed = 0
  const built = await runWithConcurrencyLimit(uncached, MAX_CONCURRENT_PROVENANCE, async (pkg) => {
    try {
      const summary = await buildSummary(
        { name: pkg.name, isCask: pkg.isCask, tap: pkg.tap, installedAt: pkg.installedAt },
        pkg.installedAt,
      )
      return { name: pkg.name, summary }
    } catch {
      return { name: pkg.name, summary: null as Provenance.Summary | null }
    } finally {
      completed++
      onProgress?.(completed, uncached.length)
    }
  })

  for (const entry of built) {
    if (entry instanceof Error) continue
    if (!entry.summary) continue
    result.set(entry.name, entry.summary)
    cacheProvenance(entry.name, entry.summary)
  }
  return result
}
