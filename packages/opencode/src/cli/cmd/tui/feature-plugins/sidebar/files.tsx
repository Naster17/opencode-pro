import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Locale } from "@/util/locale"
import type { BoxRenderable, MouseEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createMemo, For, Show, createSignal } from "solid-js"

const id = "internal:sidebar-files"
const collapsedFileLength = 28

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const [expanded, setExpanded] = createSignal<string>()
  const [hover, setHover] = createSignal<string>()
  const renderer = useRenderer()
  let container: BoxRenderable | undefined
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.diff(props.session_id))
  const additionsWidth = createMemo(() => Math.max(2, ...list().map((item) => (item.additions ? `+${item.additions}`.length : 0))))
  const deletionsWidth = createMemo(() => Math.max(2, ...list().map((item) => (item.deletions ? `-${item.deletions}`.length : 0))))
  const toggle = (file: string) => setExpanded((current) => (current === file ? undefined : file))
  const canExpand = (file: string) => file.length > collapsedFileLength
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
            {(item) => {
              const active = () => hover() === item.file
              const isExpanded = () => expanded() === item.file
              const display = () => (canExpand(item.file) ? Locale.truncateMiddle(item.file, collapsedFileLength) : item.file)
              return (
                <box
                  onMouseOver={() => setHover(item.file)}
                  onMouseOut={() => setHover(undefined)}
                  onMouseUp={() => {
                    if (renderer.getSelection()?.getSelectedText()) return
                    if (!canExpand(item.file)) return
                    toggle(item.file)
                  }}
                >
                  <Show
                    when={isExpanded() && canExpand(item.file)}
                    fallback={
                      <box flexDirection="row" gap={1} justifyContent="space-between">
                        <text fg={active() ? theme().text : theme().textMuted} wrapMode="none" flexGrow={1}>
                          {display()}
                        </text>
                        <box flexDirection="row" gap={1} flexShrink={0}>
                          <text fg={theme().diffAdded}>{item.additions ? `+${item.additions}`.padStart(additionsWidth()) : " ".repeat(additionsWidth())}</text>
                          <text fg={theme().diffRemoved}>{item.deletions ? `-${item.deletions}`.padStart(deletionsWidth()) : " ".repeat(deletionsWidth())}</text>
                        </box>
                      </box>
                    }
                  >
                    <text fg={active() ? theme().text : theme().textMuted} wrapMode="word">
                      {item.file}
                      <Show when={item.additions}>
                        <span style={{ fg: theme().diffAdded }}> +{item.additions}</span>
                      </Show>
                      <Show when={item.deletions}>
                        <span style={{ fg: theme().diffRemoved }}> -{item.deletions}</span>
                      </Show>
                    </text>
                  </Show>
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
