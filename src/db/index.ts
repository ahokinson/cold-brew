import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Advisory, Hold, Package, Provenance } from "@brew/types"
import { migrate } from "@db/migrate"
import * as schema from "@db/schema"
import { and, eq, gt, inArray, sql } from "drizzle-orm"
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite"

const DB_DIR = process.env.COLD_BREW_DB_DIR ?? join(homedir(), ".config", "cold-brew")
const DB_PATH = join(DB_DIR, "cold-brew.db")

let _db: BunSQLiteDatabase<typeof schema> | null = null
let _rawDb: Database | null = null

export function getDb(): BunSQLiteDatabase<typeof schema> {
  if (_db) return _db

  mkdirSync(DB_DIR, { recursive: true, mode: 0o700 })
  _rawDb = new Database(DB_PATH)
  chmodSync(DB_PATH, 0o600)
  _rawDb.exec("PRAGMA journal_mode=WAL")
  _rawDb.exec("PRAGMA foreign_keys=ON")
  // WAL sidecars are created under the umask, not the main file's 0600. The
  // 0700 dir is the real guard; tighten them too once WAL has made them.
  for (const suffix of ["-wal", "-shm"]) {
    try {
      chmodSync(`${DB_PATH}${suffix}`, 0o600)
    } catch {}
  }

  migrate(_rawDb)
  _db = drizzle(_rawDb, { schema })

  _db.insert(schema.config).values({ key: "hold_days", value: "7" }).onConflictDoNothing().run()

  _db.insert(schema.config).values({ key: "auto_bypass_cvss", value: "7.0" }).onConflictDoNothing().run()

  _db.insert(schema.config).values({ key: "auto_bypass_kev", value: "true" }).onConflictDoNothing().run()

  _db.insert(schema.config).values({ key: "auto_bypass_epss", value: "disabled" }).onConflictDoNothing().run()

  _rawDb.exec(`DELETE FROM upgrade_log WHERE upgraded_at < unixepoch() - ${UPGRADE_LOG_RETENTION_SECONDS}`)

  return _db
}

export function resetDb(): void {
  if (_rawDb) {
    _rawDb.close()
    _rawDb = null
  }
  _db = null
  rmSync(DB_PATH, { force: true })
  rmSync(`${DB_PATH}-wal`, { force: true })
  rmSync(`${DB_PATH}-shm`, { force: true })
}

export function getConfig(key: string): string | undefined {
  const db = getDb()
  const row = db.select({ value: schema.config.value }).from(schema.config).where(eq(schema.config.key, key)).get()
  return row?.value
}

export function setConfig(key: string, value: string): void {
  getDb()
    .insert(schema.config)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.config.key,
      set: { value },
    })
    .run()
}

export function getHoldDays(): number {
  const raw = getConfig("hold_days") ?? "7"
  const days = parseInt(raw, 10)
  if (!Number.isFinite(days) || days < 0) return 7
  return days
}

export function setHoldDays(days: number): void {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error("hold_days must be a non-negative integer")
  }
  setConfig("hold_days", String(days))
}

const DEFAULT_AUTO_BYPASS_CVSS = 7.0

export function getAutoBypassThreshold(): number {
  const raw = getConfig("auto_bypass_cvss") ?? String(DEFAULT_AUTO_BYPASS_CVSS)
  const value = parseFloat(raw)
  if (!Number.isFinite(value) || value < 0) return DEFAULT_AUTO_BYPASS_CVSS
  return Math.min(value, 10)
}

export function setAutoBypassThreshold(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 10) {
    throw new Error("auto_bypass_cvss must be between 0 and 10")
  }
  setConfig("auto_bypass_cvss", String(value))
}

const DEFAULT_AUTO_BYPASS_KEV = true

export function getAutoBypassKev(): boolean {
  // Stored as "true"/"false". Treat anything unrecognized as the default so a
  // hand-edited config row can't accidentally disable a safety signal.
  const raw = getConfig("auto_bypass_kev")
  if (raw === "true") return true
  if (raw === "false") return false
  return DEFAULT_AUTO_BYPASS_KEV
}

