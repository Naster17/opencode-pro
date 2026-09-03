import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSidebarShellThreadItem,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, For } from "solid-js"
import { useKeyboard } from "@opentui/solid"

const id = "internal:sidebar-shell-threads"

type ThreadDetail = {
  threadID: string
  status: "running" | "exited" | "stopped" | "failed"
  description: string
  command: string
  cwd: string
  pid: number
  startedAt: number
  updatedAt: number
  exitCode?: number | null
  error?: string
  cursor: number
  bytes: number
  outputTail: string
}

type ThemeColor = TuiThemeCurrent["text"]

function statusColor(api: TuiPluginApi, status: TuiSidebarShellThreadItem["status"]) {
  const theme = api.theme.current
  if (status === "running") return theme.warning
  if (status === "failed") return theme.error
  if (status === "stopped") return theme.textMuted
  return theme.success
}

function badge(status: TuiSidebarShellThreadItem["status"]) {
  if (status === "running") return "[~]"
  if (status === "failed") return "[!]"
  if (status === "stopped") return "[x]"
  return "[✓]"
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${s}s`
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Detail(props: { api: TuiPluginApi; session_id: string; thread_id: string }) {
  const api = props.api
  const theme = () => api.theme.current
  const [detail, setDetail] = createSignal<ThreadDetail>()
  const [tick, setTick] = createSignal(0)
  const [confirmStop, setConfirmStop] = createSignal(false)

  let stopTimer: ReturnType<typeof setTimeout> | undefined

  const refresh = async () => {
    const result = await api.client.session.shellThreadList({ sessionID: props.session_id }).catch(() => undefined)
    const found = result?.data?.find((thread) => thread.threadID === props.thread_id)
    if (found) setDetail(found as ThreadDetail)
  }

  const stop = async (signal?: "SIGTERM" | "SIGKILL") => {
    const result = await api.client.session
      .shellThreadStop({ sessionID: props.session_id, threadID: props.thread_id, signal })
      .then((r) => r.data)
      .catch(() => undefined)
    if (!result) {
      api.ui.toast({ variant: "error", message: `Failed to stop thread ${props.thread_id}` })
      return
    }
    setDetail(result as ThreadDetail)
    setConfirmStop(false)
    api.ui.toast({
      variant: result.status === "stopped" ? "success" : "warning",
      message: `Thread ${result.description}: ${result.status}`,
    })
  }

  onMount(() => {
    void refresh()
    createEffect(() => {
      if (detail()?.status !== "running") return
      const interval = setInterval(() => {
        void refresh()
        setTick((value) => value + 1)
      }, 1500)
      onCleanup(() => clearInterval(interval))
    })
    const unsub = api.event.on("shell_thread.updated", () => void refresh())
    onCleanup(() => unsub())
    onCleanup(() => {
      if (stopTimer) clearTimeout(stopTimer)
    })
  })

  const runtime = () => {
    tick()
    const info = detail()
    if (!info) return ""
    return formatDuration((info.status === "running" ? Date.now() : info.updatedAt) - info.startedAt)
  }

  const output = createMemo(() => {
    const text = detail()?.outputTail ?? ""
    const lines = text.trimEnd().split("\n")
    return lines.slice(-30).join("\n")
  })

  useKeyboard((evt) => {
    if (evt.name === "s" && detail()?.status === "running") {
      evt.preventDefault()
      if (!confirmStop()) {
        setConfirmStop(true)
        stopTimer = setTimeout(() => setConfirmStop(false), 4000)
        return
      }
      if (stopTimer) clearTimeout(stopTimer)
      void stop("SIGTERM")
    }
  })

  const Row = (row: { label: string; value?: string; color?: ThemeColor }) => (
    <box flexDirection="row" gap={1}>
      <text flexShrink={0} fg={theme().textMuted}>
        {row.label.padEnd(10)}
      </text>
      <text fg={row.color ?? theme().text} wrapMode="none" overflow="hidden">
        {row.value ?? ""}
      </text>
    </box>
  )

  return (
    <api.ui.Dialog size="large" onClose={() => {}}>
      <box paddingLeft={2} paddingRight={2} gap={1}>
        <box flexDirection="row" gap={1}>
          <Show when={detail()}>
            {(info) => (
              <>
                <text flexShrink={0} fg={statusColor(api, info().status)}>
                  {badge(info().status)}
                </text>
                <text fg={theme().text} attributes={TextAttributes.BOLD} wrapMode="none" overflow="hidden">
                  {info().description || "(no description)"}
                </text>
              </>
            )}
          </Show>
        </box>

        <Show when={detail()} fallback={<text fg={theme().textMuted}>Loading…</text>}>
          {(info) => (
            <>
              <Row label="id" value={info().threadID} />
              <Row label="status" value={`${info().status}${info().exitCode != null ? ` (exit=${info().exitCode})` : ""}`} color={statusColor(api, info().status)} />
              <Row label="pid" value={String(info().pid)} />
              <Row label="runtime" value={runtime()} />
              <Row label="started" value={new Date(info().startedAt).toLocaleString()} />
              <Row label="output" value={`${formatBytes(info().bytes)} · ${info().cursor} chunks`} />
              <Row label="cwd" value={info().cwd} />
              <Show when={info().error}>
                <Row label="error" value={info().error} color={theme().error} />
              </Show>

              <box marginTop={1}>
                <text fg={theme().textMuted}>command</text>
                <box
                  backgroundColor={theme().backgroundPanel}
                  paddingLeft={1}
                  paddingRight={1}
                  paddingTop={0}
                >
                  <text fg={theme().text} wrapMode="none" overflow="hidden">
                    $ {info().command}
                  </text>
                </box>
              </box>

              <box marginTop={1}>
                <text fg={theme().textMuted}>output{info().status === "running" ? " (live)" : ""}</text>
                <box
                  backgroundColor={theme().backgroundPanel}
                  paddingLeft={1}
                  paddingRight={1}
                  paddingTop={0}
                  paddingBottom={0}
                >
                  <text fg={theme().text} wrapMode="none">
                    {output()}
                  </text>
                </box>
              </box>

              <Show when={info().status === "running"}>
                <box flexDirection="row" gap={2} marginTop={1}>
                  <box
                    onMouseDown={() => {
                      if (!confirmStop()) {
                        setConfirmStop(true)
                        if (stopTimer) clearTimeout(stopTimer)
                        stopTimer = setTimeout(() => setConfirmStop(false), 4000)
                        return
                      }
                      if (stopTimer) clearTimeout(stopTimer)
                      void stop("SIGTERM")
                    }}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={confirmStop() ? theme().error : undefined}
                  >
                    <text fg={confirmStop() ? theme().backgroundPanel : theme().error}>
                      {confirmStop() ? "confirm stop?" : "stop"}
                    </text>
                  </box>
                  <text fg={theme().textMuted}>press s or click twice to stop</text>
                </box>
              </Show>
            </>
          )}
        </Show>
      </box>
    </api.ui.Dialog>
  )
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.shellThread(props.session_id))

  const openDetail = (threadID: string) => {
    props.api.ui.dialog.setSize("large")
    props.api.ui.dialog.replace(() => (
      <Detail api={props.api} session_id={props.session_id} thread_id={threadID} />
    ))
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
              const state = () => ({
                text: badge(item.status),
                color: statusColor(props.api, item.status),
              })
              return (
                <box flexDirection="row" gap={1} onMouseDown={() => openDetail(item.threadID)}>
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
