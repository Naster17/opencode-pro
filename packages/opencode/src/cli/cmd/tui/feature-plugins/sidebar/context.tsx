import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import path from "path"
import { createEffect, createMemo, createResource, createSignal, on, onCleanup, Show } from "solid-js"
import type { JSX } from "@opentui/solid"
import { useSync } from "@tui/context/sync"
import { Global } from "@opencode-ai/core/global"
import { billedAvgTokensPerSecond, formatCompactTokens, money, summarizeUsage } from "@tui/util/usage"
import { Locale } from "@/util/locale"
import { isCodexModel } from "@/plugin/codex"
import { clearCodexUsageCache, formatResetDuration, getCodexUsage } from "./codex-usage"
import { BilledUsageTracker } from "./billed-usage"
import { useBtwUsage } from "@tui/context/btw"
import { useLocal } from "@tui/context/local"

const id = "internal:sidebar-metrics"
const usageWidgetsHiddenKey = "usage_widgets_hidden"
const authPaths = [
  path.join(Global.Path.data, "auth.json"),
  path.join(Global.Path.home, ".codex", "auth.json"),
  path.join(Global.Path.home, ".codex", ".cockpit_codex_auth.json"),
]
const codexHotSwapRefreshDelays = [0, 1_000, 3_000, 8_000]

