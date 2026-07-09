# cold-brew

A security-focused Homebrew wrapper that holds back package upgrades so supply
chain attacks, malicious releases, and botched versions have a chance to get
caught before they reach your machine.

> Don't get cut by the bleeding edge.

## Why cold-brew

`brew upgrade` installs whatever is current right now. That's fine until a
formula gets compromised, a publisher pushes a broken release, or a typosquat
slips into a tap.

cold-brew delays every upgrade by a configurable hold window (default 7
days). During the window the package is held but advisory feeds keep getting
checked. If a held package turns out to be vulnerable, cold-brew promotes it
out of the hold window so security fixes aren't stuck behind the delay.

You still get upgrades. You just get them a week late instead of the minute
they ship.

## How it works

- **Hold window.** A package becomes upgradable once its upstream source file
  is at least `hold-days` old (default `7`). Age comes from the formula's
  GitHub commit history, not local install time.
- **Advisory feeds.** Every run queries [OSV](https://osv.dev) and GitHub
  Security Advisories for the installed versions and caches results in
  SQLite. OSV `MAL-*` entries matching a Homebrew formula name surface as
  typosquat alerts (informational, never auto-bypass).
- **Auto-bypass.** If a held package has a fixable advisory, cold-brew
  promotes it from `Held` to `Ready`. Three signals can trigger this: the
  CVE is on the [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)
  catalog (`auto-bypass-kev`, default on); the
  [EPSS](https://www.first.org/epss/) score meets `auto-bypass-epss`
  (default disabled); or max CVSS meets `auto-bypass-cvss` (default `7.0`).
  Precedence when multiple fire: KEV > EPSS > CVSS.
- **Provenance flags.** During the hold window, cold-brew scans recent
  formula commits for signs of a hijacked release: first-time authors, added
  `system "curl"` or `system "bash"` calls, new `inreplace` blocks. Flags
  appear in `cold-brew audit` and never auto-block. `homebrew/core` only for
  now; casks and third-party taps come later.
- **Stepping.** When a package is held but version history is available,
  cold-brew suggests an intermediate version: newer than installed, older
  than latest, past the hold window.
- **Per-package policies.** `always-hold`, `always-allow`, and version pins
  override the global hold window per package.

Status is recomputed from live Homebrew data on every run; the cache is a
supplement, never the source of truth.

## Glossary

Every outdated package is assigned exactly one of the statuses below. The
same labels appear in `cold-brew status`, `cold-brew audit`, and the TUI.

| Status              | Meaning                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `ready`             | Hold window satisfied. Eligible for upgrade.                              |
| `held`              | Inside the hold window. Upgrade deferred.                                 |
| `always allowed`    | Per-package policy: upgrade immediately, regardless of the hold window.   |
| `always held`       | Per-package policy: never auto-upgrade.                                   |
| `pinned by brew`    | `brew pin` is set. Homebrew itself will refuse to upgrade.                |
| `pinned to X.Y.Z`   | cold-brew version pin. Sticks to a specific version.                      |
| `ahead of upstream` | Installed version is newer than upstream's current latest (rollback).    |
| `bypassed`          | Promoted from `held` to `ready` because a fixed advisory tripped one of the auto-bypass signals (KEV, EPSS, or CVSS). |

## What this would have caught

Real incidents and which mechanism applies. Not a claim of substitution for
code review or vendor trust.

- **OSV `MAL-*` typosquat feed (ongoing).** OSV's continuous stream of
  malicious-package advisories: typosquats, dependency confusion, hijacked
  maintainer accounts. *cold-brew:* entries matching a Homebrew formula
  name appear as typosquat alerts in `cold-brew audit`. Informational only,
  never auto-bypass, never block `brew install`.

- **TeamPCP / CanisterWorm cluster (early 2026).** Clustered actor hijacked
  maintainer tokens and dropped infostealers across Trivy, KICS, LiteLLM,
  Telnyx, Checkmarx, `axios`, and an impostor `@bitwarden/cli@2026.4.0`.
  The bad `axios` versions were live ~3 hours. *cold-brew:* the
  `bitwarden-cli` formula is the direct hit. Any commit bumping it to the
  trojaned version stays `Held` until `hold-days` elapse, by which point
  upstream had yanked. `axios` exposure is indirect via Node CLIs that
  bundle it.

- **Shai-Hulud npm worm (Sep 2025) and Shai-Hulud 2.0 (Nov 2025).**
  Self-propagating worm that stole maintainer tokens and republished
  trojaned versions: ~500 packages in wave one, ~795 in wave two. v2
  moved to a `preinstall` hook and tried to wipe `$HOME` on auth failure.
  *cold-brew:* malicious versions were yanked within hours and effectively
  all within ~5 days, inside a 7-day hold for any formula or cask whose
  tarball re-bundled them. Direct npm/PyPI/RubyGems exposure still needs
  ecosystem-specific tooling.

- **xz-utils backdoor, [CVE-2024-3094](https://nvd.nist.gov/vuln/detail/CVE-2024-3094)
  (Mar 2024).** Multi-year maintainer takeover planted a backdoor in
  `xz` 5.6.0 and 5.6.1. *cold-brew:* once OSV/GHSA flagged the bad versions,
  anyone on 5.4.x was blocked from upgrading into them. Release-to-disclosure
  gap was ~6 weeks; the default 7-day hold helps but doesn't cover the full
  window. `hold-days` ≥ 30 would have been decisive.

- **OpenSSL "SpookySSL", [CVE-2022-3602](https://nvd.nist.gov/vuln/detail/CVE-2022-3602)
  / [CVE-2022-3786](https://nvd.nist.gov/vuln/detail/CVE-2022-3786)
  (Nov 2022).** Users who upgraded the minute 3.0.7 shipped got a rushed
  build. *cold-brew:* hold window absorbs the panic-upgrade; auto-bypass
  kicks in if post-disclosure CVSS warrants it.

- **Apache Log4Shell, [CVE-2021-44228](https://nvd.nist.gov/vuln/detail/CVE-2021-44228)
  (Dec 2021).** CVSS 10.0 RCE in `log4j`, reachable through `openjdk` and
  JVM tools. *cold-brew:* CVSS auto-bypass promotes the fix out of the hold
  window on the first run after the advisory lands.

- **Homebrew-cask PR auto-merge RCE (Apr 2021, [RyotaK](https://blog.ryotak.net/post/homebrew-security-incident-en/)).**
  Arbitrary code execution against `homebrew-cask` via auto-merged PRs.
  *cold-brew:* hold window. A malicious cask merged at noon doesn't reach
  users until its commit is `hold-days` old.

- **Sudo "Baron Samedit", [CVE-2021-3156](https://nvd.nist.gov/vuln/detail/CVE-2021-3156)
  (Jan 2021).** Heap overflow in `sudo`, CVSS 7.8. *cold-brew:* CVSS
  auto-bypass at the default `7.0` threshold promotes the fix immediately.

cold-brew shifts the odds, it doesn't eliminate the risk. The design assumes
most bad releases are caught within days-to-weeks of publication.

## Requirements

- [Homebrew](https://brew.sh)
- `GITHUB_TOKEN` or `GH_TOKEN`: optional but recommended. Without one,
  GHSA lookups are skipped and stepping's version-history fetches hit
  GitHub's unauthenticated rate limit quickly.

Building from source additionally needs [Bun](https://bun.sh) (runtime and
bundler) and [Task](https://taskfile.dev) (build/install recipes).

## Installation

### Homebrew (Apple Silicon)

```sh
brew install ahokinson/tap/cold-brew
```

Ships a prebuilt Apple Silicon binary; `brew upgrade` picks up new releases.

### Build from source

```sh
task install
```

Runs `task build` (compiles a standalone binary at `dist/cold-brew`) then
`sudo ln -sf` into `/usr/local/bin/cold-brew`. To place it yourself:

```sh
task build
# dist/cold-brew is self-contained. Symlink anywhere on PATH.
```

## Usage

### Default: maintenance cycle

`cold-brew` with no arguments is the intended daily command. Runs `brew
update`, a cold-brew-aware `upgrade`, `brew cleanup`, and `brew doctor`,
filtering the noisiest output from each.

```sh
cold-brew
```

### `cold-brew upgrade [pkg…]`

Partitions outdated packages into ready, held, and stepping, then upgrades
the ready set via Homebrew. Optionally restricted to named packages.

```sh
cold-brew upgrade              # upgrade everything that's ready
cold-brew upgrade curl node    # only consider these two
```

### `cold-brew status`

Read-only summary of outdated packages, ready first, colored by hold state.

```sh
cold-brew status
```

### `cold-brew audit [--json]`

Every vulnerability, typosquat, and provenance flag for your installed
packages, grouped by kind and sorted critical to unknown. Typosquats and
provenance flags appear as informational sections (they never count toward
auto-bypass). `--json` emits the vulnerability list for scripting.

```sh
cold-brew audit
cold-brew audit --json | jq '.vulnerabilities[] | select(.severity == "critical")'
```

### Per-package policy

```sh
cold-brew hold <pkg>     # never auto-upgrade this package
cold-brew release <pkg>  # return to the default hold-window behavior
cold-brew allow <pkg>    # always upgrade immediately, skipping the hold window
```

### Global configuration

```sh
cold-brew config                         # show current settings
cold-brew config hold-days 10            # set hold window to 10 days
cold-brew config auto-bypass-cvss 8.5    # raise the CVSS bypass threshold
cold-brew config auto-bypass-kev false   # disable KEV-driven bypass
cold-brew config auto-bypass-epss 0.5    # bypass when EPSS ≥ 0.5
cold-brew config auto-bypass-epss disabled
```

### `cold-brew tap sync`

Reconciles the custom `cold-brew/cold-brew` tap in `tap/` with your local
Homebrew taps directory. The tap currently ships one formula, `dogshell`.

### `cold-brew tui` (alias: `cold-brew dashboard`)

Interactive terminal dashboard built on
[@opentui/solid](https://www.npmjs.com/package/@opentui/solid). Package
list, advisory details, search, and settings screens. The status bar shows
the active keybindings for the current view.

### Passthrough

Unknown subcommands forward to `brew` directly. `brew install` and `brew
reinstall` bypass hold policies, so cold-brew prints a warning when routed
through it. Pass `--no-guard` to silence the warning.

```sh
cold-brew info curl           # just forwarded to `brew info curl`
cold-brew install foo         # warning: hold policies do not apply
cold-brew install foo --no-guard
```

## Configuration

Settings live in a SQLite database at `~/.config/cold-brew/cold-brew.db`
(managed with [Drizzle ORM](https://orm.drizzle.team), WAL mode). The file is
created on first run.

| Setting             | Default    | Meaning                                                                                                       |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `hold-days`         | `7`        | Minimum upstream age (days) before a package becomes upgradable.                                              |
| `auto-bypass-cvss`  | `7.0`      | CVSS score at or above which a fixable advisory skips the hold window.                                        |
| `auto-bypass-kev`   | `true`     | When `true`, a fixable advisory on the [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) catalog skips the hold window regardless of CVSS. |
| `auto-bypass-epss`  | `disabled` | EPSS score (0-1) at or above which a fixable advisory skips the hold window. Set to `disabled` to turn off.    |

Per-package overrides (`always-hold` / `always-allow` / version pin) live
in the same database, set via `hold` / `release` / `allow`.

cold-brew sets `HOMEBREW_NO_AUTO_UPDATE=1` on every `brew` invocation so a
mid-command `brew update` can't derail its own runs.

To wipe state:

```sh
task db:reset
```

## Development

```sh
task dev                    # run from source with watch mode
task run -- upgrade curl    # invoke a subcommand against the live source
task check                  # tsc --noEmit
task lint                   # biome check src
task format                 # biome check --fix src
task test                   # bun test
task clean                  # remove node_modules and dist
task db:reset               # delete the SQLite database
```

Lint and formatting via [Biome](https://biomejs.dev) (`biome.json`).
TypeScript path aliases (`@brew/*`, `@cli/*`, `@db`, `@tui/*`) in
`tsconfig.json`.

## Status

Personal project. No planned release cadence.
