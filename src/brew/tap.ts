import { stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureColdBrewTap } from "@brew/api"

export const NATIVE_TAPS = new Set(["homebrew/core", "homebrew/cask"])

export function isCustomTap(tap: string): boolean {
  return !NATIVE_TAPS.has(tap)
}

// Homebrew considers any tap owned by the "Homebrew" org official (Tap#official?
// in brew is `user == "Homebrew"`), which is broader than the two native taps.
// Trust is granted automatically to official taps, so trust checks need this.
export function isOfficialTap(tap: string): boolean {
  const [owner, repo] = tap.split("/")
  // Require a real owner/repo shape: a slashless "homebrew" is a malformed tap,
  // not an official one, and must not be granted trust.
  return repo != null && repo !== "" && (owner ?? "").toLowerCase() === "homebrew"
}

// Formulas cold-brew publishes into its own tap, keyed by formula name. Empty
// for now — add entries here and `cold-brew tap sync` writes and commits them.
const FORMULAS: Record<string, string> = {}

async function ensureGitRepo(tapPath: string): Promise<void> {
  try {
    await stat(join(tapPath, ".git"))
  } catch {
    const init = Bun.spawn(["git", "init"], { cwd: tapPath, stdout: "pipe", stderr: "pipe" })
    await init.exited
  }
}

async function gitCommitFormulas(tapPath: string): Promise<void> {
  const add = Bun.spawn(["git", "add", "."], { cwd: tapPath, stdout: "pipe", stderr: "pipe" })
  await add.exited

  const commit = Bun.spawn(["git", "commit", "-m", "Sync cold-brew tap formulas", "--allow-empty"], {
    cwd: tapPath,
    stdout: "pipe",
    stderr: "pipe",
  })
  await commit.exited
}

export async function syncTapFormulas(): Promise<number> {
  const tapPath = await ensureColdBrewTap()
  await ensureGitRepo(tapPath)

  for (const [name, content] of Object.entries(FORMULAS)) {
    const dest = join(tapPath, "Formula", `${name}.rb`)
    await writeFile(dest, content)
    console.log(`  ${name}.rb`)
  }

  await gitCommitFormulas(tapPath)
  console.log(`\nSynced ${Object.keys(FORMULAS).length} formula(s) to cold-brew/cold-brew tap.`)
  return 0
}
