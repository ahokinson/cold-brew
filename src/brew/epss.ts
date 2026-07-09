import { type EpssScore, getCachedEpssScores, upsertEpssScores } from "@db"

const EPSS_API_URL = "https://api.first.org/data/v1/epss"
const EPSS_FETCH_TIMEOUT_MILLISECONDS = 10_000
const EPSS_CACHE_TTL_SECONDS = 86_400 // 24h
// FIRST.org's API accepts a comma-separated CVE list; their published limit
// is 100 ids per request. Stay just under to avoid edge-case rejections.
const EPSS_BATCH_SIZE = 80

interface EpssApiRow {
  cve?: string
  epss?: string
  percentile?: string
}

interface EpssApiResponse {
  status?: string
  data?: EpssApiRow[]
}

async function fetchBatch(cveIds: readonly string[]): Promise<Map<string, EpssScore>> {
  const url = `${EPSS_API_URL}?cve=${cveIds.join(",")}&pretty=false`
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(EPSS_FETCH_TIMEOUT_MILLISECONDS),
  })
  if (!response.ok) throw new Error(`GET ${EPSS_API_URL} failed: ${response.status}`)
  const body = (await response.json()) as EpssApiResponse
  const out = new Map<string, EpssScore>()
  for (const row of body.data ?? []) {
    if (!row.cve || !row.epss || !row.percentile) continue
    const score = parseFloat(row.epss)
    const percentile = parseFloat(row.percentile)
    if (!Number.isFinite(score) || !Number.isFinite(percentile)) continue
    out.set(row.cve, { score, percentile })
  }
  return out
}

// Hook so tests can stub the network without monkey-patching globalThis.fetch.
let fetcher: (cveIds: readonly string[]) => Promise<Map<string, EpssScore>> = fetchBatch

export function setEpssFetcher(replacement: (cveIds: readonly string[]) => Promise<Map<string, EpssScore>>): void {
  fetcher = replacement
}

export function resetEpssFetcher(): void {
  fetcher = fetchBatch
}

// Returns EPSS scores for the requested CVE ids. Cached for 24h; missing or
// stale ids are batched against FIRST.org, with the result written back to
// the cache. On network failure the cached subset is returned alone — we'd
// rather miss enrichment for a few CVEs than fail an entire advisory pass.
//
// Ids that aren't CVEs are silently dropped: GHSA-* and MAL-* have no EPSS
// score. Ids absent from the API response stay absent from the result map.
export async function getEpssScores(cveIds: readonly string[]): Promise<Map<string, EpssScore>> {
  const cves = [...new Set(cveIds.filter((id) => id.startsWith("CVE-")))]
  if (cves.length === 0) return new Map()

  const cached = getCachedEpssScores(cves, EPSS_CACHE_TTL_SECONDS)
  const missing = cves.filter((id) => !cached.has(id))
  if (missing.length === 0) return cached

  const fetched = new Map<string, EpssScore>()
  for (let i = 0; i < missing.length; i += EPSS_BATCH_SIZE) {
    const chunk = missing.slice(i, i + EPSS_BATCH_SIZE)
    try {
      const batch = await fetcher(chunk)
      for (const [cveId, value] of batch) fetched.set(cveId, value)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`cold-brew: EPSS lookup failed (${message}); using cached subset`)
      break
    }
  }

  if (fetched.size > 0) upsertEpssScores(fetched)

  const result = new Map<string, EpssScore>(cached)
  for (const [cveId, value] of fetched) result.set(cveId, value)
  return result
}
