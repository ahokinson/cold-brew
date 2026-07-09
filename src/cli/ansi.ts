const colorEnabled =
  !process.env.NO_COLOR &&
  process.env.FORCE_COLOR !== "0" &&
  (process.env.FORCE_COLOR != null || Boolean(process.stdout.isTTY))

function code(value: string): string {
  return colorEnabled ? value : ""
}

export const Ansi = {
  DIM: code("\x1b[2m"),
  RESET: code("\x1b[0m"),
  BOLD: code("\x1b[1m"),
  YELLOW: code("\x1b[33m"),
  GREEN: code("\x1b[32m"),
  CYAN: code("\x1b[36m"),
  BLUE: code("\x1b[34m"),
  RED: code("\x1b[31m"),
  MAGENTA: code("\x1b[35m"),
}

export const Color = {
  ready: Ansi.GREEN,
  held: Ansi.YELLOW,
  stepping: Ansi.CYAN,
  bypass: Ansi.MAGENTA,
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return n === 1 ? singular : pluralForm
}

export function dim(s: string): string {
  return colorEnabled ? `${Ansi.DIM}${s}${Ansi.RESET}` : s
}

export function bold(s: string): string {
  return colorEnabled ? `${Ansi.BOLD}${s}${Ansi.RESET}` : s
}
