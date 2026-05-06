import { writeSync } from "node:fs"

const TUI_EXIT_RESET = [
  "\x1b[?1000l",
  "\x1b[?1002l",
  "\x1b[?1003l",
  "\x1b[?1004l",
  "\x1b[?1005l",
  "\x1b[?1006l",
  "\x1b[?1015l",
  "\x1b[?2004l",
  "\x1b[?25h",
  "\x1b[?1049l",
  "\x1b[0m",
  "\r",
].join("")

function writeReset(fd: number, tty: boolean | undefined) {
  if (!tty) return
  try {
    writeSync(fd, TUI_EXIT_RESET)
  } catch {
    // Ignore tty write failures during shutdown.
  }
}

export function restoreTerminalState(
  output: Pick<NodeJS.WriteStream, "isTTY" | "write"> & { fd?: number } = process.stdout,
  input: Pick<NodeJS.ReadStream, "isTTY"> & Partial<Pick<NodeJS.ReadStream, "setRawMode">> = process.stdin,
) {
  if (input.isTTY && typeof input.setRawMode === "function") {
    try {
      input.setRawMode(false)
    } catch {
      // Ignore stdin implementations that reject raw-mode changes during shutdown.
    }
  }

  writeReset(process.stdout.fd, process.stdout.isTTY)
  writeReset(process.stderr.fd, process.stderr.isTTY)

  if (!output.isTTY) return
  if (output.fd === process.stdout.fd || output.fd === process.stderr.fd) return
  output.write(TUI_EXIT_RESET)
}

export { TUI_EXIT_RESET }
