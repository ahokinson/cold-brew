import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runWithConcurrencyLimit } from "@brew/concurrency"
import { createUpgradeClassifier, organize, printOrganized, progressLabel } from "@brew/organize"
import { stripAnsi } from "@brew/quiet"
import type { Package } from "@brew/types"
import { type GitHubCommit, isValidPackageName, validateGitHubCommits } from "@brew/validate"
import { statusClear, statusUpdate } from "@cli/progress"
import { setOriginalTap } from "@db"

// Prevent brew from trying to auto-update on every command — this is the
// primary cause of hangs when offline.
process.env.HOMEBREW_NO_AUTO_UPDATE = "1"

const BREW_COMMAND_TIMEOUT_MILLISECONDS = 30_000
const FETCH_TIMEOUT_MILLISECONDS = 10_000

async function runBrewCommand(
  arguments_: string[],
  timeoutMilliseconds = BREW_COMMAND_TIMEOUT_MILLISECONDS,
): Promise<string> {
  const child = Bun.spawn(["brew", ...arguments_], {
    stdout: "pipe",
    stderr: "pipe",
  })

  // Drain stderr in parallel with stdout. brew can emit enough warning
  // output to fill the OS pipe buffer (~64 KB on macOS); leaving stderr
  // unread blocks the child indefinitely once the buffer is full.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMilliseconds)
  const [text] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  clearTimeout(timer)

  if (timedOut) {
    throw new Error(`brew ${arguments_[0]} timed out after ${timeoutMilliseconds}ms`)
  }

  return text
}

// COLD_BREW_BREW_PREFIX short-circuits the `brew --prefix` lookup. Useful when
// brew lives at a non-default location (CI runners, alternate installs) and
// avoids spawning a subprocess to ask brew where it lives.
let _prefix: string | null = process.env.COLD_BREW_BREW_PREFIX ?? null

export async function brewUpdate(): Promise<void> {
  await runBrewCommand(["update"], 60_000)
}

// Test hook: clear the module-level prefix cache so a suite can control the
// resolved Homebrew prefix (re-reads COLD_BREW_BREW_PREFIX if set).
export function resetBrewPrefixCache(): void {
  _prefix = process.env.COLD_BREW_BREW_PREFIX ?? null
}

export async function brewPrefix(): Promise<string> {
  if (_prefix) return _prefix
  const result = await runBrewCommand(["--prefix"])
  _prefix = result.trim()
  return _prefix
}

async function brewListVersionsFor(type: "formula" | "cask"): Promise<Map<string, string>> {
  const result = await runBrewCommand(["list", `--${type}`, "--versions"])
  const map = new Map<string, string>()
  for (const line of result.trim().split("\n")) {
    if (!line) continue
    const parts = line.split(/\s+/)
    const name = parts[0]!
    if (!isValidPackageName(name)) continue
    const version = parts[parts.length - 1]!
    map.set(name, version)
  }
  return map
}

export async function brewListVersions(): Promise<Map<string, string>> {
  return brewListVersionsFor("formula")
}

export async function brewListCaskVersions(): Promise<Map<string, string>> {
  return brewListVersionsFor("cask")
}

export async function brewLeaves(): Promise<Set<string>> {
  const result = await runBrewCommand(["leaves"])
  return new Set(
    result
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("/")
        return parts[parts.length - 1]!
      }),
  )
}

interface BrewOutdatedFormula {
  name: string
  installed_versions: string[]
  current_version: string
  pinned: boolean
  pinned_version: string | null
}

interface BrewOutdatedCask {
  name: string
  installed_versions: string[]
  current_version: string
}

interface BrewOutdatedResult {
  formulae: BrewOutdatedFormula[]
  casks: BrewOutdatedCask[]
}

export async function brewOutdatedJson(): Promise<{
  formulae: BrewOutdatedFormula[]
  casks: BrewOutdatedCask[]
}> {
  const result = await runBrewCommand(["outdated", "--json=v2"])
  try {
    const parsed: BrewOutdatedResult = JSON.parse(result)
    return { formulae: parsed.formulae, casks: parsed.casks }
  } catch {
    return { formulae: [], casks: [] }
  }
}

