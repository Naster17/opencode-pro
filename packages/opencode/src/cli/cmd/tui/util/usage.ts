import type { AssistantMessage, Message, Part, Provider, Session } from "@opencode-ai/sdk/v2"

const ACTIVE_EVENT_SPAN_MS = 30 * 1000
const ACTIVE_IDLE_GAP_MS = 5 * 60 * 1000

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

export function formatUsageDuration(value: number) {
  const minutes = Math.round(value / 60000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    const remain = minutes % 60
    if (remain === 0) return `${hours}h`
    return `${hours}h ${remain}m`
  }
  const days = Math.round(hours / 24)
  const remain = hours % 24
  if (remain === 0) return `${days}d`
  return `${days}d ${remain}h`
}

function clampDuration(start: number, end: number, rangeStart?: number) {
  const from = rangeStart ? Math.max(start, rangeStart) : start
  const to = Math.max(from, end)
  return to - from
}

function mergeActivityWindows(
  windows: {
    start: number
    end: number
  }[],
) {
  const sorted = windows.filter((item) => item.end >= item.start).toSorted((a, b) => a.start - b.start || a.end - b.end)
  if (sorted.length === 0) return []

  return sorted.slice(1).reduce(
    (acc, item) => {
      const last = acc[acc.length - 1]
      if (item.start <= last.end + ACTIVE_IDLE_GAP_MS) {
        last.end = Math.max(last.end, item.end)
        return acc
      }
      acc.push({ ...item })
      return acc
    },
    [{ ...sorted[0] }],
  )
}

function activityDuration(
  messages: readonly Message[],
  getParts: (messageID: string) => readonly Part[],
  rangeStart?: number,
) {
  const windows = messages.flatMap((message) => {
    const base =
      message.role === "assistant"
        ? [{ start: message.time.created, end: message.time.completed ?? message.time.created + ACTIVE_EVENT_SPAN_MS }]
        : [{ start: message.time.created, end: message.time.created + ACTIVE_EVENT_SPAN_MS }]
    const parts = getParts(message.id).flatMap((part) => {
      if (part.type === "text" && part.time?.start)
        return [{ start: part.time.start, end: part.time.end ?? part.time.start + ACTIVE_EVENT_SPAN_MS }]
      if (part.type === "reasoning" && part.time?.start)
        return [{ start: part.time.start, end: part.time.end ?? part.time.start + ACTIVE_EVENT_SPAN_MS }]
      if (part.type === "tool" && "time" in part.state)
        return [
          {
            start: part.state.time.start,
            end: "end" in part.state.time ? part.state.time.end : part.state.time.start + ACTIVE_EVENT_SPAN_MS,
          },
        ]
      if (part.type === "retry") return [{ start: part.time.created, end: part.time.created + ACTIVE_EVENT_SPAN_MS }]
      return []
    })
    return [...base, ...parts]
  })

  return mergeActivityWindows(windows).reduce((sum, item) => sum + clampDuration(item.start, item.end, rangeStart), 0)
}

function modelLabel(providers: readonly Provider[], providerID: string, modelID: string) {
  return providers.find((item) => item.id === providerID)?.models[modelID]?.name ?? modelID
}

