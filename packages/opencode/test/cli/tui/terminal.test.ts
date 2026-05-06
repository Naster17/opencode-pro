import { expect, test } from "bun:test"

const { TUI_EXIT_RESET, restoreTerminalState } = await import("../../../src/cli/cmd/tui/util/terminal")

test("restoreTerminalState disables raw mode and resets terminal features", () => {
  const modes: boolean[] = []
  const writes: string[] = []
  const stdoutWrites: string[] = []
  const stderrWrites: string[] = []
  const stdout = spyWrite(process.stdout, stdoutWrites)
  const stderr = spyWrite(process.stderr, stderrWrites)
  const input: Pick<NodeJS.ReadStream, "isTTY"> & Partial<Pick<NodeJS.ReadStream, "setRawMode">> = {
    isTTY: true,
    setRawMode(value: boolean) {
      modes.push(value)
      return this as never
    },
  }
  const output = {
    isTTY: true,
    write: (value: string) => {
      writes.push(value)
      return true
    },
  }

  try {
    restoreTerminalState(output, input)
  } finally {
    stdout()
    stderr()
  }

  expect(modes).toEqual([false])
  expect(writes).toEqual([TUI_EXIT_RESET])
  expect(stdoutWrites).toEqual(process.stdout.isTTY ? [TUI_EXIT_RESET] : [])
  expect(stderrWrites).toEqual(process.stderr.isTTY ? [TUI_EXIT_RESET] : [])
})

test("restoreTerminalState skips terminal reset for non-tty output", () => {
  const writes: string[] = []
  const output = {
    isTTY: false,
    write: (value: string) => {
      writes.push(value)
      return true
    },
  }

  restoreTerminalState(output, { isTTY: false })

  expect(writes).toEqual([])
})

function spyWrite(stream: NodeJS.WriteStream, writes: string[]) {
  const original = stream.write
  stream.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof stream.write
  return () => {
    stream.write = original
  }
}
