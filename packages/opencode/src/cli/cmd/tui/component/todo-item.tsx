import { Locale } from "@/util/locale"
import { useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"

export interface TodoItemProps {
  status: string
  content: string
  singleLine?: boolean
  expanded?: boolean
  maxLength?: number
  interactive?: boolean
  onClick?: () => void
}

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const collapsed = () => props.singleLine && !props.expanded
  const fg = () => {
    if (props.interactive && hover()) return theme.text
    return props.status === "in_progress" ? theme.warning : theme.textMuted
  }

  return (
    <box
      flexDirection="row"
      gap={0}
      onMouseOver={() => props.interactive && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <text
        flexShrink={0}
        style={{
          fg: fg(),
        }}
      >
        [{props.status === "completed" ? "✓" : props.status === "in_progress" ? "•" : " "}]{" "}
      </text>
      <text
        flexGrow={1}
        wrapMode={collapsed() ? "none" : "word"}
        overflow={collapsed() ? "hidden" : undefined}
        style={{
          fg: fg(),
        }}
      >
        {collapsed() ? Locale.truncate(props.content, props.maxLength ?? props.content.length) : props.content}
      </text>
    </box>
  )
}