function View(props: { api: TuiPluginApi; session_id: string }) {
  const sync = useSync()
  const btwUsage = useBtwUsage()
  const local = useLocal()
  const theme = () => props.api.theme.current
  const allSessions = createMemo(() => props.api.state.session.all())
  const [now, setNow] = createSignal(Date.now())
  const [codexUsageVersion, setCodexUsageVersion] = createSignal(0)
  const codexHotSwapTimers = new Set<ReturnType<typeof setTimeout>>()

  // Cumulative billed usage (in/out/reasoning/cache/cost/tools/compact) for the
  // session subtree. Computed once per session from a transient full-history
  // fetch (kept out of the sync store to preserve the lazy-window memory win),
  // then maintained incrementally from message/part events so new messages
  // never trigger another full re-fetch.
  const billedTracker = new BilledUsageTracker((sessionID) => sync.session.allMessages(sessionID))

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
    const current = local.model.current()
    if (current && isCodexModel(current.providerID, current.modelID)) return true
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
    codexRefreshTimer = setTimeout(
      () => {
        setCodexUsageVersion((value) => value + (force ? 1000 : 1))
        codexRefreshTimer = undefined
      },
      force ? 0 : 150,
    )
  }
  const [codexUsage] = createResource(codexUsageKey, (key) => (key >= 0 ? getCodexUsage(key > 0) : undefined))

  const triggerCodexHotSwapRefresh = () => {
    if (!showCodexUsage()) return
    clearCodexUsageCache()
    for (const timer of codexHotSwapTimers) clearTimeout(timer)
    codexHotSwapTimers.clear()
    for (const delay of codexHotSwapRefreshDelays) {
      const timer = setTimeout(() => {
        codexHotSwapTimers.delete(timer)
        clearCodexUsageCache()
        scheduleCodexRefresh(true)
      }, delay)
      codexHotSwapTimers.add(timer)
    }
  }

  const countdown = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(countdown))
  onCleanup(() => {
    if (codexRefreshTimer) clearTimeout(codexRefreshTimer)
    for (const timer of codexHotSwapTimers) clearTimeout(timer)
    codexHotSwapTimers.clear()
  })

  let authFingerprint = ""
  const authWatcher = setInterval(async () => {
    if (!showCodexUsage()) return
    const nextFingerprint = (
      await Promise.all(
        authPaths.map((item) =>
          Bun.file(item)
            .stat()
            .catch(() => undefined),
        ),
      )
    )
      .map((stat) => `${stat?.mtimeMs ?? 0}:${stat?.size ?? 0}`)
      .join("|")
    if (!authFingerprint) {
      authFingerprint = nextFingerprint
      return
    }
    if (nextFingerprint === authFingerprint) return
    authFingerprint = nextFingerprint
    triggerCodexHotSwapRefresh()
  }, 2_000)
  onCleanup(() => clearInterval(authWatcher))

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

  // Rebuild the billed snapshot when the viewed session changes.
  createEffect(
    on(
      () => props.session_id,
      () => billedTracker.reset(),
    ),
  )

  // Track the current session plus all subagent descendants, fetching each
  // session's full history once (newly spawned descendants are picked up as
  // they appear).
  createEffect(() => {
    const ids = trackedSessionIDs()
    billedTracker.setTracked(ids)
    for (const id of ids) void billedTracker.ensureBaseline(id)
  })

  // Keep the billed totals fresh from message/part events. Each event only
  // mutates small per-message accounting units; no full-history re-fetch.
  const offBilledUpdated = props.api.event.on("message.updated", (event) => billedTracker.onEvent(event))
  const offBilledRemoved = props.api.event.on("message.removed", (event) => billedTracker.onEvent(event))
  const offBilledPartUpdated = props.api.event.on("message.part.updated", (event) => billedTracker.onEvent(event))
  const offBilledPartDelta = props.api.event.on("message.part.delta", (event) => billedTracker.onEvent(event))
  const offBilledPartRemoved = props.api.event.on("message.part.removed", (event) => billedTracker.onEvent(event))
  onCleanup(offBilledUpdated)
  onCleanup(offBilledRemoved)
  onCleanup(offBilledPartUpdated)
  onCleanup(offBilledPartDelta)
  onCleanup(offBilledPartRemoved)
  onCleanup(() => billedTracker.dispose())

  createEffect(() => {
    // Ensure all descendant session messages are synced for metrics. Use the
    // windowed sync (not the plugin API's full-history sync) so the sidebar
    // never forces an entire huge session into memory; metrics are computed
    // from the loaded tail which the session route already fetched.
    for (const id of descendantSessions()) {
      void sync.session.sync(id)
    }
  })

  const usage = createMemo(() => {
    const rootSession = allSessions().find((s) => s.id === props.session_id)
    const rootMessages = props.api.state.session.messages(props.session_id)
    const ids = [props.session_id, ...descendantSessions()]
    const additions = ids.reduce(
      (sum, id) => sum + props.api.state.session.diff(id).reduce((total, item) => total + item.additions, 0),
      0,
    )
    const deletions = ids.reduce(
      (sum, id) => sum + props.api.state.session.diff(id).reduce((total, item) => total + item.deletions, 0),
      0,
    )

    // Cumulative billed usage from the one-time full-history snapshot plus
    // incremental message/part events. The live context figure below comes from
    // the windowed store, which is accurate for the most recent assistant.
    const billed = billedTracker.totals
    const context = summarizeUsage(
      [
        {
          session: rootSession,
          messages: rootMessages,
          getParts: props.api.state.part,
        },
      ],
      props.api.state.provider,
    )
    const btw = btwUsage.sum(trackedSessionIDs())

    const billedTokens = billed.input + billed.output + billed.reasoning + billed.cache_read + billed.cache_write
    const btwTokens = btw.input + btw.output + btw.reasoning + btw.cache_read + btw.cache_write

    return {
      input: billed.input + btw.input,
      output: billed.output + btw.output,
      reasoning: billed.reasoning + btw.reasoning,
      cache_read: billed.cache_read + btw.cache_read,
      cache_write: billed.cache_write + btw.cache_write,
      cached: billed.cache_read + billed.cache_write + btw.cache_read + btw.cache_write,
      tokens: billedTokens + btwTokens,
      cost: billed.cost + btw.cost,
      tools: billed.tools + btw.tools,
      compact: billed.compact,
      avg_tokens_per_second: billedAvgTokensPerSecond(billed),
      additions,
      deletions,
      context_tokens_formatted: Locale.number(context.context_tokens),
      average_context_percent: context.average_context_percent,
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
      spent: formatRow("spent", money(usage().cost), leftWidth),
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