export function setAutoBypassKev(value: boolean): void {
  setConfig("auto_bypass_kev", value ? "true" : "false")
}

export const EPSS_DISABLED = "disabled" as const

// Returns the EPSS threshold (0–1) at or above which a fixable advisory
// bypasses the hold window. `null` means the signal is disabled — EPSS is
// predictive, not confirmed, so we default off and require explicit opt-in.
export function getAutoBypassEpss(): number | null {
  const raw = getConfig("auto_bypass_epss")
  if (!raw || raw === EPSS_DISABLED) return null
  const value = parseFloat(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) return null
  return value
}

export function setAutoBypassEpss(value: number | typeof EPSS_DISABLED): void {
  if (value === EPSS_DISABLED) {
    setConfig("auto_bypass_epss", EPSS_DISABLED)
    return
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("auto_bypass_epss must be between 0 and 1 or 'disabled'")
  }
  setConfig("auto_bypass_epss", String(value))
}

const VALID_POLICIES = new Set<string>(["always-hold", "always-allow", "default"])

export function getPackagePolicy(name: string): Hold.Policy {
  const db = getDb()
  const row = db
    .select({ holdPolicy: schema.packageSettings.holdPolicy })
    .from(schema.packageSettings)
    .where(eq(schema.packageSettings.name, name))
    .get()
  const policy = row?.holdPolicy ?? "default"
  return VALID_POLICIES.has(policy) ? (policy as Hold.Policy) : "default"
}

export function setPackagePolicy(name: string, policy: Hold.Policy): void {
  const db = getDb()
  if (policy === "default") {
    const row = db
      .select({
        pinnedVersion: schema.packageSettings.pinnedVersion,
        originalTap: schema.packageSettings.originalTap,
      })
      .from(schema.packageSettings)
      .where(eq(schema.packageSettings.name, name))
      .get()
    // Keep the row if a pin or original_tap is set — stepping needs the
    // mapping to keep walking upstream history.
    if (!row?.pinnedVersion && !row?.originalTap) {
      db.delete(schema.packageSettings).where(eq(schema.packageSettings.name, name)).run()
    } else {
      db.update(schema.packageSettings)
        .set({
          holdPolicy: policy,
          updatedAt: sql`unixepoch()`.mapWith(Number),
        })
        .where(eq(schema.packageSettings.name, name))
        .run()
    }
  } else {
    db.insert(schema.packageSettings)
      .values({
        name,
        holdPolicy: policy,
        updatedAt: sql`unixepoch()`.mapWith(Number),
      })
      .onConflictDoUpdate({
        target: schema.packageSettings.name,
        set: {
          holdPolicy: policy,
          updatedAt: sql`unixepoch()`.mapWith(Number),
        },
      })
      .run()
  }
}

export function getAllPolicies(): Array<{
  name: string
  holdPolicy: "always-hold" | "always-allow"
}> {
  const db = getDb()
  const rows = db
    .select({
      name: schema.packageSettings.name,
      holdPolicy: schema.packageSettings.holdPolicy,
    })
    .from(schema.packageSettings)
    .where(sql`${schema.packageSettings.holdPolicy} != 'default'`)
    .all()

  return rows.map((row) => ({
    name: row.name,
    holdPolicy: row.holdPolicy as "always-hold" | "always-allow",
  }))
}

export function setVersionPin(name: string, version: string): void {
  getDb()
    .insert(schema.packageSettings)
    .values({
      name,
      pinnedVersion: version,
      updatedAt: sql`unixepoch()`.mapWith(Number),
    })
    .onConflictDoUpdate({
      target: schema.packageSettings.name,
      set: {
        pinnedVersion: version,
        updatedAt: sql`unixepoch()`.mapWith(Number),
      },
    })
    .run()
}

