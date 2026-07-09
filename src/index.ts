#!/usr/bin/env bun

import type { Hold } from "@brew/types"
import { Ansi } from "@cli/ansi"

const args = process.argv.slice(2)

function policyCommand(policy: Hold.Policy, label: string): (args: string[]) => Promise<number> {
  return async (args) => {
    const { setPackagePolicy } = await import("@db")
    const { isValidPackageName } = await import("@brew/validate")
    const name = args[1]
    if (!name) {
      console.error(`Usage: cold-brew ${args[0]} <package>`)
      return 1
    }
    if (!isValidPackageName(name)) {
      console.error(`Invalid package name: ${name}`)
      return 1
    }
    setPackagePolicy(name, policy)
    console.log(`${name}: ${label}`)
    return 0
  }
}

const commands: Record<string, (args: string[]) => Promise<number>> = {
  dashboard: async () => {
    const { launchTUI } = await import("@tui/app.tsx")
    await launchTUI()
    return 0
  },

  tui: async () => {
    const { launchTUI } = await import("@tui/app.tsx")
    await launchTUI()
    return 0
  },

  tap: async (args) => {
    const subcommand = args[1]
    if (subcommand === "sync") {
      const { syncTapFormulas } = await import("@brew/tap.ts")
      return syncTapFormulas()
    }
    console.error("Usage: cold-brew tap sync")
    return 1
  },

  upgrade: async (args) => {
    const { handleUpgrade } = await import("@cli/wrapper.ts")
    return handleUpgrade(args)
  },

  audit: async (args) => {
    const { handleAudit } = await import("@cli/audit.ts")
    return handleAudit(args)
  },

  status: async () => {
    const { handleStatus } = await import("@cli/status.ts")
    return handleStatus()
  },

  hold: policyCommand("always-hold", "always hold"),
  release: policyCommand("default", "default policy"),
  allow: policyCommand("always-allow", "always allow"),

  config: async (args) => {
    const {
      getHoldDays,
      setHoldDays,
      getAutoBypassThreshold,
      setAutoBypassThreshold,
      getAutoBypassKev,
      setAutoBypassKev,
      getAutoBypassEpss,
      setAutoBypassEpss,
      EPSS_DISABLED,
    } = await import("@db")
    const subcommand = args[1]
    if (subcommand === "hold-days") {
      const value = args[2]
      if (value) {
        const days = parseInt(value, 10)
        if (Number.isNaN(days) || days < 0) {
          console.error("hold-days must be a non-negative integer")
          return 1
        }
        setHoldDays(days)
        console.log(`Hold days set to ${days}`)
      } else {
        console.log(`Hold days: ${getHoldDays()}`)
      }
    } else if (subcommand === "auto-bypass-cvss") {
      const value = args[2]
      if (value) {
        const parsed = parseFloat(value)
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) {
          console.error("auto-bypass-cvss must be between 0 and 10")
          return 1
        }
        setAutoBypassThreshold(parsed)
        console.log(`Auto-bypass CVSS threshold set to ${parsed}`)
      } else {
        console.log(`Auto-bypass CVSS threshold: ${getAutoBypassThreshold()}`)
      }
    } else if (subcommand === "auto-bypass-kev") {
      const value = args[2]
      if (value) {
        if (value !== "true" && value !== "false") {
          console.error("auto-bypass-kev must be 'true' or 'false'")
          return 1
        }
        setAutoBypassKev(value === "true")
        console.log(`Auto-bypass KEV set to ${value}`)
      } else {
        console.log(`Auto-bypass KEV: ${getAutoBypassKev()}`)
      }
    } else if (subcommand === "auto-bypass-epss") {
      const value = args[2]
      if (value) {
        if (value === EPSS_DISABLED) {
          setAutoBypassEpss(EPSS_DISABLED)
          console.log(`Auto-bypass EPSS disabled`)
        } else {
          const parsed = parseFloat(value)
          if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
            console.error("auto-bypass-epss must be between 0 and 1 or 'disabled'")
            return 1
          }
          setAutoBypassEpss(parsed)
          console.log(`Auto-bypass EPSS threshold set to ${parsed}`)
        }
      } else {
        const current = getAutoBypassEpss()
        console.log(`Auto-bypass EPSS: ${current === null ? EPSS_DISABLED : current}`)
      }
    } else {
      const epss = getAutoBypassEpss()
      console.log(`hold-days: ${getHoldDays()}`)
      console.log(`auto-bypass-cvss: ${getAutoBypassThreshold()}`)
      console.log(`auto-bypass-kev: ${getAutoBypassKev()}`)
      console.log(`auto-bypass-epss: ${epss === null ? EPSS_DISABLED : epss}`)
    }
    return 0
  },
}

// Commands that bypass cold-brew hold policies when passed through to brew.
// Warn the user so they know the safety net is not active.
const GUARDED_PASSTHROUGH = new Set(["install", "reinstall"])

const command = args[0]

// Report cold-brew's own version. Baked in at build time (build.ts `define`);
// "dev" when running from source. Matched only in command position so it never
// shadows a `-v`/`--version` a passthrough subcommand meant for brew.
if (command === "version" || command === "--version" || command === "-v") {
  console.log(process.env.COLD_BREW_VERSION ?? "dev")
  process.exit(0)
}

const handler = command ? commands[command] : undefined

if (!command) {
  const { runMaintenanceCycle } = await import("@cli/cycle.ts")
  process.exit(await runMaintenanceCycle())
} else if (handler) {
  const exitCode = await handler(args)
  if (command !== "dashboard" && command !== "tui") process.exit(exitCode)
} else {
  if (GUARDED_PASSTHROUGH.has(command) && !args.includes("--no-guard")) {
    console.warn(`${Ansi.YELLOW}warning:${Ansi.RESET} \`brew ${command}\` bypasses the cold-brew hold window.`)
  }
  const passthroughArgs = args.filter((a) => a !== "--no-guard")
  const { brewPassthrough } = await import("@brew/api.ts")
  process.exit(await brewPassthrough(passthroughArgs))
}
