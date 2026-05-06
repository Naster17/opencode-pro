import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { CommandOption } from "@tui/component/dialog-command"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "./dialog"
import { useKeybind } from "@tui/context/keybind"
import { ConfigKeybinds } from "@/config/keybinds"
import { Keybind } from "@/util/keybind"
import { getScrollAcceleration } from "../util/scroll"
import { createEffect, createMemo, For, Show } from "solid-js"

type HelpRow = {
  label: string
  meta?: string
  description: string
}

const KEYBIND_CATEGORY_LABELS = {
  app: "App",
  session: "Session",
  model: "Models & Agents",
  input: "Input & History",
} as const

function title(key: string) {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase()
}

function keybindCategory(key: string) {
  if (key.startsWith("input_") || key.startsWith("history_")) return "input"
  if (
    key.startsWith("model_") ||
    key.startsWith("agent_") ||
    key.startsWith("variant_") ||
    key === "thinking_level_cycle"
  ) {
    return "model"
  }
  if (
    key.startsWith("session_") ||
    key.startsWith("messages_") ||
    key.startsWith("session_child_") ||
    key === "session_parent" ||
    key === "tool_details" ||
    key === "display_thinking" ||
    key === "scrollbar_toggle" ||
    key === "username_toggle"
  ) {
    return "session"
  }
  return "app"
}

function Section(props: { title: string; description?: string; rows: HelpRow[] }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
      </box>
      <Show when={props.description}>
        <text fg={theme.textMuted}>{props.description}</text>
      </Show>
      <For each={props.rows}>
        {(row) => (
          <box flexDirection="column" paddingLeft={1}>
            <box flexDirection="row" justifyContent="space-between" gap={2}>
              <text fg={theme.text} wrapMode="none" overflow="hidden">
                {row.label}
              </text>
              <Show when={row.meta}>
                <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                  {row.meta}
                </text>
              </Show>
            </box>
            <Show when={normalizeText(row.description) !== normalizeText(row.label)}>
              <text fg={theme.textMuted}>{row.description}</text>
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}

export function DialogHelp(props: { commands: CommandOption[] }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dimensions = useTerminalDimensions()

  let scroll: ScrollBoxRenderable | undefined

  createEffect(() => {
    if (dimensions().width >= 128) {
      dialog.setSize("xlarge")
      return
    }
    dialog.setSize("large")
  })

  const bindingShape = ConfigKeybinds.Keybinds.shape as Record<string, { description?: string }>
  const leaderKey = createMemo(() => keybind.all.leader?.[0])
  const printBinding = (item: Keybind.Info) => {
    const text = Keybind.toString(item)
    const leader = leaderKey()
    if (!leader) return text
    return text.replace("<leader>", Keybind.toString(leader))
  }
  const commandBinding = (id?: string) => {
    if (!id) return
    const value = keybind.print(id)
    if (!value || value === "none" || value === id) return
    return value
  }

  const keybindRows = createMemo(() =>
    Object.entries(keybind.all)
      .filter(([_, bindings]) => bindings.length > 0)
      .filter(([_, bindings]) => bindings[0] && printBinding(bindings[0]) !== "none")
      .map(([id, bindings]) => ({
        category: keybindCategory(id),
        row: {
          label: title(id),
          meta: bindings.map(printBinding).join(", "),
          description: bindingShape[id]?.description ?? title(id),
        } satisfies HelpRow,
      })),
  )

  const keybindSections = createMemo(() =>
    Object.entries(KEYBIND_CATEGORY_LABELS)
      .map(([id, label]) => ({
        title: `Keybindings · ${label}`,
        rows: keybindRows()
          .filter((item) => item.category === id)
          .map((item) => item.row),
      }))
      .filter((section) => section.rows.length > 0),
  )

  const commands = createMemo(() =>
    props.commands
      .slice()
      .sort((a, b) => {
        const category = (a.category ?? "").localeCompare(b.category ?? "")
        if (category !== 0) return category
        return a.title.localeCompare(b.title)
      })
      .map((item) => ({
        ...item,
        description: item.description ?? item.title,
      })),
  )

  const commandSections = createMemo(() =>
    [...new Set(commands().map((item) => item.category ?? "Other"))].map((category) => ({
      title: `Commands · ${category}`,
      rows: commands()
        .filter((item) => (item.category ?? "Other") === category)
        .map((item) => {
          const pieces = [commandBinding(item.keybind), item.slash ? `/${item.slash.name}` : undefined].filter(Boolean)
          return {
            label: item.title,
            meta: pieces.join(" · ") || "palette only",
            description: item.description,
          } satisfies HelpRow
        }),
    })),
  )

  const overviewRows = createMemo(
    () =>
      [
        {
          label: "Command palette",
          meta: keybind.print("command_list"),
          description: "Browse every available action in the current context.",
        },
        {
          label: "Agent switch",
          meta: keybind.print("agent_cycle"),
          description: "Move between agents without leaving the prompt.",
        },
        {
          label: "Model switch",
          meta: keybind.print("model_list"),
          description: "Pick a model, provider, or variant for the active agent.",
        },
        {
          label: "Sidebar toggle",
          meta: keybind.print("sidebar_toggle"),
          description: "Show or hide the session sidebar.",
        },
        {
          label: "Interrupt run",
          meta: keybind.print("session_interrupt"),
          description: "Stop the current generation or tool run.",
        },
      ] satisfies HelpRow[],
  )

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      dialog.clear()
      return
    }
    if (!scroll) return
    if (evt.name === "up") {
      evt.preventDefault()
      evt.stopPropagation()
      scroll.scrollBy(-1)
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      evt.stopPropagation()
      scroll.scrollBy(1)
      return
    }
    if (evt.name === "pageup") {
      evt.preventDefault()
      evt.stopPropagation()
      scroll.scrollBy(-scroll.height)
      return
    }
    if (evt.name === "pagedown") {
      evt.preventDefault()
      evt.stopPropagation()
      scroll.scrollBy(scroll.height)
      return
    }
    if (evt.name === "home") {
      evt.preventDefault()
      evt.stopPropagation()
      scroll.scrollTo(0)
      return
    }
    if (evt.name === "end") {
      evt.preventDefault()
      evt.stopPropagation()
      scroll.scrollTo(scroll.scrollHeight)
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Help
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc close
        </text>
      </box>
      <text fg={theme.textMuted}>
        Commands and shortcuts below reflect your current context and active keybind config.
      </text>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => (scroll = value)}
        height={Math.max(16, Math.min(dimensions().height - 16, 30))}
        scrollAcceleration={getScrollAcceleration()}
        paddingRight={1}
      >
        <box flexDirection="column" gap={1} paddingBottom={1}>
          <Section title="Overview" rows={overviewRows()} />
          <For each={commandSections()}>{(section) => <Section title={section.title} rows={section.rows} />}</For>
          <For each={keybindSections()}>{(section) => <Section title={section.title} rows={section.rows} />}</For>
        </box>
      </scrollbox>
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={theme.textMuted}>↑/↓ scroll · pgup/pgdn page · home/end jump</text>
        <text fg={theme.textMuted}>enter close</text>
      </box>
    </box>
  )
}