export function clearVersionPin(name: string): void {
  const db = getDb()
  const row = db
    .select({
      holdPolicy: schema.packageSettings.holdPolicy,
      originalTap: schema.packageSettings.originalTap,
    })
    .from(schema.packageSettings)
    .where(eq(schema.packageSettings.name, name))
    .get()

  if (!row || (row.holdPolicy === "default" && !row.originalTap)) {
    db.delete(schema.packageSettings).where(eq(schema.packageSettings.name, name)).run()
  } else {
    db.update(schema.packageSettings)
      .set({
        pinnedVersion: null,
        updatedAt: sql`unixepoch()`.mapWith(Number),
      })
      .where(eq(schema.packageSettings.name, name))
      .run()
  }
}

export function getVersionPin(name: string): string | null {
  const db = getDb()
  const row = db
    .select({ pinnedVersion: schema.packageSettings.pinnedVersion })
    .from(schema.packageSettings)
    .where(eq(schema.packageSettings.name, name))
    .get()
  return row?.pinnedVersion ?? null
}

export function setOriginalTap(name: string, tap: string): void {
  getDb()
    .insert(schema.packageSettings)
    .values({
      name,
      originalTap: tap,
      updatedAt: sql`unixepoch()`.mapWith(Number),
    })
    .onConflictDoUpdate({
      target: schema.packageSettings.name,
      set: {
        originalTap: tap,
        updatedAt: sql`unixepoch()`.mapWith(Number),
      },
    })
    .run()
}

export function getOriginalTap(name: string): string | null {
  const db = getDb()
  const row = db
    .select({ originalTap: schema.packageSettings.originalTap })
    .from(schema.packageSettings)
    .where(eq(schema.packageSettings.name, name))
    .get()
  return row?.originalTap ?? null
}

export function getAllVersionPins(): Map<string, string> {
  const db = getDb()
  const rows = db
    .select({
      name: schema.packageSettings.name,
      pinnedVersion: schema.packageSettings.pinnedVersion,
    })
    .from(schema.packageSettings)
    .where(sql`${schema.packageSettings.pinnedVersion} IS NOT NULL`)
    .all()
  return new Map(rows.map((row) => [row.name, row.pinnedVersion!]))
}

export function logUpgrade(name: string, fromVersion: string, toVersion: string, heldDays: number | null): void {
  getDb().insert(schema.upgradeLog).values({ name, fromVersion, toVersion, heldDays }).run()
}

const UPGRADE_LOG_RETENTION_SECONDS = 31536000

const CACHE_MAX_AGE_SECONDS = 300

const BREW_INFO_MAX_AGE_SECONDS = 3600
const CASK_DATE_MAX_AGE_SECONDS = 86400
const NEGATIVE_CACHE_MAX_AGE_SECONDS = 3600

export function ensureCacheEntries(entries: Array<{ name: string; isCask: boolean }>): void {
  const db = getDb()
  db.transaction(() => {
    for (const entry of entries) {
      db.insert(schema.metadataCache)
        .values({ packageName: entry.name, isCask: entry.isCask ? 1 : 0, infoCachedAt: 0 })
        .onConflictDoUpdate({
          target: schema.metadataCache.packageName,
          set: { isCask: entry.isCask ? 1 : 0 },
        })
        .run()
    }
  })
}

export interface MetadataCacheEntry {
  packageName: string
  description: string | null
  latestVersion: string | null
  tap: string | null
  installedTime: number | null
}

export function getCachedMetadata(names: string[]): Map<string, MetadataCacheEntry> {
  if (names.length === 0) return new Map()
  const db = getDb()
  const rows = db
    .select()
    .from(schema.metadataCache)
    .where(
      and(
        inArray(schema.metadataCache.packageName, names),
        gt(schema.metadataCache.infoCachedAt, sql<number>`unixepoch() - ${BREW_INFO_MAX_AGE_SECONDS}`),
      ),
    )
    .all()

  const result = new Map<string, MetadataCacheEntry>()
  for (const row of rows) {
    result.set(row.packageName, {
      packageName: row.packageName,
      description: row.description,
      latestVersion: row.latestVersion,
      tap: row.tap,
      installedTime: row.installedTime,
    })
  }
  return result
}

