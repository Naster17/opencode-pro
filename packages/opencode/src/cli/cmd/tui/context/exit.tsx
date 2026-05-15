import { useRenderer } from "@opentui/solid"
import * as Log from "@opencode-ai/core/util/log"
import { createSimpleContext } from "./helper"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { restoreTerminalState } from "../util/terminal"
import { win32FlushInputBuffer } from "../win32"

const log = Log.create({ service: "tui.exit" })
const EXTERNAL_SIGNAL_CONFIRM_WINDOW_MS = 2000
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
    let pendingExternalSignal: { signal: NodeJS.Signals; time: number } | undefined
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
    const handleSignal = (signal: NodeJS.Signals) => {
      if (signal === "SIGINT") {
        log.info("received interactive exit signal", { signal })
        void exit()
        return
      }

      const now = Date.now()
      if (
        pendingExternalSignal?.signal === signal &&
        now - pendingExternalSignal.time <= EXTERNAL_SIGNAL_CONFIRM_WINDOW_MS
      ) {
        log.warn("received repeated external signal, exiting", { signal })
        void exit()
        return
      }

      pendingExternalSignal = { signal, time: now }
      log.warn("ignoring first external signal while TUI is active", { signal })
    }
    const onSighup = () => handleSignal("SIGHUP")
    const onSigint = () => handleSignal("SIGINT")
    const onSigterm = () => handleSignal("SIGTERM")
    process.on("SIGHUP", onSighup)
    process.on("SIGINT", onSigint)
    process.on("SIGTERM", onSigterm)
    return exit
  },
})
