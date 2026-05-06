import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { win32FlushInputBuffer } from "../win32"
import { getScrollAcceleration } from "../util/scroll"
import { createSignal } from "solid-js"

export function ErrorComponent(props: {
  error: Error
  reset: () => void
  onBeforeExit?: () => Promise<void>
  onExit: () => Promise<void>
  mode?: "dark" | "light"
}) {
  const term = useTerminalDimensions()
  const renderer = useRenderer()
  const [copied, setCopied] = createSignal(false)

  const handleExit = async () => {
    await props.onBeforeExit?.()
    renderer.setTerminalTitle("")
    renderer.destroy()
    win32FlushInputBuffer()
    await props.onExit()
  }

  const errorText = () => [props.error.message, props.error.stack].filter(Boolean).join("\n\n")
  const handleCopy = async () => {
    await Clipboard.copy(errorText()).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      void handleExit()
      return
    }
    if (evt.name === "y") {
      evt.preventDefault()
      evt.stopPropagation()
      void handleCopy()
    }
  })

  // Choose safe fallback colors per mode since theme context may not be available
  const isLight = props.mode === "light"
  const colors = {
    bg: isLight ? "#ffffff" : "#0a0a0a",
    text: isLight ? "#1a1a1a" : "#eeeeee",
    muted: isLight ? "#8a8a8a" : "#808080",
    primary: isLight ? "#3b7dd8" : "#fab283",
  }

  return (
    <box flexDirection="column" gap={1} backgroundColor={colors.bg}>
      <box flexDirection="row" gap={2} alignItems="center">
        <text attributes={TextAttributes.BOLD} fg={colors.text}>
          A fatal error occurred!
        </text>
        <box onMouseUp={() => void handleCopy()} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Copy error</text>
        </box>
        <box onMouseUp={props.reset} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Reset TUI</text>
        </box>
        <box onMouseUp={handleExit} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Exit</text>
        </box>
      </box>
      <text fg={colors.muted}>{copied() ? "Error copied to clipboard" : "Press Y to copy the full error log"}</text>
      <scrollbox height={Math.floor(term().height * 0.7)} scrollAcceleration={getScrollAcceleration()}>
        <text fg={colors.muted}>{props.error.stack}</text>
      </scrollbox>
      <text fg={colors.text}>{props.error.message}</text>
    </box>
  )
}
