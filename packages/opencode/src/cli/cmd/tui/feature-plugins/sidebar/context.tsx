import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import type { JSX } from "@opentui/solid"
import { useSync } from "@tui/context/sync"
import { formatCompactTokens, money, summarizeUsage } from "@tui/util/usage"
import { Locale } from "@/util/locale"
import { isCodexModel } from "@/plugin/codex"
import { formatResetDuration, getCodexUsage } from "./codex-usage"

const id = "internal:sidebar-metrics"
const usageWidgetsHiddenKey = "usage_widgets_hidden"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const sync = useSync()
  const theme = () => props.api.theme.current
  const allSessions = createMemo(() => props.api.state.session.all())
  const [now, setNow] = createSignal(Date.now())
  const [codexUsageVersion, setCodexUsageVersion] = createSignal(0)

  const descendantSessions = createMemo(() => {
    const rootID = props.session_id
    const descendants: string[] = []
    const queue = [rootID]
    const visited = new Set<string>([rootID])

    while (queue.length > 0) {
      const parentID = queue.shift()!
      for (const s of allSessions()) {
        if (s.parentID === parentID && !visited.has(s.id)) {
          visited.add(s.id)
          descendants.push(s.id)
          queue.push(s.id)
        }
      }
    }
    return descendants
  })
  const usageWidgetsVisible = createMemo(() => !props.api.kv.get(usageWidgetsHiddenKey, false))
  const sessionMessages = createMemo(() => [
    ...(sync.data.message[props.session_id] ?? []),
    ...descendantSessions().flatMap((id) => sync.data.message[id] ?? []),
  ])
  const codexSelected = createMemo(() => {
    const model = sync.data.config.model
    if (!model) return false
    const [providerID, ...rest] = model.split("/")
    return isCodexModel(providerID ?? "", rest.join("/"))
  })
  const codexUsed = createMemo(() =>
    sessionMessages().some((message) => {
      if (message.role === "user") return isCodexModel(message.model.providerID, message.model.modelID)
      return isCodexModel(message.providerID, message.modelID)
    }),
  )
  const showCodexUsage = createMemo(() => usageWidgetsVisible() && (codexSelected() || codexUsed()))
  const codexUsageKey = createMemo(() => (showCodexUsage() ? codexUsageVersion() : -1))
  let codexRefreshTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleCodexRefresh = (force = false) => {
    if (!showCodexUsage()) return
    if (codexRefreshTimer) clearTimeout(codexRefreshTimer)
    codexRefreshTimer = setTimeout(() => {
      setCodexUsageVersion((value) => value + (force ? 1000 : 1))
      codexRefreshTimer = undefined
    }, force ? 0 : 150)
  }
  const [codexUsage] = createResource(codexUsageKey, (key) => (key >= 0 ? getCodexUsage(key > 0) : undefined))

  const countdown = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(countdown))
  onCleanup(() => {
    if (codexRefreshTimer) clearTimeout(codexRefreshTimer)
  })

  let wasShowingCodexUsage = false
  createEffect(() => {
    const next = showCodexUsage()
    if (next && !wasShowingCodexUsage) scheduleCodexRefresh(true)
    wasShowingCodexUsage = next
  })

  const trackedSessionIDs = createMemo(() => new Set([props.session_id, ...descendantSessions()]))
  const onTrackedSession = (sessionID: string) => trackedSessionIDs().has(sessionID)
  const offStatus = props.api.event.on("session.status", (event) => {
    if (!onTrackedSession(event.properties.sessionID)) return
    if (event.properties.status.type === "busy") scheduleCodexRefresh(false)
  })
  const offIdle = props.api.event.on("session.idle", (event) => {
    if (!onTrackedSession(event.properties.sessionID)) return
    scheduleCodexRefresh(true)
  })
  const offModel = props.api.event.on("session.next.model.switched", (event) => {
    if (!onTrackedSession(event.properties.sessionID)) return
    scheduleCodexRefresh(true)
  })
  onCleanup(offStatus)
  onCleanup(offIdle)
  onCleanup(offModel)

  createEffect(() => {
    // Ensure all descendant session messages are synced for accurate metrics
    for (const id of descendantSessions()) {
      void props.api.state.session.sync(id)
    }
  })

  const usage = createMemo(() => {
    const rootSession = allSessions().find((s) => s.id === props.session_id)
    const rootMessages = props.api.state.session.messages(props.session_id)
    
    const descendantSessionsList = descendantSessions().map((id) => ({
      session: allSessions().find((s) => s.id === id),
      messages: props.api.state.session.messages(id),
      getParts: props.api.state.part,
      additions: props.api.state.session.diff(id).reduce((sum, item) => sum + item.additions, 0),
      deletions: props.api.state.session.diff(id).reduce((sum, item) => sum + item.deletions, 0),
    }))

    const sessions = [
      {
        session: rootSession,
        messages: rootMessages,
        getParts: props.api.state.part,
        additions: props.api.state.session.diff(props.session_id).reduce((sum, item) => sum + item.additions, 0),
        deletions: props.api.state.session.diff(props.session_id).reduce((sum, item) => sum + item.deletions, 0),
      },
      ...descendantSessionsList,
    ]

    const aggregated = summarizeUsage(sessions, props.api.state.provider, { respectRevert: false })
    const rootOnly = summarizeUsage([{
      session: rootSession,
      messages: rootMessages,
      getParts: props.api.state.part,
    }], props.api.state.provider)

    return {
      ...aggregated,
      context_tokens_formatted: Locale.number(rootOnly.context_tokens),
      average_context_percent: rootOnly.average_context_percent,
    }
  })

  const totalStats = createMemo(() => {
    const leftLabels = ["ctx", "in", "total", "tools", "spent", "code"]
    const rightLabels = ["code", "out", "cached", "compact", "avg.gen"]
    
    const leftWidth = Math.max(...leftLabels.map((l) => l.length))
    const rightWidth = Math.max(...rightLabels.map((l) => l.length))

    const formatRow = (label: string, value: string | JSX.Element, labelWidth: number) => (
      <text wrapMode="none">
        <span style={{ fg: theme().textMuted }}>{label.padEnd(labelWidth, " ")} </span>
        <span style={{ fg: theme().text }}>{value}</span>
      </text>
    )

    return {
      ctx: formatRow("ctx", usage().context_tokens_formatted, leftWidth),
      in: formatRow("in", Locale.number(usage().input), leftWidth),
      out: formatRow("out", Locale.number(usage().output + usage().reasoning), rightWidth),
      total: formatRow("total", Locale.number(usage().tokens), leftWidth),
      cached: formatRow("cached", Locale.number(usage().cached), rightWidth),
      tools: formatRow("tools", usage().tools.toString(), leftWidth),
      compact: formatRow("compact", usage().compact.toString(), rightWidth),
      spent: formatRow("spent", money.format(usage().cost), leftWidth),
      avg: formatRow("avg.gen", usage().avg_tokens_per_second.replace(" t/s", "t/s"), rightWidth),
      code: (
        <text wrapMode="none">
          <span style={{ fg: theme().textMuted }}>{"code".padEnd(rightWidth, " ")} </span>
          <span style={{ fg: theme().diffAdded }}>+{formatCompactTokens(usage().additions)}</span>
          <span style={{ fg: theme().textMuted }}> </span>
          <span style={{ fg: theme().diffRemoved }}>-{formatCompactTokens(usage().deletions)}</span>
        </text>
      ),
      columnGap: 14, // Space from start of left column to start of right column
    }
  })

  const codexStats = createMemo(() => {
    if (!showCodexUsage()) return
    const snapshot = codexUsage()
    if (!snapshot?.configured) return

    const labelWidth = Math.max("Usage".length, "Reset".length, "Account".length)
    const formatRow = (label: string, value: string) => (
      <text wrapMode="none">
        <span style={{ fg: theme().textMuted }}>{label.padEnd(labelWidth, " ")} </span>
        <span style={{ fg: theme().text }}>{value}</span>
      </text>
    )

    return {
      usage: formatRow("Usage", snapshot.usedPercent === undefined ? "unknown" : `${snapshot.usedPercent}%`),
      reset: formatRow(
        "Reset",
        snapshot.resetsAt === undefined ? "unknown" : formatResetDuration(snapshot.resetsAt, now()),
      ),
      account: formatRow("Account", snapshot.email ?? "unknown"),
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Metrics</b>
      </text>
      <box flexDirection="row">
        <box width={totalStats().columnGap}>{totalStats().ctx}</box>
        <Show when={usage().additions > 0 || usage().deletions > 0}>{totalStats().code}</Show>
      </box>
      <box flexDirection="row">
        <box width={totalStats().columnGap}>{totalStats().in}</box>
        {totalStats().out}
      </box>
      <box flexDirection="row">
        <box width={totalStats().columnGap}>{totalStats().total}</box>
        {totalStats().cached}
      </box>
      <box flexDirection="row">
        <box width={totalStats().columnGap}>{totalStats().tools}</box>
        {totalStats().compact}
      </box>
      <box flexDirection="row">
        <box width={totalStats().columnGap}>{totalStats().spent}</box>
        {totalStats().avg}
      </box>
      <Show when={codexStats()}>
        <box marginTop={1}>
          <text fg={theme().text}>
            <b>Codex Usage</b>
          </text>
        </box>
        {codexStats()?.usage}
        {codexStats()?.reset}
        {codexStats()?.account}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: api.kv.get(usageWidgetsHiddenKey, false) ? "Show usage widgets" : "Hide usage widgets",
      value: "usage_widgets.toggle",
      keybind: "usage_widget_toggle",
      category: "System",
      hidden: api.route.current.name !== "session",
      onSelect() {
        api.kv.set(usageWidgetsHiddenKey, !api.kv.get(usageWidgetsHiddenKey, false))
        api.ui.dialog.clear()
      },
    },
  ])

  api.slots.register({
    order: 100,
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
