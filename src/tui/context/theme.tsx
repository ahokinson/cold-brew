import { createTheme, ThemeProvider as PressThemeProvider, useTheme as pressUseTheme } from "@ahokinson/press/theme"
import { flavors } from "@catppuccin/palette"
import type { ParentProps } from "solid-js"

const palette = flavors.frappe.colors

export const theme = createTheme({
  ready: palette.green.hex,
  fresh: palette.peach.hex,
  stale: palette.yellow.hex,
  overdue: palette.red.hex,
  pinned: palette.sky.hex,
  locked: palette.mauve.hex,
  // Domain hues press's semantic palette doesn't cover (custom-tap, brew-pinned, etc.).
  lavender: palette.lavender.hex,
  maroon: palette.maroon.hex,
  flamingo: palette.flamingo.hex,
  teal: palette.teal.hex,
})

export type Theme = typeof theme

export function ThemeProvider(props: ParentProps) {
  return <PressThemeProvider value={theme}>{props.children}</PressThemeProvider>
}

export function useTheme(): Theme {
  return pressUseTheme() as Theme
}