export interface BrewInfoFormula {
  name: string
  full_name: string
  tap: string
  desc: string
  homepage?: string | null
  versions: { stable: string; head: string | null }
  urls?: { stable?: { url?: string | null } | null } | null
  pinned: boolean
  outdated: boolean
  disabled?: boolean
  disable_date?: string | null
  disable_reason?: string | null
  deprecated?: boolean
  deprecation_date?: string | null
  deprecation_reason?: string | null
  installed: Array<{
    version: string
    installed_as_dependency: boolean
    installed_on_request: boolean
  }>
}

export interface BrewInfoCask {
  token: string
  desc: string | null
  homepage?: string | null
  version: string
  installed: string | null
  installed_time: number | null
  outdated: boolean
  tap: string
  auto_updates: boolean
  disabled?: boolean
  deprecated?: boolean
  deprecation_reason?: string | null
}

interface BrewInfoResult {
  formulae: BrewInfoFormula[]
  casks: BrewInfoCask[]
}

export async function brewInfoJson(
  packages: string[],
  type?: "formula" | "cask",
): Promise<{ formulae: BrewInfoFormula[]; casks: BrewInfoCask[] }> {
  if (packages.length === 0) return { formulae: [], casks: [] }
  const typeFlag = type ? [`--${type}`] : []
  const text = await runBrewCommand(["info", "--json=v2", ...typeFlag, ...packages])
  try {
    const parsed: BrewInfoResult = JSON.parse(text)
    return { formulae: parsed.formulae, casks: parsed.casks }
  } catch {
    return { formulae: [], casks: [] }
  }
}

interface BrewQuietResult {
  exitCode: number
  stderr: string
}

async function spawnBrewQuiet(
  args: string[],
  timeoutMilliseconds = BREW_COMMAND_TIMEOUT_MILLISECONDS,
): Promise<BrewQuietResult> {
  const child = Bun.spawn(["brew", ...args], { stdout: "pipe", stderr: "pipe" })

  // Must drain stdout too, not just stderr: an unread pipe blocks the child
  // once its OS buffer fills (see runBrewCommand).
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMilliseconds)
  const [, stderrText] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  clearTimeout(timer)

  if (timedOut) {
    return {
      exitCode: child.exitCode ?? 1,
      stderr: `brew ${args[0]} timed out after ${timeoutMilliseconds}ms\n${stderrText}`,
    }
  }

  return { exitCode: child.exitCode ?? 1, stderr: stderrText }
}

async function isBrewInstalled(name: string, isCask: boolean): Promise<boolean> {
  const args = isCask ? ["list", "--cask", name] : ["list", "--formula", name]
  return (await spawnBrewQuiet(args)).exitCode === 0
}

function originTapInstallArgs(name: string, isCask: boolean, tap: string): string[] {
  // isCask wins over tap so a cask whose recorded original tap is missing or
  // wrong (defaulted to "homebrew/core") still gets `--cask` install args.
  if (isCask || tap === "homebrew/cask") return ["install", "--cask", name]
  // `--formula` keeps brew from loading an untrusted same-named cask shadow
  // (see spawnBrewUpgrade); third-party taps are already fully qualified below.
  if (tap === "homebrew/core") return ["install", "--formula", name]
  // `install unknown/name` is an invalid tap-qualified name brew rejects, so an
  // unresolved origin falls back to a bare install.
  if (!tap || tap === "unknown") return ["install", name]
  return ["install", `${tap}/${name}`]
}

