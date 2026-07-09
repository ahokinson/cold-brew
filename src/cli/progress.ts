const isTTY = process.stderr.isTTY

export function statusUpdate(message: string): void {
  if (isTTY) {
    process.stderr.write(`\r\x1b[2m${message}\x1b[0m\x1b[K`)
  }
}

export function statusClear(): void {
  if (isTTY) {
    process.stderr.write(`\r\x1b[K`)
  }
}
