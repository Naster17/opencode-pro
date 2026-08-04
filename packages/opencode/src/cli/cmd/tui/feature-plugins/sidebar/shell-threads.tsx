import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiSidebarShellThreadItem } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"

const id = "internal:sidebar-shell-threads"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.shellThread(props.session_id))
  const badge = (status: TuiSidebarShellThreadItem["status"]) => {
    if (status === "running") return { text: "[~]", color: theme().warning }
    if (status === "failed") return { text: "[!]", color: theme().error }
    if (status === "stopped") return { text: "[x]", color: theme().textMuted }
    return { text: "[✓]", color: theme().success }
  }

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((value) => !value)}>
          <text fg={theme().text}>
            <b>Shell Threads</b>
          </text>
          <text fg={theme().textMuted}>{open() ? "▼" : "▶"}</text>
          <Show when={!open()}>
            <text fg={theme().textMuted}>{list().length} active</text>
          </Show>
        </box>
        <Show when={open()}>
          <For each={list()}>
            {(item) => {
              const state = () => badge(item.status)
              return (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={state().color}>
                    {state().text}
                  </text>
                  <text fg={theme().textMuted} wrapMode="none" overflow="hidden">
                    {item.description}
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 450,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
