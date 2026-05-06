import { expect, test } from "bun:test"

const { TUI_EXIT_RESET, restoreTerminalState } = await import("../../../src/cli/cmd/tui/util/terminal")

test("restoreTerminalState disables raw mode and resets terminal features", () => {
  const modes: boolean[] = []
  const writes: string[] = []
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

  restoreTerminalState(output, input)

  expect(modes).toEqual([false])
  expect(writes).toEqual([TUI_EXIT_RESET])
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
