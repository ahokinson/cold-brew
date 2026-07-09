import type { Database } from "bun:sqlite"

// Pre-release: single schema, no versioned migrations. When cold-brew ships
// a real version the next time the shape changes, switch to numbered
// migrations and bump SCHEMA_VERSION.
const SCHEMA_VERSION = 1

const schema = `
CREATE TABLE IF NOT EXISTS config (
	key TEXT PRIMARY KEY NOT NULL,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS package_settings (
	name TEXT PRIMARY KEY NOT NULL,
	hold_policy TEXT DEFAULT 'default' NOT NULL CHECK (hold_policy IN ('always-hold', 'always-allow', 'default')),
	pinned_version TEXT,
	original_tap TEXT,
	updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
);

CREATE TABLE IF NOT EXISTS package_cache (
	name TEXT PRIMARY KEY NOT NULL,
	installed_version TEXT,
	latest_version TEXT,
	installed_at INTEGER,
	formula_updated_at INTEGER,
	is_leaf INTEGER DEFAULT 0 NOT NULL,
	installed_as_dependency INTEGER DEFAULT 0 NOT NULL,
	installed_on_request INTEGER DEFAULT 0 NOT NULL,
	pinned INTEGER DEFAULT 0 NOT NULL,
	outdated INTEGER DEFAULT 0 NOT NULL,
	tap TEXT,
	description TEXT,
	is_cask INTEGER DEFAULT 0 NOT NULL,
	date_confidence TEXT DEFAULT 'unknown' NOT NULL,
	cached_at INTEGER DEFAULT (unixepoch()) NOT NULL
);

CREATE TABLE IF NOT EXISTS upgrade_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	name TEXT NOT NULL,
	from_version TEXT NOT NULL,
	to_version TEXT NOT NULL,
	upgraded_at INTEGER DEFAULT (unixepoch()) NOT NULL,
	held_days INTEGER
);

CREATE TABLE IF NOT EXISTS description_cache (
	package_name TEXT PRIMARY KEY NOT NULL,
	is_cask INTEGER DEFAULT 0 NOT NULL,
	description TEXT,
	latest_version TEXT,
	tap TEXT,
	installed_time INTEGER,
	formula_updated_at INTEGER,
	info_cached_at INTEGER DEFAULT (unixepoch()) NOT NULL,
	date_cached_at INTEGER
);

CREATE TABLE IF NOT EXISTS advisory_cache (
	package_name TEXT PRIMARY KEY NOT NULL,
	installed_version TEXT,
	latest_version TEXT,
	advisories_json TEXT DEFAULT '[]' NOT NULL,
	max_cvss REAL,
	has_fix_in_latest INTEGER DEFAULT 0 NOT NULL,
	has_kev_listed INTEGER DEFAULT 0 NOT NULL,
	sources TEXT DEFAULT '' NOT NULL,
	fetched_at INTEGER DEFAULT (unixepoch()) NOT NULL
);

CREATE TABLE IF NOT EXISTS kev_cache (
	cve_id TEXT PRIMARY KEY NOT NULL,
	fetched_at INTEGER DEFAULT (unixepoch()) NOT NULL
);

CREATE TABLE IF NOT EXISTS epss_cache (
	cve_id TEXT PRIMARY KEY NOT NULL,
	score REAL NOT NULL,
	percentile REAL NOT NULL,
	fetched_at INTEGER DEFAULT (unixepoch()) NOT NULL
);

CREATE TABLE IF NOT EXISTS provenance_authors (
	formula TEXT NOT NULL,
	author TEXT NOT NULL,
	first_seen INTEGER DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY (formula, author)
);

CREATE TABLE IF NOT EXISTS provenance_cache (
	formula TEXT PRIMARY KEY NOT NULL,
	summary_json TEXT DEFAULT '{}' NOT NULL,
	fetched_at INTEGER DEFAULT (unixepoch()) NOT NULL
);
`

export function migrate(database: Database): void {
  const currentVersion = database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
  if (currentVersion < SCHEMA_VERSION) {
    database.exec(schema)
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
}
