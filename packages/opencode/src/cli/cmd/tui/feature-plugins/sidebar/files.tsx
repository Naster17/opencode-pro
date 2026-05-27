import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { BoxRenderable, MouseEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createMemo, For, Show, createSignal } from "solid-js"

const id = "internal:sidebar-files"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const [expanded, setExpanded] = createSignal<string>()
  const [hover, setHover] = createSignal<string>()
  const renderer = useRenderer()
  let container: BoxRenderable | undefined
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.diff(props.session_id))
  const toggle = (file: string) => setExpanded((current) => (current === file ? undefined : file))
  const closeIfOutside = (evt: MouseEvent) => {
    if (container && evt.x >= container.x && evt.x < container.x + container.width && evt.y >= container.y && evt.y < container.y + container.height) return
    setExpanded(undefined)
    setHover(undefined)
  }

  return (
    <Show when={list().length > 0}>
      <box
        ref={(value: BoxRenderable) => (container = value)}
        onMouseOut={closeIfOutside}
      >
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <text fg={theme().text}>
            <b>Modified Files</b>
          </text>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(item) => (
              <box
                flexDirection="row"
                gap={1}
                justifyContent="space-between"
                onMouseOver={() => setHover(item.file)}
                onMouseOut={() => setHover(undefined)}
                onMouseUp={() => {
                  if (renderer.getSelection()?.getSelectedText()) return
                  toggle(item.file)
                }}
              >
                <text
                  fg={hover() === item.file ? theme().text : theme().textMuted}
                  wrapMode={expanded() === item.file ? "word" : "none"}
                  overflow={expanded() === item.file ? undefined : "hidden"}
                  truncate={expanded() === item.file ? undefined : true}
                  flexGrow={1}
                >
                  {item.file}
                </text>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <Show when={item.additions}>
                    <text fg={theme().diffAdded}>+{item.additions}</text>
                  </Show>
                  <Show when={item.deletions}>
                    <text fg={theme().diffRemoved}>-{item.deletions}</text>
                  </Show>
                </box>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
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
