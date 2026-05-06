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

export function restoreTerminalState(
  output: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stdout,
  input: Pick<NodeJS.ReadStream, "isTTY"> & Partial<Pick<NodeJS.ReadStream, "setRawMode">> = process.stdin,
) {
  if (input.isTTY && typeof input.setRawMode === "function") {
    try {
      input.setRawMode(false)
    } catch {
      // Ignore stdin implementations that reject raw-mode changes during shutdown.
    }
  }

  if (!output.isTTY) return
  output.write(TUI_EXIT_RESET)
}

export { TUI_EXIT_RESET }
