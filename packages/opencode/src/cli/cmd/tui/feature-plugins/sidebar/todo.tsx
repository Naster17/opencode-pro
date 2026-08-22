import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show, createSignal } from "solid-js"
import { TodoItem } from "../../component/todo-item"

const id = "internal:sidebar-todo"
const collapsedTodoLength = 32

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const [expanded, setExpanded] = createSignal<string>()
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const show = createMemo(() => list().length > 0 && list().some((item) => item.status !== "completed"))
  const completed = createMemo(() => list().filter((item) => item.status === "completed").length)
  const key = (index: number, content: string) => `${index}:${content}`
  const toggle = (key: string) => setExpanded((current) => (current === key ? undefined : key))

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
          <text fg={theme().text}>
            <b>
              Todo {completed()}/{list().length}
            </b>
          </text>
          <text fg={theme().textMuted}>{open() ? "▼" : "▶"}</text>
        </box>
        <Show when={open()}>
          <For each={list()}>
            {(item, index) => {
              const itemKey = () => key(index(), item.content)
              return (
                <TodoItem
                  status={item.status}
                  content={item.content}
                  singleLine
                  expanded={expanded() === itemKey()}
                  maxLength={collapsedTodoLength}
                  interactive
                  onClick={() => toggle(itemKey())}
                />
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
    order: 400,
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
