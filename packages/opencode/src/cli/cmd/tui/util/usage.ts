import type { AssistantMessage, Message, Part, Provider } from "@opencode-ai/sdk/v2"

export const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

export function formatCompactTokens(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return value.toString()
}

export function formatAlignedRow(left: string, right: string, width: number) {
  return `${left.padEnd(width, " ")} ${right}`
}

export function formatTokensPerSecond(value: number) {
  if (value >= 100) return `${value.toFixed(1)} t/s`
  if (value >= 10) return `${value.toFixed(2)} t/s`
  return `${value.toFixed(3)} t/s`
}

export function summarizeUsage(
  sessions: {
    messages: readonly Message[]
    getParts: (messageID: string) => readonly Part[]
  }[],
  providers: readonly Provider[],
) {
  const totals = sessions.reduce(
    (sum, session) => {
      const parts = session.messages.flatMap((message) =>
        session.getParts(message.id).map((part) => ({
          message,
          part,
        })),
      )
      const assistants = session.messages.filter((item): item is AssistantMessage => item.role === "assistant")
      const generation = assistants
        .filter((item) => item.tokens.output > 0 && !!item.time.completed)
        .reduce(
          (state, item) => {
            const completedAt = item.time.completed
            if (!completedAt) return state
            const startedAt = session
              .getParts(item.id)
              .flatMap((part) => {
                if (part.type === "text" && part.time?.start) return [part.time.start]
                if (part.type === "reasoning" && part.time?.start) return [part.time.start]
                return []
              })
              .sort((a, b) => a - b)[0]
            if (!startedAt) return state
            const duration = completedAt - startedAt
            if (duration <= 0) return state
            return {
              output: state.output + item.tokens.output,
              duration: state.duration + duration,
            }
          },
          { output: 0, duration: 0 },
        )
      const last = assistants.findLast((item) => item.tokens.output > 0)
      const context_tokens = last
        ? last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
        : 0
      const context_percent =
        last && context_tokens > 0
          ? (() => {
              const limit = providers.find((item) => item.id === last.providerID)?.models[last.modelID]?.limit.context
              if (!limit) return null
              return Math.round((context_tokens / limit) * 100)
            })()
          : null

      return {
        input: sum.input + assistants.reduce((acc, item) => acc + item.tokens.input, 0),
        output: sum.output + assistants.reduce((acc, item) => acc + item.tokens.output, 0),
        reasoning: sum.reasoning + assistants.reduce((acc, item) => acc + item.tokens.reasoning, 0),
        cache_read: sum.cache_read + assistants.reduce((acc, item) => acc + item.tokens.cache.read, 0),
        cache_write: sum.cache_write + assistants.reduce((acc, item) => acc + item.tokens.cache.write, 0),
        cost: sum.cost + assistants.reduce((acc, item) => acc + item.cost, 0),
        tools: sum.tools + parts.filter(({ part }) => part.type === "tool").length,
        compact: sum.compact + parts.filter(({ part }) => part.type === "compaction").length,
        generation_output: sum.generation_output + generation.output,
        generation_duration: sum.generation_duration + generation.duration,
        context_tokens: sum.context_tokens + context_tokens,
        context_percent_total: sum.context_percent_total + (context_percent ?? 0),
        context_percent_count: sum.context_percent_count + (context_percent === null ? 0 : 1),
      }
    },
    {
      input: 0,
      output: 0,
      reasoning: 0,
      cache_read: 0,
      cache_write: 0,
      cost: 0,
      tools: 0,
      compact: 0,
      generation_output: 0,
      generation_duration: 0,
      context_tokens: 0,
      context_percent_total: 0,
      context_percent_count: 0,
    },
  )
  const tokens = totals.input + totals.output + totals.reasoning + totals.cache_read + totals.cache_write
  const average_context_percent = totals.context_percent_count
    ? Math.round(totals.context_percent_total / totals.context_percent_count)
    : null

  return {
    tokens,
    cost: totals.cost,
    tools: totals.tools,
    compact: totals.compact,
    input: totals.input,
    output: totals.output,
    reasoning: totals.reasoning,
    cache_read: totals.cache_read,
    cache_write: totals.cache_write,
    cached: totals.cache_read + totals.cache_write,
    context_tokens: totals.context_tokens,
    average_context_percent,
    avg_tokens_per_second:
      totals.generation_output > 0 && totals.generation_duration > 0
        ? formatTokensPerSecond(totals.generation_output / (totals.generation_duration / 1000))
        : "0 t/s",
  }
}