// Cross-check the version a freshly fetched formula declares against the
// version we extracted from its commit subject. Stops a mistitled or
// reverted commit from causing a no-op reinstall under the cold-brew tap.
function parseDeclaredVersion(source: string): string | null {
  const explicit = source.match(/^\s*version\s+"([^"]+)"/m)
  if (explicit) return explicit[1] ?? null
  const tag = source.match(/\btag:\s*"v?(\d[^"]*?)"/)
  if (tag) return tag[1] ?? null
  // Version embedded in the archive filename: foo-1.2.3.tar.gz, /v1.2.3.tgz.
  const urlFile = source.match(/url\s+"[^"]*?[/-]v?(\d[^"/]*?)(?:\.tar|\.zip|\.tgz|\.tbz|\.gz)/)
  if (urlFile) return urlFile[1] ?? null
  // Version as a path segment, not the filename — GitHub release assets:
  // .../releases/download/v2.8.0/deno_src.tar.gz. Regression: deno previously
  // yielded <unparseable> and aborted stepping.
  const urlPath = source.match(/\/download\/v?(\d[^"/]+)\//)
  return urlPath?.[1] ?? null
}

// Some formula DSL is only valid in official Homebrew taps and makes `brew
// install` abort outright when present elsewhere (e.g. `no_autobump! can only
// be used in official Homebrew taps`). We install stepped formulae from the
// synthesized cold-brew/cold-brew tap, so strip these official-only directives
// before writing. They're autobump/metadata hints — they don't affect the
// built artifact. Run this AFTER integrity verification so the check still
// covers the unmodified upstream blob.
function sanitizeFormulaForLocalTap(source: string): string {
  return source.replace(/^[ \t]*no_autobump!.*\r?\n/gm, "")
}

async function brewUninstallAndReinstall(
  name: string,
  isCask: boolean,
  installArgs: string[],
): Promise<BrewQuietResult> {
  const uninstallArgs = isCask
    ? ["uninstall", "--cask", name]
    : ["uninstall", "--formula", "--ignore-dependencies", name]
  const uninstall = await spawnBrewQuiet(uninstallArgs)
  // "No such keg" — package wasn't installed; safe to proceed with install.
  // Any other nonzero exit means uninstall failed for a real reason; bailing
  // here avoids the cryptic "already installed from <tap>" install conflict.
  // stderr is surfaced by the caller (see brewInstallVersion).
  if (uninstall.exitCode !== 0 && !uninstall.stderr.includes("No such keg")) {
    return uninstall
  }
  return spawnBrewQuiet(installArgs)
}

export interface BrewUpgradeEntry {
  name: string
  isCask: boolean
  tap: string
  originalTap: string | null
  // Pre-upgrade version. After a partial-failure batch we diff post-state
  // against this to attribute per-package success without trusting the batch
  // exit code, which collapses any failure into the whole set.
  installedVersion: string
  // Target keg already exists in Cellar but is unlinked (see withOutdatedInfo).
  // Routed through `brew reinstall` instead of `brew upgrade` so the link
  // actually switches. Optional so callers that don't compute it default to
  // false (regular upgrade path).
  needsRelink?: boolean
}

export interface BrewUpgradeResult {
  exitCode: number
  formulaeSucceeded: string[]
  casksSucceeded: string[]
}

export async function brewUpgrade(packages: BrewUpgradeEntry[]): Promise<BrewUpgradeResult> {
  if (packages.length === 0) return { exitCode: 0, formulaeSucceeded: [], casksSucceeded: [] }

  const { retapExit, skip } = await retapHeldPackages(packages)

  // Packages whose target keg is already in the Cellar but unlinked: `brew
  // upgrade` warns "already installed" and exits 0 without relinking. Route
  // them through `brew reinstall`, which uninstalls the linked keg and links
  // the target. Cleanup later removes the leftover older keg.
  const eligible = packages.filter((package_) => !skip.has(package_.name))
  const formulaeRelink = eligible.filter((p) => !p.isCask && p.needsRelink).map((p) => p.name)
  const formulaeUpgrade = eligible.filter((p) => !p.isCask && !p.needsRelink).map((p) => p.name)
  const casksRelink = eligible.filter((p) => p.isCask && p.needsRelink).map((p) => p.name)
  const casksUpgrade = eligible.filter((p) => p.isCask && !p.needsRelink).map((p) => p.name)

  const preInstalled = new Map(packages.map((package_) => [package_.name, package_.installedVersion]))

  // brew's streamed progress is buffered for the organize pass below; a single
  // rewriting status line is the only live signal during the run.
  const onLine = (line: string): void => {
    const label = progressLabel(line)
    if (label) statusUpdate(label)
  }
  const formulaeRelinkRes = await spawnBrewReinstall(formulaeRelink, false, onLine)
  const formulaeUpgradeRes = await spawnBrewUpgrade(formulaeUpgrade, false, onLine)
  const casksRelinkRes = await spawnBrewReinstall(casksRelink, true, onLine)
  const casksUpgradeRes = await spawnBrewUpgrade(casksUpgrade, true, onLine)
  statusClear()

  const formulaeExit = formulaeRelinkRes.exitCode || formulaeUpgradeRes.exitCode
  const casksExit = casksRelinkRes.exitCode || casksUpgradeRes.exitCode
  const exitCode = retapExit || formulaeExit || casksExit

  // cold-brew already printed the plan and reports the per-package outcome
  // itself, so condense brew's chatter away and surface only what it can't
  // account for (caveats, genuine errors) in the trailer.
  const combined = formulaeRelinkRes.text + formulaeUpgradeRes.text + casksRelinkRes.text + casksUpgradeRes.text
  printOrganized(organize(combined, createUpgradeClassifier(), { isManaged: () => false, state: {} }))

  // Resolve success per command using its *own* exit code, not the merged one.
  // A relink (reinstall) leaves the version token unchanged, so version-diffing
  // it against a merged non-zero exit would wrongly report a successful relink
  // as failed whenever a sibling upgrade command in the same batch fails. With
  // the relink command's own exit, a clean relink short-circuits to success.
  const formulaeSucceeded = [
    ...(await resolveSucceeded(formulaeRelink, formulaeRelinkRes.exitCode, "formula", preInstalled)),
    ...(await resolveSucceeded(formulaeUpgrade, formulaeUpgradeRes.exitCode, "formula", preInstalled)),
  ]
  const casksSucceeded = [
    ...(await resolveSucceeded(casksRelink, casksRelinkRes.exitCode, "cask", preInstalled)),
    ...(await resolveSucceeded(casksUpgrade, casksUpgradeRes.exitCode, "cask", preInstalled)),
  ]
  return { exitCode, formulaeSucceeded, casksSucceeded }
}

// Packages on the cold-brew/cold-brew tap can't be upgraded directly — brew
// throws "already installed from <tap>". Reinstall each from its recorded
// origin tap (or a homebrew/{core,cask} fallback) so the next upgrade pass
// runs cleanly. A single retap failure only skips that package.
async function retapHeldPackages(
  packages: readonly BrewUpgradeEntry[],
): Promise<{ retapExit: number; skip: Set<string> }> {
  const skip = new Set<string>()
  let retapExit = 0
  const needsRetap = packages.filter((package_) => package_.tap === "cold-brew/cold-brew")
  for (const package_ of needsRetap) {
    const originalTap = package_.originalTap ?? (package_.isCask ? "homebrew/cask" : "homebrew/core")
    if (!package_.originalTap) {
      console.error(
        `cold-brew: ${package_.name} is from cold-brew/cold-brew tap with no recorded origin; assuming ${originalTap}`,
      )
    }
    const exitCode = await brewReinstallFromTap(package_.name, package_.isCask, originalTap)
    if (exitCode !== 0) {
      retapExit = exitCode
      skip.add(package_.name)
      console.error(`cold-brew: failed to retap ${package_.name} (exit ${exitCode}); skipping its upgrade`)
    }
  }
  return { retapExit, skip }
}

// Captures brew's output (for the organize pass in brewUpgrade) while feeding
// the progress sniffer. `--formula`/`--cask` is always passed: without it, brew
// resolves a bare token by enumerating every same-named formula AND cask across
// all taps; if an untrusted tap ships a same-named cask (e.g. anchore/grype
// shadows the homebrew/core `grype` formula), brew refuses to load it and aborts
// the whole batch. The type flag confines resolution so the untrusted cask is
// never loaded.
async function spawnBrewUpgrade(
  names: string[],
  isCask: boolean,
  onLine?: (line: string) => void,
): Promise<{ exitCode: number; text: string }> {
  if (names.length === 0) return { exitCode: 0, text: "" }
  return brewCapture(["upgrade", isCask ? "--cask" : "--formula", ...names], { onLine })
}

// Same shape as spawnBrewUpgrade but uses `brew reinstall`. Used when the
// target version is already extracted in the Cellar but unlinked — reinstall
// uninstalls the linked keg, installs the target (reusing the existing keg
// or rebuilding), and links it.
async function spawnBrewReinstall(
  names: string[],
  isCask: boolean,
  onLine?: (line: string) => void,
): Promise<{ exitCode: number; text: string }> {
  if (names.length === 0) return { exitCode: 0, text: "" }
  return brewCapture(["reinstall", isCask ? "--cask" : "--formula", ...names], { onLine })
}

// Buffers a brew command's combined output (for the organize pass) while
// feeding each line to an optional sniffer that drives the live status line.
// Both streams are drained concurrently — brew can emit enough output to fill
// the ~64KB OS pipe buffer, and reading one stream fully before the other
// would deadlock the child (see runBrewCommand). stdin stays inherited so sudo
// prompts still work.
export async function brewCapture(
  args: string[],
  options: { env?: Record<string, string>; onLine?: (strippedLine: string) => void } = {},
): Promise<{ text: string; exitCode: number }> {
  const child = Bun.spawn(["brew", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
    env: { ...process.env, ...options.env },
  })
  const [out, err] = await Promise.all([
    drainCapture(child.stdout, options.onLine),
    drainCapture(child.stderr, options.onLine),
  ])
  await child.exited
  // Concatenate stdout then stderr. organize re-blocks by header so the exact
  // interleave doesn't matter, and errors (stderr) sorting last is desirable.
  return { text: out + err, exitCode: child.exitCode ?? 1 }
}

async function drainCapture(
  stream: ReadableStream<Uint8Array>,
  onLine?: (strippedLine: string) => void,
): Promise<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let captured = ""
  let buffer = ""
  // Strip bare CRs from brew's progress overwrites so they can't drift the
  // cursor when the captured text is later printed.
  const handle = (raw: string): void => {
    const line = raw.replace(/\r/g, "")
    captured += `${line}\n`
    onLine?.(stripAnsi(line))
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      for (const raw of lines) handle(raw)
    }
    if (buffer) handle(buffer)
  } finally {
    reader.releaseLock()
  }
  return captured
}

// On clean exit, brew tells the truth. On non-zero exit we compare pre/post
// installed versions: any package whose version moved is a real success,
// regardless of which sibling in the batch failed.
async function resolveSucceeded(
  names: string[],
  exitCode: number,
  kind: "formula" | "cask",
  preInstalled: Map<string, string>,
): Promise<string[]> {
  if (names.length === 0) return []
  if (exitCode === 0) return names
  let postVersions: Map<string, string>
  try {
    postVersions = await brewListVersionsFor(kind)
  } catch {
    return []
  }
  const succeeded: string[] = []
  for (const name of names) {
    const before = preInstalled.get(name)
    const after = postVersions.get(name)
    if (!before || !after) continue
    if (after !== before) succeeded.push(name)
  }
  return succeeded
}

export async function brewPassthrough(args: string[]): Promise<number> {
  const child = Bun.spawn(["brew", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  await child.exited
  return child.exitCode ?? 1
}

// Trust a tap (or fully-qualified package) so Homebrew loads it under
// HOMEBREW_REQUIRE_TAP_TRUST. `brew trust` is idempotent and writes to
// trust.json; output is captured rather than inherited so it stays quiet.
export async function brewTrust(target: string): Promise<number> {
  const child = Bun.spawn(["brew", "trust", target], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await child.exited
  return child.exitCode ?? 1
}

// Deprecated taps that were merged into other taps.
// Maps old tap name → current tap name so GitHub API calls hit the right repo.
const TAP_ALIASES: Record<string, string> = {
  "homebrew/cask-fonts": "homebrew/cask",
  "homebrew/cask-drivers": "homebrew/cask",
  "homebrew/cask-versions": "homebrew/cask",
}

function normalizeTap(tap: string): string {
  return TAP_ALIASES[tap] ?? tap
}

const TAP_COMPONENT_PATTERN = /^[a-zA-Z0-9_-]+$/

function tapToGitHubRepo(tap: string): string {
  const normalized = normalizeTap(tap)
  const [owner, name] = normalized.split("/")
  // A slashless/empty tap (e.g. the "unknown" origin sentinel) has no GitHub
  // repo. Throw rather than silently defaulting to homebrew-core, which would
  // point provenance/version/source fetches at the wrong repository. Callers
  // isolate the throw (batch paths via runWithConcurrencyLimit, install paths
  // already reject on bad input) so this fails closed to "no data".
  if (!owner || !name) {
    throw new Error(`Invalid tap name: ${tap}`)
  }
  if (!TAP_COMPONENT_PATTERN.test(owner) || !TAP_COMPONENT_PATTERN.test(name)) {
    throw new Error(`Invalid tap name: ${tap}`)
  }
  return `${owner.charAt(0).toUpperCase() + owner.slice(1)}/homebrew-${name}`
}

const NESTED_TAPS = new Set(["homebrew/core", "homebrew/cask"])

function gitPath(name: string, isCask: boolean, tap: string): string {
  const normalized = normalizeTap(tap)
  const dir = isCask ? "Casks" : "Formula"
  if (NESTED_TAPS.has(normalized)) {
    // Fonts are double-nested: Casks/font/font-<letter-after-prefix>/<name>.rb
    if (isCask && name.startsWith("font-") && name.length > 5) {
      return `${dir}/font/font-${name.charAt(5)}/${name}.rb`
    }
    return `${dir}/${name.charAt(0)}/${name}.rb`
  }
  return `${dir}/${name}.rb`
}

export function repoConfig(tap: string, isCask: boolean) {
  return {
    repo: tapToGitHubRepo(tap),
    path: (name: string) => gitPath(name, isCask, tap),
  }
}

export function githubRequestHeaders(): Record<string, string> {
  return githubHeaders()
}

export function hasGitHubToken(): boolean {
  return !!(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN)
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) {
    headers.Authorization = `token ${token}`
  }
  return headers
}

let rateLimitedUntil = 0

function isRateLimited(): boolean {
  return Date.now() < rateLimitedUntil
}

function handleRateLimitResponse(response: Response): void {
  const retryAfter = response.headers.get("retry-after")
  const resetHeader = response.headers.get("x-ratelimit-reset")
  if (retryAfter) {
    rateLimitedUntil = Date.now() + parseInt(retryAfter, 10) * 1000
  } else if (resetHeader) {
    rateLimitedUntil = parseInt(resetHeader, 10) * 1000
  } else {
    rateLimitedUntil = Date.now() + 60_000
  }
}

const MAX_CONCURRENT_GITHUB_REQUESTS = 10

export interface SourceDateRequest {
  name: string
  isCask: boolean
  tap: string
  latestVersion: string | null
}

export async function fetchSourceLastModifiedBatch(
  packages: SourceDateRequest[],
  onProgress?: (completed: number, total: number) => void,
): Promise<Map<string, number | null | "rate-limited">> {
  const results = await runWithConcurrencyLimit(
    packages,
    MAX_CONCURRENT_GITHUB_REQUESTS,
    async (package_) => {
      const time = await fetchVersionPublishDate(package_.name, package_.isCask, package_.tap, package_.latestVersion)
      return { name: package_.name, time }
    },
    onProgress,
  )

  const map = new Map<string, number | null | "rate-limited">()
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!
    // Treat handler failures as transient (rate-limited) so the caller
    // skips negative-caching the package — a real error this run shouldn't
    // poison the cache for an hour.
    if (result instanceof Error) {
      map.set(packages[i]!.name, "rate-limited")
      continue
    }
    map.set(result.name, result.time)
  }
  return map
}

function formulaVersionPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escaped}[: ]+(?:(?:update|upgrade|bump)\\s+(?:to\\s+)?)?(?:v)?(\\d+\\S*?)(?:\\s|$)`, "i")
}

function extractVersionFromSubject(subject: string, pattern: RegExp): string | null {
  const match = subject.match(pattern)
  if (!match) return null
  const version = match[1]!.replace(/\s*bottle\.?$/i, "").replace(/[,;.]$/, "")
  return version || null
}

const VERSION_HISTORY_PAGES = 5
const VERSION_HISTORY_PER_PAGE = 100

export async function brewVersionHistory(
  name: string,
  isCask: boolean,
  tap: string,
): Promise<Package.VersionHistory[]> {
  const config = repoConfig(tap, isCask)
  const path = config.path(name)
  const pattern = formulaVersionPattern(name)

  const seen = new Map<string, { entryIndex: number; commitDate: string }>()
  const entries: Package.VersionHistory[] = []

  // Mature formulae churn through a single page of history in weeks, so
  // paginate to keep enough stepping candidates in scope.
  for (let page = 1; page <= VERSION_HISTORY_PAGES; page++) {
    if (isRateLimited()) break
    const url = `https://api.github.com/repos/${config.repo}/commits?path=${encodeURIComponent(path)}&per_page=${VERSION_HISTORY_PER_PAGE}&page=${page}`
    const response = await fetch(url, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
    })
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) handleRateLimitResponse(response)
      break
    }

    let commits: GitHubCommit[]
    try {
      commits = validateGitHubCommits(await response.json())
    } catch {
      break
    }
    if (commits.length === 0) break

    for (const commit of commits) {
      const subject = commit.commit.message.split("\n")[0]!
      const version = extractVersionFromSubject(subject, pattern)
      if (!version) continue

      const date = commit.commit.committer.date.split("T")[0]!
      // A version usually has two homebrew-core commits: the version-bump
      // (older, placeholder bottle hashes) and the bottle rebuild (newer,
      // real hashes). Keep the bottle-rebuild's commitHash so brew install
      // doesn't fail on a hash mismatch; keep the version-bump's date so the
      // hold window is measured from when the release actually landed.
      // Commits arrive newest-first, so the first hash we see is right and
      // later (older) ones only revise the date.
      const existing = seen.get(version)
      if (!existing) {
        seen.set(version, { entryIndex: entries.length, commitDate: date })
        entries.push({ version, commitHash: commit.sha, commitDate: date })
      } else if (date < existing.commitDate) {
        existing.commitDate = date
        const entry = entries[existing.entryIndex]!
        entry.commitDate = date
      }
    }

    if (commits.length < VERSION_HISTORY_PER_PAGE) break
  }

  return entries
}

