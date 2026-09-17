import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { CommandOption } from "@tui/component/dialog-command"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "./dialog"
import { useKeybind } from "@tui/context/keybind"
import { ConfigKeybinds } from "@/config/keybinds"
import { Keybind } from "@/util/keybind"
import { getScrollAcceleration } from "../util/scroll"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"

type HelpRow = {
  label: string
  meta?: string
  description: string
  search: string[]
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

export function normalizeHelpText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase()
}

export function helpSearchTerms(value?: string) {
  if (!value) return []
  return [...new Set(value.split(", ").flatMap((item) => [item, item.replaceAll("+", "-"), item.replaceAll("+", " ")]))]
}

export function helpCommandSearchTerms(command: Pick<CommandOption, "slash">, binding?: string) {
  const slashTerms = command.slash
    ? [
        "/" + command.slash.name,
        command.slash.name,
        ...(command.slash.aliases ?? []),
        ...(command.slash.aliases ?? []).map((x) => "/" + x),
      ]
    : []
  return [...slashTerms, ...helpSearchTerms(binding)]
}

export function matchesHelpQuery(query: string, row: Pick<HelpRow, "label" | "description" | "meta" | "search">) {
  const needle = normalizeHelpText(query)
  if (!needle) return true
  return [row.label, row.description, row.meta, ...row.search].some(
    (item) => item && normalizeHelpText(item).includes(needle),
  )
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

function typedChar(name: string) {
  if (name.length === 1) return name
  if (name === "space") return " "
  if (name === "slash") return "/"
  if (name === "minus") return "-"
  if (name === "plus") return "+"
  if (name === "period") return "."
  return
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
            <Show when={normalizeHelpText(row.description) !== normalizeHelpText(row.label)}>
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
  const [query, setQuery] = createSignal("")

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
      .map(([id, bindings]) => {
        const meta = bindings.map(printBinding).join(", ")
        return {
          category: keybindCategory(id),
          row: {
            label: title(id),
            meta,
            description: bindingShape[id]?.description ?? title(id),
            search: helpSearchTerms(meta),
          } satisfies HelpRow,
        }
      }),
  )

  const keybindSections = createMemo(() =>
    Object.entries(KEYBIND_CATEGORY_LABELS)
      .map(([id, label]) => ({
        title: `Keybindings · ${label}`,
        rows: keybindRows()
          .filter((item) => item.category === id)
          .map((item) => item.row)
          .filter((row) => matchesHelpQuery(query(), row)),
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
      .map((item) => {
        const binding = commandBinding(item.keybind)
        const slash = item.slash ? `/${item.slash.name}` : undefined
        return {
          category: item.category ?? "Other",
          row: {
            label: item.title,
            meta: [binding, slash].filter(Boolean).join(" · ") || "palette only",
            description: item.description ?? item.title,
            search: helpCommandSearchTerms(item, binding),
          } satisfies HelpRow,
        }
      }),
  )

  const commandSections = createMemo(() =>
    [...new Set(commands().map((item) => item.category))]
      .map((category) => ({
        title: `Commands · ${category}`,
        rows: commands()
          .filter((item) => item.category === category)
          .map((item) => item.row)
          .filter((row) => matchesHelpQuery(query(), row)),
      }))
      .filter((section) => section.rows.length > 0),
  )

  const overviewRows = createMemo(
    () =>
      [
        {
          label: "Command palette",
          meta: keybind.print("command_list"),
          description: "Browse every available action in the current context.",
          search: helpSearchTerms(keybind.print("command_list")),
        },
        {
          label: "Agent switch",
          meta: keybind.print("agent_cycle"),
          description: "Move between agents without leaving the prompt.",
          search: helpSearchTerms(keybind.print("agent_cycle")),
        },
        {
          label: "Model switch",
          meta: keybind.print("model_list"),
          description: "Pick a model, provider, or variant for the active agent.",
          search: helpSearchTerms(keybind.print("model_list")),
        },
        {
          label: "Sidebar toggle",
          meta: keybind.print("sidebar_toggle"),
          description: "Show or hide the session sidebar.",
          search: helpSearchTerms(keybind.print("sidebar_toggle")),
        },
        {
          label: "Interrupt run",
          meta: keybind.print("session_interrupt"),
          description: "Stop the current generation or tool run.",
          search: helpSearchTerms(keybind.print("session_interrupt")),
        },
      ].filter((row) => matchesHelpQuery(query(), row)) satisfies HelpRow[],
  )

  const hasResults = createMemo(
    () =>
      overviewRows().length > 0 ||
      commandSections().some((section) => section.rows.length > 0) ||
      keybindSections().some((section) => section.rows.length > 0),
  )

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      if (query()) {
        setQuery("")
        scroll?.scrollTo(0)
        return
      }
      dialog.clear()
      return
    }
    if (evt.name === "backspace") {
      evt.preventDefault()
      evt.stopPropagation()
      if (!query()) return
      setQuery((value) => value.slice(0, -1))
      scroll?.scrollTo(0)
      return
    }
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
      return
    }
    if (evt.ctrl || evt.meta || evt.super) return
    const next = typedChar(evt.name)
    if (!next) return
    evt.preventDefault()
    evt.stopPropagation()
    setQuery((value) => value + next)
    scroll.scrollTo(0)
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
      <box
        paddingLeft={1}
        paddingRight={2}
        backgroundColor={theme.backgroundPanel}
        borderColor={theme.border}
        border={["bottom"]}
      >
        <box flexDirection="row" justifyContent="space-between" gap={2}>
          <text>
            <span style={{ fg: theme.textMuted }}>Search </span>
            <span style={{ fg: query() ? theme.text : theme.textMuted }}>
              <b>{query() || "type to filter by name, description, slash, alias, or keybind"}</b>
            </span>
          </text>
        </box>
      </box>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => (scroll = value)}
        height={Math.max(16, Math.min(dimensions().height - 16, 30))}
        scrollAcceleration={getScrollAcceleration()}
        paddingRight={1}
      >
        <Show
          when={hasResults()}
          fallback={
            <box paddingTop={1}>
              <text fg={theme.textMuted}>No results for “{query()}”</text>
            </box>
          }
        >
          <box flexDirection="column" gap={1} paddingBottom={1}>
            <Show when={overviewRows().length > 0}>
              <Section title="Overview" rows={overviewRows()} />
            </Show>
            <For each={commandSections()}>{(section) => <Section title={section.title} rows={section.rows} />}</For>
            <For each={keybindSections()}>{(section) => <Section title={section.title} rows={section.rows} />}</For>
          </box>
        </Show>
      </scrollbox>
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={theme.textMuted}>↑/↓ scroll · pgup/pgdn page · home/end jump</text>
        <text fg={theme.textMuted}>{query() ? `${query().length} chars` : ""}</text>
      </box>
    </box>
  )
}
