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

function writeReset(output: Pick<NodeJS.WriteStream, "isTTY" | "write">) {
  if (!output.isTTY) return
  output.write(TUI_EXIT_RESET)
}

export function restoreTerminalState(
  output: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stdout,
  input: Pick<NodeJS.ReadStream, "isTTY"> & { setRawMode?: (mode: boolean) => unknown } = process.stdin,
) {
  if (input.isTTY && input.setRawMode) input.setRawMode(false)
  writeReset(process.stdout)
  writeReset(process.stderr)
  if (output === process.stdout || output === process.stderr) return
  writeReset(output)
}

export { TUI_EXIT_RESET }
