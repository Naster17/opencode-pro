import { useRenderer } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { restoreTerminalState } from "../util/terminal"
import { win32FlushInputBuffer } from "../win32"
type Exit = ((reason?: unknown) => Promise<void>) & {
  message: {
    set: (value?: string) => () => void
    clear: () => void
    get: () => string | undefined
  }
}

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { onBeforeExit?: () => Promise<void>; onExit?: () => Promise<void> }) => {
    const renderer = useRenderer()
    let message: string | undefined
    let task: Promise<void> | undefined
    const store = {
      set: (value?: string) => {
        const prev = message
        message = value
        return () => {
          message = prev
        }
      },
      clear: () => {
        message = undefined
      },
      get: () => message,
    }
    const exit: Exit = Object.assign(
      (reason?: unknown) => {
        if (task) return task
        task = (async () => {
          // Reset window title before destroying renderer
          renderer.setTerminalTitle("")
          renderer.destroy()
          restoreTerminalState()
          win32FlushInputBuffer()
          await input.onBeforeExit?.()
          if (reason) {
            const formatted = FormatError(reason) ?? FormatUnknownError(reason)
            if (formatted) {
              process.stderr.write(formatted + "\n")
            }
          }
          const text = store.get()
          if (text) process.stdout.write(text + "\n")
          await input.onExit?.()
        })()
        return task
      },
      {
        message: store,
      },
    )
    const handleSignal = () => {
      void exit()
    }
    process.on("SIGHUP", handleSignal)
    process.on("SIGINT", handleSignal)
    process.on("SIGTERM", handleSignal)
    return exit
  },
})
