import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"
import { formatAlignedRow, formatCompactTokens, money, summarizeUsage } from "@tui/util/usage"

const id = "internal:sidebar-context"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const usage = createMemo(() =>
    summarizeUsage(
      [
        {
          messages: msg(),
          getParts: props.api.state.part,
        },
      ],
      props.api.state.provider,
    ),
  )
  const totalStats = createMemo(() => {
    const left = {
      total: `total ${formatCompactTokens(usage().tokens)}`,
      input: usage().input > 0 ? `in ${formatCompactTokens(usage().input)}` : "in 0",
    }
    const width = Math.max(left.total.length, left.input.length) + 1
    return {
      total: left.total,
      cached: usage().cached > 0 ? `cached ${formatCompactTokens(usage().cached)}` : "cached 0",
      input: left.input,
      output: usage().output > 0 ? `out ${formatCompactTokens(usage().output)}` : "out 0",
      width,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Metrics</b>
      </text>
      <text fg={theme().textMuted}>
        {formatCompactTokens(usage().context_tokens)} tokens ({usage().average_context_percent ?? 0}% used)
      </text>
      <text fg={theme().textMuted} wrapMode="none">
        {formatAlignedRow(totalStats().input, totalStats().output, totalStats().width)}
      </text>
      <text fg={theme().textMuted} wrapMode="none">
        {formatAlignedRow(totalStats().total, totalStats().cached, totalStats().width)}
      </text>
      <text fg={theme().textMuted} wrapMode="none">
        {formatAlignedRow(`tools ${usage().tools}`, `compact ${usage().compact}`, totalStats().width)}
      </text>
      <text fg={theme().textMuted}>{`avg ${usage().avg_tokens_per_second}`}</text>
      <text fg={theme().textMuted}>{money.format(usage().cost)} spent</text>
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
