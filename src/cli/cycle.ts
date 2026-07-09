import {
  type Classifier,
  createCleanupClassifier,
  createDoctorClassifier,
  createUpdateClassifier,
  decideExit,
  type OrganizeContext,
  organize,
  printOrganized,
} from "@brew/organize"
import { Ansi, bold, dim } from "@cli/ansi"
import { getOriginalTap } from "@db"

interface StepResult {
  exitCode: number
  // Whether cold-brew surfaced anything actionable (a deferred or kept block).
  // Benign-but-nonzero brew exits (e.g. doctor's expected warnings) are not
  // surfaced and so don't trip the cycle's "reported issues" summary.
  surfaced: boolean
}

interface Step {
  label: string
  run: () => Promise<StepResult>
}

// A keg cold-brew installed under its own tap (stepping/holding) — used to drop
// the orphan/unlinked-keg warnings that are cold-brew's own doing.
const defaultIsManaged = (name: string): boolean => getOriginalTap(name) !== null

function printHeader(label: string): void {
  console.log(`${Ansi.BLUE}${bold("==>")}${Ansi.BOLD} ${label}${Ansi.RESET}`)
}

// "a" / "a and b" / "a, b, and c" — list-aware so 3+ failures read naturally.
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}

export async function runMaintenanceCycle(): Promise<number> {
  const { brewCapture } = await import("@brew/api")
  const { handleUpgrade } = await import("@cli/wrapper")

  let sawColdBrewTapWarning = false

  // Capture a brew command, condense it through its classifier, print the
  // organized result, and decide whether it surfaced anything actionable.
  const organizeStep = async (
    args: string[],
    classifier: Classifier,
    options: { env?: Record<string, string>; ctx?: Partial<OrganizeContext> } = {},
  ): Promise<StepResult> => {
    const { text, exitCode } = await brewCapture(args, { env: options.env })
    const ctx: OrganizeContext = { isManaged: defaultIsManaged, state: {}, ...options.ctx }
    const result = organize(text, classifier, ctx)
    printOrganized(result)
    return decideExit(exitCode, result)
  }

  const steps: Step[] = [
    {
      label: "Updating Homebrew...",
      run: () =>
        organizeStep(["update"], createUpdateClassifier(), {
          env: { HOMEBREW_NO_UPDATE_REPORT: "1" },
        }),
    },
    {
      label: "Upgrading packages...",
      run: async () => {
        // handleUpgrade prints its own plan/result and organizes brew's upgrade
        // chatter internally; an upgrade failure is always actionable.
        const exitCode = await handleUpgrade(["upgrade"])
        return { exitCode, surfaced: exitCode !== 0 }
      },
    },
    {
      label: "Cleaning up...",
      run: () => organizeStep(["cleanup"], createCleanupClassifier()),
    },
    {
      label: "Running doctor...",
      run: () =>
        organizeStep(["doctor"], createDoctorClassifier(), {
          ctx: {
            onColdBrewTapWarning: () => {
              sawColdBrewTapWarning = true
            },
          },
        }),
    },
  ]

  const failures: string[] = []
  let firstFailure = 0

  for (const step of steps) {
    printHeader(step.label)
    const { exitCode, surfaced } = await step.run()
    if (surfaced) {
      failures.push(step.label.replace("...", ""))
      if (firstFailure === 0 && exitCode !== 0) firstFailure = exitCode
    }
    console.log()
  }

  if (failures.length > 0) {
    console.log(`${Ansi.YELLOW}cold-brew: ${joinList(failures).toLowerCase()} reported issues (see above)${Ansi.RESET}`)
  }

  if (sawColdBrewTapWarning) {
    console.log(dim("cold-brew: tap warnings for cold-brew/cold-brew are expected (local tap, no remote)"))
  }

  // Prefer brew's real exit code, but still exit nonzero when something
  // surfaced on a benign exit-0 step so the code matches the printed summary.
  if (firstFailure !== 0) return firstFailure
  return failures.length > 0 ? 1 : 0
}
