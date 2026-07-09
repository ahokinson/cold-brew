import { getKevCacheStatus, type KevCacheStatus, replaceKevCache } from "@db"

const KEV_FEED_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
const KEV_FETCH_TIMEOUT_MILLISECONDS = 10_000
const KEV_CACHE_TTL_SECONDS = 86_400 // 24h

interface CisaKevFeed {
  vulnerabilities?: Array<{ cveID?: string }>
}

function isFresh(status: KevCacheStatus, nowSeconds: number): boolean {
  if (status.fetchedAt === null) return false
  return nowSeconds - status.fetchedAt < KEV_CACHE_TTL_SECONDS
}

async function fetchCatalog(): Promise<string[]> {
  const response = await fetch(KEV_FEED_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(KEV_FETCH_TIMEOUT_MILLISECONDS),
  })
  if (!response.ok) throw new Error(`GET ${KEV_FEED_URL} failed: ${response.status}`)
  const body = (await response.json()) as CisaKevFeed
  const out: string[] = []
  for (const entry of body.vulnerabilities ?? []) {
    const id = entry.cveID
    if (typeof id === "string" && id.startsWith("CVE-")) out.push(id)
  }
  return out
}

// Hook so tests can stub the network without monkey-patching globalThis.fetch.
let fetcher: () => Promise<string[]> = fetchCatalog

export function setKevFetcher(replacement: () => Promise<string[]>): void {
  fetcher = replacement
}

export function resetKevFetcher(): void {
  fetcher = fetchCatalog
}

// Returns the CVE ids in the CISA Known Exploited Vulnerabilities catalog.
// Caches for 24h. On network failure, falls back to the stale set if one
// exists (better than treating every advisory as non-KEV during a CISA
// outage); otherwise returns an empty set.
export async function getKevCatalog(): Promise<Set<string>> {
  const status = getKevCacheStatus()
  const now = Math.floor(Date.now() / 1000)
  if (isFresh(status, now)) return status.cveIds

  try {
    const ids = await fetcher()
    replaceKevCache(ids)
    return new Set(ids)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`cold-brew: KEV catalog refresh failed (${message}); using cached set`)
    return status.cveIds
  }
}