export function cacheMetadata(entries: MetadataCacheEntry[]): void {
  if (entries.length === 0) return
  const db = getDb()
  db.transaction(() => {
    for (const entry of entries) {
      db.insert(schema.metadataCache)
        .values({
          packageName: entry.packageName,
          description: entry.description,
          latestVersion: entry.latestVersion,
          tap: entry.tap,
          installedTime: entry.installedTime,
          infoCachedAt: sql`unixepoch()`.mapWith(Number),
        })
        .onConflictDoUpdate({
          target: schema.metadataCache.packageName,
          set: {
            description: entry.description,
            latestVersion: entry.latestVersion,
            tap: entry.tap,
            installedTime: entry.installedTime,
            infoCachedAt: sql`unixepoch()`.mapWith(Number),
            dateCachedAt: sql`CASE WHEN ${schema.metadataCache.latestVersion} = ${entry.latestVersion} THEN ${schema.metadataCache.dateCachedAt} ELSE NULL END`,
          },
        })
        .run()
    }
  })
}

export interface PublishDateCacheEntry {
  packageName: string
  sourceModifiedAt: number
}

export function getCachedPublishDates(names: string[]): Map<string, number> {
  if (names.length === 0) return new Map()
  const db = getDb()
  const rows = db
    .select()
    .from(schema.metadataCache)
    .where(
      and(
        inArray(schema.metadataCache.packageName, names),
        // Exclude the -1 sentinel written by cacheNegativePublishDates. The
        // negative cache has a shorter TTL than the positive one, so without
        // this guard a stale -1 leaks back through as if it were a real date.
        gt(schema.metadataCache.sourceModifiedAt, 0),
        gt(schema.metadataCache.dateCachedAt, sql<number>`unixepoch() - ${CASK_DATE_MAX_AGE_SECONDS}`),
      ),
    )
    .all()

  const result = new Map<string, number>()
  for (const row of rows) {
    if (row.sourceModifiedAt !== null) {
      result.set(row.packageName, row.sourceModifiedAt)
    }
  }
  return result
}

export function cachePublishDates(entries: PublishDateCacheEntry[]): void {
  if (entries.length === 0) return
  const db = getDb()
  db.transaction(() => {
    for (const entry of entries) {
      db.insert(schema.metadataCache)
        .values({
          packageName: entry.packageName,
          sourceModifiedAt: entry.sourceModifiedAt,
          dateCachedAt: sql`unixepoch()`.mapWith(Number),
        })
        .onConflictDoUpdate({
          target: schema.metadataCache.packageName,
          set: {
            sourceModifiedAt: entry.sourceModifiedAt,
            dateCachedAt: sql`unixepoch()`.mapWith(Number),
          },
        })
        .run()
    }
  })
}

export function getCachedNegativePublishDates(names: string[]): Set<string> {
  if (names.length === 0) return new Set()
  const db = getDb()
  const rows = db
    .select({ packageName: schema.metadataCache.packageName })
    .from(schema.metadataCache)
    .where(
      and(
        inArray(schema.metadataCache.packageName, names),
        eq(schema.metadataCache.sourceModifiedAt, -1),
        gt(schema.metadataCache.dateCachedAt, sql<number>`unixepoch() - ${NEGATIVE_CACHE_MAX_AGE_SECONDS}`),
      ),
    )
    .all()

  return new Set(rows.map((row) => row.packageName))
}

export function cacheNegativePublishDates(names: string[]): void {
  if (names.length === 0) return
  const db = getDb()
  db.transaction(() => {
    for (const name of names) {
      db.insert(schema.metadataCache)
        .values({
          packageName: name,
          sourceModifiedAt: -1,
          dateCachedAt: sql`unixepoch()`.mapWith(Number),
        })
        .onConflictDoUpdate({
          target: schema.metadataCache.packageName,
          set: {
            sourceModifiedAt: -1,
            dateCachedAt: sql`unixepoch()`.mapWith(Number),
          },
        })
        .run()
    }
  })
}