async function fetchVersionPublishDate(
  name: string,
  isCask: boolean,
  tap: string,
  latestVersion: string | null,
): Promise<number | null | "rate-limited"> {
  if (isRateLimited()) return "rate-limited"
  const config = repoConfig(tap, isCask)
  const path = config.path(name)
  const url = `https://api.github.com/repos/${config.repo}/commits?path=${encodeURIComponent(path)}&per_page=20`
  const response = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
  })
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      handleRateLimitResponse(response)
      return "rate-limited"
    }
    return null
  }
  let commits: GitHubCommit[]
  try {
    commits = validateGitHubCommits(await response.json())
  } catch {
    return null
  }
  if (commits.length === 0) return null

  if (latestVersion) {
    const pattern = formulaVersionPattern(name)
    for (const commit of commits) {
      const subject = commit.commit.message.split("\n")[0]!
      const version = extractVersionFromSubject(subject, pattern)
      if (version === latestVersion) {
        const ts = new Date(commit.commit.committer.date).getTime()
        return Number.isFinite(ts) ? Math.floor(ts / 1000) : null
      }
    }
    // Version not found in history: return "unknown" rather than the newest
    // commit's date, which could be an unrelated commit and would anchor the
    // hold window on the wrong point. Caller falls back to install time.
    return null
  }

  const ts = new Date(commits[0]!.commit.committer.date).getTime()
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : null
}

