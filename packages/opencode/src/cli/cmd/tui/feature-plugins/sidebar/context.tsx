import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

function formatCompactTokens(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return value.toString()
}

function formatAlignedRow(left: string, right: string, width: number) {
  return `${left.padEnd(width, " ")} ${right}`
}

function formatTokensPerSecond(value: number) {
  if (value >= 100) return `${value.toFixed(1)} t/s`
  if (value >= 10) return `${value.toFixed(2)} t/s`
  return `${value.toFixed(3)} t/s`
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const parts = createMemo(() =>
    msg().flatMap((item) =>
      props.api.state.part(item.id).map((part) => ({
        message: item,
        part,
      })),
    ),
  )
  const cost = createMemo(() => msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0))
  const total = createMemo(() =>
    msg()
      .filter((item): item is AssistantMessage => item.role === "assistant")
      .reduce(
        (sum, item) => ({
          input: sum.input + item.tokens.input,
          output: sum.output + item.tokens.output,
          reasoning: sum.reasoning + item.tokens.reasoning,
          cache_read: sum.cache_read + item.tokens.cache.read,
          cache_write: sum.cache_write + item.tokens.cache.write,
        }),
        {
          input: 0,
          output: 0,
          reasoning: 0,
          cache_read: 0,
          cache_write: 0,
        },
      ),
  )
  const extras = createMemo(() => {
    const toolCount = parts().filter(({ part }) => part.type === "tool").length
    const compactionCount = parts().filter(({ part }) => part.type === "compaction").length
    const generation = msg()
      .filter((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0 && !!item.time.completed)
      .reduce(
        (sum, item) => {
          const completedAt = item.time.completed
          if (!completedAt) return sum
          const startedAt = props.api.state
            .part(item.id)
            .flatMap((part) => {
              if (part.type === "text" && part.time?.start) return [part.time.start]
              if (part.type === "reasoning" && part.time?.start) return [part.time.start]
              return []
            })
            .sort((a, b) => a - b)[0]
          if (!startedAt) return sum
          const duration = completedAt - startedAt
          if (duration <= 0) return sum
          return {
            output: sum.output + item.tokens.output,
            duration: sum.duration + duration,
          }
        },
        { output: 0, duration: 0 },
      )

    return {
      tools: `tools ${toolCount}`,
      compact: `compact ${compactionCount}`,
      avg: generation.output > 0 && generation.duration > 0 ? `avg ${formatTokensPerSecond(generation.output / (generation.duration / 1000))}` : "avg 0 t/s",
    }
  })

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })
  const totalStats = createMemo(() => {
    const value = total()
    const tokens = value.input + value.output + value.reasoning + value.cache_read + value.cache_write
    const left = {
      total: `total ${formatCompactTokens(tokens)}`,
      input: value.input > 0 ? `in ${formatCompactTokens(value.input)}` : "in 0",
    }
    const width = Math.max(left.total.length, left.input.length) + 1
    return {
      total: left.total,
      cached:
        value.cache_read + value.cache_write > 0
          ? `cached ${formatCompactTokens(value.cache_read + value.cache_write)}`
          : "cached 0",
      input: left.input,
      output: value.output > 0 ? `out ${formatCompactTokens(value.output)}` : "out 0",
      width,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Metrics</b>
      </text>
      <text fg={theme().textMuted}>
        {formatCompactTokens(state().tokens)} tokens ({state().percent ?? 0}% used)
      </text>
      <text fg={theme().textMuted} wrapMode="none">
        {formatAlignedRow(totalStats().input, totalStats().output, totalStats().width)}
      </text>
      <text fg={theme().textMuted} wrapMode="none">
        {formatAlignedRow(totalStats().total, totalStats().cached, totalStats().width)}
      </text>
      <text fg={theme().textMuted} wrapMode="none">
        {formatAlignedRow(extras().tools, extras().compact, totalStats().width)}
      </text>
      <text fg={theme().textMuted}>{extras().avg}</text>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
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