export function clearAllCaches(): void {
  const db = getDb()
  db.transaction(() => {
    db.delete(schema.metadataCache).run()
    db.delete(schema.packageCache).run()
    db.delete(schema.advisoryCache).run()
    db.delete(schema.kevCache).run()
    db.delete(schema.epssCache).run()
    db.delete(schema.provenanceCache).run()
    db.delete(schema.provenanceAuthors).run()
  })
}

export function cachePackages(packages: Package.Info[]): void {
  const db = getDb()
  db.transaction((transaction) => {
    for (const pkg of packages) {
      const values = {
        name: pkg.name,
        installedVersion: pkg.installedVersion,
        latestVersion: pkg.latestVersion,
        installedAt: pkg.installedAt,
        sourceModifiedAt: pkg.sourceModifiedAt,
        isLeaf: pkg.isLeaf ? 1 : 0,
        installedAsDependency: pkg.installedAsDependency ? 1 : 0,
        installedOnRequest: pkg.installedOnRequest ? 1 : 0,
        pinned: pkg.pinned ? 1 : 0,
        outdated: pkg.outdated ? 1 : 0,
        tap: pkg.tap,
        description: pkg.description,
        isCask: pkg.isCask ? 1 : 0,
        dateConfidence: pkg.dateConfidence,
        cachedAt: sql`unixepoch()`.mapWith(Number),
      }
      transaction
        .insert(schema.packageCache)
        .values(values)
        .onConflictDoUpdate({
          target: schema.packageCache.name,
          set: values,
        })
        .run()
    }
  })
}

export function getCachedPackages(): Package.Info[] | null {
  const db = getDb()
  const rows = db
    .select()
    .from(schema.packageCache)
    .where(gt(schema.packageCache.cachedAt, sql<number>`unixepoch() - ${CACHE_MAX_AGE_SECONDS}`))
    .orderBy(schema.packageCache.name)
    .all()

  if (rows.length === 0) return null

  return rows.map(packageCacheRowToInfo)
}

// WARNING: Returns cached data with no age check. Use ONLY for display/initial
// rendering — never for upgrade decisions. The CLI upgrade path (handleUpgrade)
// always evaluates from fresh brew data to prevent stale cache from bypassing holds.
export function getStaleCachedPackages(): Package.Info[] | null {
  const db = getDb()
  const rows = db.select().from(schema.packageCache).orderBy(schema.packageCache.name).all()

  if (rows.length === 0) return null

  return rows.map(packageCacheRowToInfo)
}

const ADVISORY_CACHE_MAX_AGE_SECONDS = 21600 // 6h

export interface AdvisoryCacheEntry {
  packageName: string
  installedVersion: string
  latestVersion: string | null
  summary: Advisory.Summary
  sources: string[]
}

export function getCachedAdvisories(
  requests: Array<{ name: string; installedVersion: string; latestVersion: string | null }>,
): Map<string, Advisory.Summary> {
  if (requests.length === 0) return new Map()
  const db = getDb()
  const names = requests.map((r) => r.name)
  const rows = db
    .select()
    .from(schema.advisoryCache)
    .where(
      and(
        inArray(schema.advisoryCache.packageName, names),
        gt(schema.advisoryCache.fetchedAt, sql<number>`unixepoch() - ${ADVISORY_CACHE_MAX_AGE_SECONDS}`),
      ),
    )
    .all()

  const byName = new Map(rows.map((r) => [r.packageName, r]))
  const result = new Map<string, Advisory.Summary>()
  for (const request of requests) {
    const row = byName.get(request.name)
    if (!row) continue
    if (row.installedVersion !== request.installedVersion) continue
    if ((row.latestVersion ?? null) !== (request.latestVersion ?? null)) continue
    try {
      const entries = JSON.parse(row.advisoriesJson) as Advisory.Entry[]
      // Recompute maxEpss from entries instead of storing it as a column:
      // the per-entry `epss` already rides in the JSON blob, and EPSS scores
      // refresh on their own 24h cadence independent of advisory_cache.
      let maxEpss: number | null = null
      for (const entry of entries) {
        if (entry.kind !== "vulnerability") continue
        if (entry.epss !== null && (maxEpss === null || entry.epss > maxEpss)) maxEpss = entry.epss
      }
      result.set(request.name, {
        entries,
        maxCvss: row.maxCvss,
        hasActionableFix: row.hasFixInLatest === 1,
        hasKevListed: row.hasKevListed === 1,
        maxEpss,
      })
    } catch {
      // Malformed cache row — skip so the fetcher refreshes it
    }
  }
  return result
}