async function verifyFormulaIntegrity(content: string, commitHash: string, repo: string, path: string): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${commitHash}`
  const response = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
  })
  if (!response.ok) {
    throw new Error(`Integrity check failed: could not fetch tree entry (HTTP ${response.status})`)
  }
  const entry = (await response.json()) as { sha?: string }
  if (!entry || typeof entry.sha !== "string") {
    throw new Error("Integrity check failed: invalid GitHub API response")
  }

  const encoder = new TextEncoder()
  const contentBytes = encoder.encode(content)
  const header = encoder.encode(`blob ${contentBytes.length}\0`)
  const combined = new Uint8Array(header.length + contentBytes.length)
  combined.set(header)
  combined.set(contentBytes, header.length)

  const hashBuffer = await crypto.subtle.digest("SHA-1", combined)
  const computedSha = [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("")

  if (computedSha !== entry.sha) {
    throw new Error(`Integrity check failed: expected SHA ${entry.sha}, computed ${computedSha}`)
  }
}

export async function ensureColdBrewTap(): Promise<string> {
  const prefix = await brewPrefix()
  const tapPath = join(prefix, "Library", "Taps", "cold-brew", "homebrew-cold-brew")

  await mkdir(join(tapPath, "Formula"), { recursive: true })
  await mkdir(join(tapPath, "Casks"), { recursive: true })

  // cold-brew's tap is non-official, so under HOMEBREW_REQUIRE_TAP_TRUST brew
  // would refuse to load stepped formulae/casks from it. Trust it ourselves so
  // stepping keeps working; idempotent and harmless when trust isn't enforced.
  // try/await (not .catch) so a synchronous Bun.spawn throw is swallowed too.
  try {
    await brewTrust("cold-brew/cold-brew")
  } catch {}

  return tapPath
}

const COMMIT_HASH_PATTERN = /^[0-9a-f]{40}$/i

interface FetchedSource {
  content: string
  resolvedPath: string
}

async function fetchSourceAtCommit(
  name: string,
  commitHash: string,
  isCask: boolean,
  tap: string,
): Promise<FetchedSource> {
  if (!COMMIT_HASH_PATTERN.test(commitHash)) {
    throw new Error(`Invalid commit hash: ${commitHash}`)
  }
  const config = repoConfig(tap, isCask)
  const path = config.path(name)
  const url = `https://raw.githubusercontent.com/${config.repo}/${commitHash}/${path}`
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS) })
  if (!response.ok) {
    const fallbackPath = isCask ? `Casks/${name}.rb` : `Formula/${name}.rb`
    const fallbackUrl = `https://raw.githubusercontent.com/${config.repo}/${commitHash}/${fallbackPath}`
    const fallbackResponse = await fetch(fallbackUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS) })
    if (!fallbackResponse.ok) {
      const kind = isCask ? "Cask" : "Formula"
      throw new Error(`${kind} ${name} not found at commit ${commitHash}`)
    }
    return { content: await fallbackResponse.text(), resolvedPath: fallbackPath }
  }
  return { content: await response.text(), resolvedPath: path }
}

