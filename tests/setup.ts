// Global test setup. Loaded via bunfig.toml [test] preload — only runs for
// `bun test`, never bundled into the production binary.
//
// 1. Points @db at a per-process tmp dir BEFORE any module reads it. Bun
//    caches node:os.homedir() at startup and ignores later process.env.HOME
//    mutations, so we route through COLD_BREW_DB_DIR (read live at @db
//    import time).
// 2. Installs the @opentui/solid Bun plugin which swaps Solid's server.js
//    (no reactivity) for solid.js (full reactivity) — Bun's "node" resolution
//    condition picks server.js by default. Without this, createEffect/Memo
//    are no-ops in tests.

import "@opentui/solid/preload"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dbDir = mkdtempSync(join(tmpdir(), "cold-brew-test-"))
process.env.COLD_BREW_DB_DIR = dbDir

// Force @brew/api's brewPrefix() to resolve to a tmp dir instead of spawning
// `brew --prefix`. Lets install/tap tests write under an isolated, writable
// prefix without ever touching the user's real Homebrew tree.
const prefixDir = mkdtempSync(join(tmpdir(), "cold-brew-prefix-"))
process.env.COLD_BREW_BREW_PREFIX = prefixDir