export function cacheAdvisories(entries: AdvisoryCacheEntry[]): void {
  if (entries.length === 0) return
  const db = getDb()
  db.transaction(() => {
    for (const entry of entries) {
      const values = {
        packageName: entry.packageName,
        installedVersion: entry.installedVersion,
        latestVersion: entry.latestVersion,
        advisoriesJson: JSON.stringify(entry.summary.entries),
        maxCvss: entry.summary.maxCvss,
        hasFixInLatest: entry.summary.hasActionableFix ? 1 : 0,
        hasKevListed: entry.summary.hasKevListed ? 1 : 0,
        sources: entry.sources.join(","),
        fetchedAt: sql`unixepoch()`.mapWith(Number),
      }
      db.insert(schema.advisoryCache)
        .values(values)
        .onConflictDoUpdate({
          target: schema.advisoryCache.packageName,
          set: values,
        })
        .run()
    }
  })
}

export function clearAdvisoryCache(): void {
  getDb().delete(schema.advisoryCache).run()
}

export interface KevCacheStatus {
  cveIds: Set<string>
  // Unix-epoch seconds of the most recent fetch. null when no rows exist.
  // Callers compare this against their own TTL to decide whether to refresh.
  fetchedAt: number | null
}

export function getKevCacheStatus(): KevCacheStatus {
  const db = getDb()
  const rows = db
    .select({ cveId: schema.kevCache.cveId, fetchedAt: schema.kevCache.fetchedAt })
    .from(schema.kevCache)
    .all()
  if (rows.length === 0) return { cveIds: new Set(), fetchedAt: null }
  let latest = 0
  const cveIds = new Set<string>()
  for (const row of rows) {
    cveIds.add(row.cveId)
    if (row.fetchedAt > latest) latest = row.fetchedAt
  }
  return { cveIds, fetchedAt: latest }
}

export function replaceKevCache(cveIds: readonly string[]): void {
  const db = getDb()
  db.transaction(() => {
    db.delete(schema.kevCache).run()
    if (cveIds.length === 0) return
    // Stamp fetched_at explicitly. The schema's sql`(unixepoch())` default
    // only fires when the column is omitted by the underlying SQL, and
    // drizzle still binds `null` for it on bulk insert, defeating the
    // default. Setting it here keeps freshness checks honest.
    const fetchedAt = Math.floor(Date.now() / 1000)
    // SQLite caps inserts at 999 bound variables per statement; chunk to stay
    // well under that even if CISA's catalog grows another order of magnitude.
    const CHUNK = 500
    for (let i = 0; i < cveIds.length; i += CHUNK) {
      const chunk = cveIds.slice(i, i + CHUNK)
      db.insert(schema.kevCache)
        .values(chunk.map((cveId) => ({ cveId, fetchedAt })))
        .run()
    }
  })
}

export function clearKevCache(): void {
  getDb().delete(schema.kevCache).run()
}

export interface EpssScore {
  score: number
  percentile: number
}

// Reads cached EPSS scores for the given CVE ids that are still within the
// TTL. Returns a Map keyed by CVE id. Missing or stale ids are absent, so
// the caller knows which ones to refetch.
export function getCachedEpssScores(cveIds: readonly string[], maxAgeSeconds: number): Map<string, EpssScore> {
  if (cveIds.length === 0) return new Map()
  const db = getDb()
  const rows = db
    .select()
    .from(schema.epssCache)
    .where(
      and(
        inArray(schema.epssCache.cveId, [...cveIds]),
        gt(schema.epssCache.fetchedAt, sql<number>`unixepoch() - ${maxAgeSeconds}`),
      ),
    )
    .all()
  const result = new Map<string, EpssScore>()
  for (const row of rows) {
    result.set(row.cveId, { score: row.score, percentile: row.percentile })
  }
  return result
}