export async function brewInstallVersion(
  name: string,
  version: string,
  commitHash: string,
  isCask: boolean,
  tap: string,
): Promise<number> {
  if (!isValidPackageName(name)) {
    throw new Error(`Invalid package name: ${name}`)
  }
  const { content: source, resolvedPath } = await fetchSourceAtCommit(name, commitHash, isCask, tap)

  const config = repoConfig(tap, isCask)
  await verifyFormulaIntegrity(source, commitHash, config.repo, resolvedPath)

  const declared = parseDeclaredVersion(source)
  if (declared !== version) {
    console.error(
      `cold-brew: refusing to step ${name} to ${version} — formula at ${commitHash.slice(0, 7)} declares ${declared ?? "<unparseable>"}. Skipping.`,
    )
    return 1
  }

  const coldBrewTapPath = await ensureColdBrewTap()
  const subdir = isCask ? "Casks" : "Formula"
  const sourceFile = join(coldBrewTapPath, subdir, `${name}.rb`)
  await writeFile(sourceFile, sanitizeFormulaForLocalTap(source))

  const { unlink } = await import("node:fs/promises")
  try {
    const installArgs = isCask
      ? ["install", "--cask", `cold-brew/cold-brew/${name}`]
      : ["install", `cold-brew/cold-brew/${name}`]
    const { exitCode, stderr } = await brewUninstallAndReinstall(name, isCask, installArgs)

    // brew can exit 0 while emitting "already installed" — meaning the install
    // step was a no-op. Treat absence-after-install as failure regardless of
    // exit code, so a silent skip can't strand the user without the package.
    const installed = await isBrewInstalled(name, isCask)

    if (exitCode === 0 && installed) {
      if (tap !== "cold-brew/cold-brew") setOriginalTap(name, tap)
      return 0
    }

    // Surface brew's own output so a failed step is diagnosable instead of a
    // bare "exit N" — source builds (e.g. Go formulae) fail here for reasons
    // only brew's stderr explains.
    if (stderr.trim()) {
      process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`)
    }

    if (!installed) {
      console.error(`cold-brew: ${name} not present after install (exit ${exitCode}); restoring from ${tap}.`)
      const restore = await spawnBrewQuiet(originTapInstallArgs(name, isCask, tap))
      if (restore.exitCode !== 0) {
        process.stderr.write(restore.stderr)
        console.error(`cold-brew: failed to restore ${name} from ${tap}`)
      }
    }

    return exitCode === 0 ? 1 : exitCode
  } finally {
    try {
      await unlink(sourceFile)
    } catch {}
  }
}

export async function brewReinstallFromTap(name: string, isCask: boolean, tap: string): Promise<number> {
  const { exitCode, stderr } = await brewUninstallAndReinstall(name, isCask, originTapInstallArgs(name, isCask, tap))
  if (exitCode !== 0 && stderr.trim()) {
    process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`)
  }
  return exitCode
}