export function summarizeUsage(
  sessions: {
    session?: Session
    messages: readonly Message[]
    getParts: (messageID: string) => readonly Part[]
    additions?: number
    deletions?: number
  }[],
  providers: readonly Provider[],
  options: {
    start?: number
  } = {},
) {
  const totals = sessions.reduce(
    (sum, session) => {
      const active = session.session ? (options.start ? session.session.time.updated >= options.start : true) : true
      const messages = options.start
        ? session.messages.filter((item) => item.time.created >= options.start!)
        : session.messages
      const parts = messages.flatMap((message) =>
        session.getParts(message.id).map((part) => ({
          message,
          part,
        })),
      )
      const assistants = messages.filter((item): item is AssistantMessage => item.role === "assistant")
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
      const cost = assistants.reduce((acc, item) => acc + (item.cost ?? 0), 0)
      const session_tokens = assistants.reduce(
        (acc, item) =>
          acc +
          item.tokens.input +
          item.tokens.output +
          item.tokens.reasoning +
          item.tokens.cache.read +
          item.tokens.cache.write,
        0,
      )
      const last = assistants.findLast((item) => item.tokens.output > 0)
      const context_tokens = last
        ? last.tokens.input +
          last.tokens.output +
          last.tokens.reasoning +
          last.tokens.cache.read +
          last.tokens.cache.write
        : 0
      const context_percent =
        last && context_tokens > 0
          ? (() => {
              const limit = providers.find((item) => item.id === last.providerID)?.models[last.modelID]?.limit.context
              if (!limit) return null
              return Math.round((context_tokens / limit) * 100)
            })()
          : null
      const model_usage = assistants.reduce(
        (acc, item) => {
          const key = `${item.providerID}:${item.modelID}`
          const tokens =
            item.tokens.input +
            item.tokens.output +
            item.tokens.reasoning +
            item.tokens.cache.read +
            item.tokens.cache.write
          const prev = acc.get(key) ?? {
            providerID: item.providerID,
            modelID: item.modelID,
            name: modelLabel(providers, item.providerID, item.modelID),
            count: 0,
            tokens: 0,
            cost: 0,
          }
          acc.set(key, {
            ...prev,
            count: prev.count + 1,
            tokens: prev.tokens + tokens,
            cost: prev.cost + (item.cost ?? 0),
          })
          return acc
        },
        new Map<
          string,
          {
            providerID: string
            modelID: string
            name: string
            count: number
            tokens: number
            cost: number
          }
        >(),
      )

      return {
        input: sum.input + assistants.reduce((acc, item) => acc + item.tokens.input, 0),
        output: sum.output + assistants.reduce((acc, item) => acc + item.tokens.output, 0),
        reasoning: sum.reasoning + assistants.reduce((acc, item) => acc + item.tokens.reasoning, 0),
        cache_read: sum.cache_read + assistants.reduce((acc, item) => acc + item.tokens.cache.read, 0),
        cache_write: sum.cache_write + assistants.reduce((acc, item) => acc + item.tokens.cache.write, 0),
        cost: sum.cost + cost,
        tools: sum.tools + parts.filter(({ part }) => part.type === "tool").length,
        compact: sum.compact + parts.filter(({ part }) => part.type === "compaction").length,
        generation_output: sum.generation_output + generation.output,
        generation_duration: sum.generation_duration + generation.duration,
        context_tokens: sum.context_tokens + context_tokens,
        context_percent_total: sum.context_percent_total + (context_percent ?? 0),
        context_percent_count: sum.context_percent_count + (context_percent === null ? 0 : 1),
        sessions: sum.sessions + (active ? 1 : 0),
        additions: sum.additions + (active ? (session.additions ?? session.session?.summary?.additions ?? 0) : 0),
        deletions: sum.deletions + (active ? (session.deletions ?? session.session?.summary?.deletions ?? 0) : 0),
        duration: sum.duration + activityDuration(messages, session.getParts, options.start),
        model_usage: [...sum.model_usage, ...model_usage.values()],
        session_usage: active
          ? [
              ...sum.session_usage,
              {
                id: session.session?.id ?? "current",
                title: session.session?.title ?? "Current session",
                updated: session.session?.time.updated ?? 0,
                cost,
                tokens: session_tokens,
              },
            ]
          : sum.session_usage,
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
      sessions: 0,
      additions: 0,
      deletions: 0,
      duration: 0,
      model_usage: [] as {
        providerID: string
        modelID: string
        name: string
        count: number
        tokens: number
        cost: number
      }[],
      session_usage: [] as {
        id: string
        title: string
        updated: number
        cost: number
        tokens: number
      }[],
    },
  )
  const tokens = totals.input + totals.output + totals.reasoning + totals.cache_read + totals.cache_write
  const average_context_percent = totals.context_percent_count
    ? Math.round(totals.context_percent_total / totals.context_percent_count)
    : null
  const model_usage = [...totals.model_usage]
    .reduce(
      (acc, item) => {
        const prev = acc.get(`${item.providerID}:${item.modelID}`)
        if (!prev) {
          acc.set(`${item.providerID}:${item.modelID}`, item)
          return acc
        }
        acc.set(`${item.providerID}:${item.modelID}`, {
          ...prev,
          count: prev.count + item.count,
          tokens: prev.tokens + item.tokens,
          cost: prev.cost + item.cost,
        })
        return acc
      },
      new Map<
        string,
        {
          providerID: string
          modelID: string
          name: string
          count: number
          tokens: number
          cost: number
        }
      >(),
    )
    .values()
    .toArray()
    .toSorted((a, b) => b.count - a.count || b.tokens - a.tokens || b.cost - a.cost)
  const session_usage = totals.session_usage.toSorted(
    (a, b) => b.cost - a.cost || b.tokens - a.tokens || b.updated - a.updated,
  )

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
    sessions: totals.sessions,
    avg_spent_per_session: totals.sessions ? totals.cost / totals.sessions : 0,
    duration: totals.duration,
    additions: totals.additions,
    deletions: totals.deletions,
    popular_models: model_usage.slice(0, 3),
    model_usage,
    session_usage,
    avg_tokens_per_second:
      totals.generation_output > 0 && totals.generation_duration > 0
        ? formatTokensPerSecond(totals.generation_output / (totals.generation_duration / 1000))
        : "0 t/s",
  }
}