export function upsertEpssScores(scores: ReadonlyMap<string, EpssScore>): void {
  if (scores.size === 0) return
  const db = getDb()
  const fetchedAt = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    for (const [cveId, value] of scores) {
      const values = { cveId, score: value.score, percentile: value.percentile, fetchedAt }
      db.insert(schema.epssCache)
        .values(values)
        .onConflictDoUpdate({ target: schema.epssCache.cveId, set: values })
        .run()
    }
  })
}

export function clearEpssCache(): void {
  getDb().delete(schema.epssCache).run()
}

// --- Provenance ---

const PROVENANCE_CACHE_MAX_AGE_SECONDS = 86_400 // 24h

export function getKnownAuthors(formula: string): Set<string> {
  const db = getDb()
  const rows = db
    .select({ author: schema.provenanceAuthors.author })
    .from(schema.provenanceAuthors)
    .where(eq(schema.provenanceAuthors.formula, formula))
    .all()
  return new Set(rows.map((r) => r.author))
}

export function recordAuthors(formula: string, authors: Iterable<string>): void {
  const db = getDb()
  const values = [...authors]
    .filter((a) => a && a.length > 0)
    .map((author) => ({ formula, author, firstSeen: Math.floor(Date.now() / 1000) }))
  if (values.length === 0) return
  db.transaction(() => {
    for (const value of values) {
      db.insert(schema.provenanceAuthors).values(value).onConflictDoNothing().run()
    }
  })
}

export function getCachedProvenance(formula: string): Provenance.Summary | null {
  const db = getDb()
  const row = db
    .select()
    .from(schema.provenanceCache)
    .where(
      and(
        eq(schema.provenanceCache.formula, formula),
        gt(schema.provenanceCache.fetchedAt, sql<number>`unixepoch() - ${PROVENANCE_CACHE_MAX_AGE_SECONDS}`),
      ),
    )
    .get()
  if (!row) return null
  try {
    return JSON.parse(row.summaryJson) as Provenance.Summary
  } catch {
    return null
  }
}

export function cacheProvenance(formula: string, summary: Provenance.Summary): void {
  const db = getDb()
  const values = {
    formula,
    summaryJson: JSON.stringify(summary),
    fetchedAt: Math.floor(Date.now() / 1000),
  }
  db.insert(schema.provenanceCache)
    .values(values)
    .onConflictDoUpdate({ target: schema.provenanceCache.formula, set: values })
    .run()
}

export function clearProvenanceCaches(): void {
  const db = getDb()
  db.transaction(() => {
    db.delete(schema.provenanceCache).run()
    db.delete(schema.provenanceAuthors).run()
  })
}

function packageCacheRowToInfo(row: typeof schema.packageCache.$inferSelect): Package.Info {
  return {
    name: row.name,
    installedVersion: row.installedVersion ?? "unknown",
    latestVersion: row.latestVersion,
    installedAt: row.installedAt ?? 0,
    sourceModifiedAt: row.sourceModifiedAt ?? 0,
    isLeaf: row.isLeaf === 1,
    installedAsDependency: row.installedAsDependency === 1,
    installedOnRequest: row.installedOnRequest === 1,
    pinned: row.pinned === 1,
    outdated: row.outdated === 1,
    // Not persisted in the package cache: needsRelink is derived from a fresh
    // `brew outdated` call (withOutdatedInfo), so cached snapshots always
    // start it false. Reset on every refresh.
    needsRelink: false,
    tap: row.tap ?? "unknown",
    // originTap isn't a cache column; derive it. For stepped packages the
    // upstream tap lives in package_settings.original_tap. `trusted` is left
    // conservative here and recomputed against trust.json at the render sink.
    originTap: row.tap === "cold-brew/cold-brew" ? (getOriginalTap(row.name) ?? row.tap) : (row.tap ?? "unknown"),
    trusted: false,
    description: row.description,
    isCask: row.isCask === 1,
    dateConfidence: row.dateConfidence as Package.Info["dateConfidence"],
  }
}
