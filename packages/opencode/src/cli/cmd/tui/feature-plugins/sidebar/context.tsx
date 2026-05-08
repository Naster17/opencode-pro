import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, Show } from "solid-js"
import type { JSX } from "@opentui/solid"
import { formatAlignedRow, formatCompactTokens, money, summarizeUsage } from "@tui/util/usage"
import { Locale } from "@/util/locale"

const id = "internal:sidebar-metrics"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const allSessions = createMemo(() => props.api.state.session.all())
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

    const aggregated = summarizeUsage(sessions, props.api.state.provider)
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
    const rightLabels = ["out", "cached", "compact", "avg.gen"]
    
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
      out: formatRow("out", Locale.number(usage().output), rightWidth),
      total: formatRow("total", Locale.number(usage().tokens), leftWidth),
      cached: formatRow("cached", Locale.number(usage().cached), rightWidth),
      tools: formatRow("tools", usage().tools.toString(), leftWidth),
      compact: formatRow("compact", usage().compact.toString(), rightWidth),
      spent: formatRow("spent", money.format(usage().cost), leftWidth),
      avg: formatRow("avg.gen", usage().avg_tokens_per_second.replace(" t/s", "t/s"), rightWidth),
      code: (
        <text wrapMode="none">
          <span style={{ fg: theme().textMuted }}>{"code".padEnd(leftWidth, " ")} </span>
          <span style={{ fg: theme().diffAdded }}>+{formatCompactTokens(usage().additions)}</span>
          <span style={{ fg: theme().textMuted }}> </span>
          <span style={{ fg: theme().diffRemoved }}>-{formatCompactTokens(usage().deletions)}</span>
        </text>
      ),
      columnGap: 14, // Space from start of left column to start of right column
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Metrics</b>
      </text>
      {totalStats().ctx}
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
      <Show when={usage().additions > 0 || usage().deletions > 0}>{totalStats().code}</Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
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
