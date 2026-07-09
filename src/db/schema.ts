import { Hold } from "@brew/types"
import { sql } from "drizzle-orm"
import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const config = sqliteTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
})

export const packageSettings = sqliteTable("package_settings", {
  name: text("name").primaryKey(),
  holdPolicy: text("hold_policy", {
    enum: Hold.Policy.ALL,
  })
    .notNull()
    .default(Hold.Policy.Default),
  pinnedVersion: text("pinned_version"),
  originalTap: text("original_tap"),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
})

export const packageCache = sqliteTable("package_cache", {
  name: text("name").primaryKey(),
  installedVersion: text("installed_version"),
  latestVersion: text("latest_version"),
  installedAt: integer("installed_at"),
  sourceModifiedAt: integer("formula_updated_at"),
  isLeaf: integer("is_leaf").notNull().default(0),
  installedAsDependency: integer("installed_as_dependency").notNull().default(0),
  installedOnRequest: integer("installed_on_request").notNull().default(0),
  pinned: integer("pinned").notNull().default(0),
  outdated: integer("outdated").notNull().default(0),
  tap: text("tap"),
  description: text("description"),
  isCask: integer("is_cask").notNull().default(0),
  dateConfidence: text("date_confidence").notNull().default("unknown"),
  cachedAt: integer("cached_at").notNull().default(sql`(unixepoch())`),
})

export const upgradeLog = sqliteTable("upgrade_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  fromVersion: text("from_version").notNull(),
  toVersion: text("to_version").notNull(),
  upgradedAt: integer("upgraded_at").notNull().default(sql`(unixepoch())`),
  heldDays: integer("held_days"),
})

export const metadataCache = sqliteTable("description_cache", {
  packageName: text("package_name").primaryKey(),
  isCask: integer("is_cask").notNull().default(0),
  description: text("description"),
  latestVersion: text("latest_version"),
  tap: text("tap"),
  installedTime: integer("installed_time"),
  sourceModifiedAt: integer("formula_updated_at"),
  infoCachedAt: integer("info_cached_at").notNull().default(sql`(unixepoch())`),
  dateCachedAt: integer("date_cached_at"),
})

export const advisoryCache = sqliteTable("advisory_cache", {
  packageName: text("package_name").primaryKey(),
  installedVersion: text("installed_version"),
  latestVersion: text("latest_version"),
  advisoriesJson: text("advisories_json").notNull().default("[]"),
  maxCvss: real("max_cvss"),
  hasFixInLatest: integer("has_fix_in_latest").notNull().default(0),
  hasKevListed: integer("has_kev_listed").notNull().default(0),
  sources: text("sources").notNull().default(""),
  fetchedAt: integer("fetched_at").notNull().default(sql`(unixepoch())`),
})

export const kevCache = sqliteTable("kev_cache", {
  cveId: text("cve_id").primaryKey(),
  fetchedAt: integer("fetched_at").notNull().default(sql`(unixepoch())`),
})

export const epssCache = sqliteTable("epss_cache", {
  cveId: text("cve_id").primaryKey(),
  score: real("score").notNull(),
  percentile: real("percentile").notNull(),
  fetchedAt: integer("fetched_at").notNull().default(sql`(unixepoch())`),
})

// Authors observed on each formula file. The new-maintainer heuristic asks
// "has this author touched this formula before?" — yes if a row exists, no
// otherwise. The first run on a fresh install seeds the table by stamping
// every author from the formula's existing history.
export const provenanceAuthors = sqliteTable(
  "provenance_authors",
  {
    formula: text("formula").notNull(),
    author: text("author").notNull(),
    firstSeen: integer("first_seen").notNull().default(sql`(unixepoch())`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.formula, table.author] }),
  }),
)

// Per-formula provenance summary cache. We refetch from GitHub at most once
// per TTL; the same package's flags are reused inside that window so we
// don't burn rate-limit budget on every cold-brew run.
export const provenanceCache = sqliteTable("provenance_cache", {
  formula: text("formula").primaryKey(),
  summaryJson: text("summary_json").notNull().default("{}"),
  fetchedAt: integer("fetched_at").notNull().default(sql`(unixepoch())`),
})
