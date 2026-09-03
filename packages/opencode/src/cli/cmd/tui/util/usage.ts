import type { AssistantMessage, Message, Part, Provider, Session } from "@opencode-ai/sdk/v2"

const ACTIVE_EVENT_SPAN_MS = 30 * 1000
const ACTIVE_IDLE_GAP_MS = 5 * 60 * 1000
const CHARS_PER_TOKEN = 4

const moneyFormatters = [0, 1, 2, 3, 4].map(
  (digits) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
)

export function money(value: number) {
  const integerDigits = Math.floor(Math.abs(value)).toString().length
  return moneyFormatters[Math.max(0, 5 - integerDigits)].format(value)
}

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

function estimateTokensLength(chars: number) {
  return Math.max(0, Math.round(chars / CHARS_PER_TOKEN))
}

// Placeholder the server substitutes for pruned tool outputs on the wire;
// counting it instead of the full output keeps the estimate in sync.
const PRUNED_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]"

// Estimates the token count of the visible context. Sums string lengths
// directly instead of JSON.stringify-ing the whole history: with huge sessions
// (hundreds of MB of tool output) building a giant serialized snapshot per call
// caused multi-second GC pauses. String .length is O(1), so this is O(parts).
function estimateCurrentContextTokens(messages: readonly Message[], getParts: (messageID: string) => readonly Part[]) {
  // Pruned outputs ship as a placeholder, not in full. Markers record the
  // compressed part IDs (stable mode); legacy mode flags the parts directly.
  // Only markers in the visible (revert-filtered) list apply, matching how
  // revert clears server-side marks for hidden markers.
  const compacted = new Set<string>()
  for (const message of messages) {
    for (const part of getParts(message.id)) {
      if (part.type === "prune") {
        for (const id of part.partIDs) compacted.add(id)
      }
    }
  }
  let chars = 0
  for (const message of messages) {
    chars += message.role.length + (message.agent?.length ?? 0) + 64
    if (message.role === "user") {
      chars += (message.system?.length ?? 0) + (message.model.providerID.length + message.model.modelID.length + 1)
    } else {
      chars += message.providerID.length + message.modelID.length + 1
    }
    for (const part of getParts(message.id)) {
      if (part.type === "text") {
        if (!part.ignored) chars += part.text.length
      } else if (part.type === "reasoning") {
        chars += part.text.length
      } else if (part.type === "subtask") {
        chars += part.agent.length + part.description.length + part.prompt.length
      } else if (part.type === "file") {
        chars += part.source?.text.value.length ?? `[Attached ${part.mime}: ${part.filename ?? "file"}]`.length
      } else if (part.type === "tool") {
        const cleared =
          compacted.has(part.id) ||
          (part.state.status === "completed" && part.state.time.compacted != null)
        const output = cleared
          ? PRUNED_OUTPUT_PLACEHOLDER
          : part.state.status === "completed"
            ? part.state.output
            : part.state.status === "error"
              ? part.state.error
              : ""
        chars += part.tool.length + (part.state.input ? JSON.stringify(part.state.input).length : 0) + output.length
      }
    }
  }
  return estimateTokensLength(chars)
}

function zeroTokens(): AssistantMessage["tokens"] {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addTokens(left: AssistantMessage["tokens"], right: AssistantMessage["tokens"]): AssistantMessage["tokens"] {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cache: {
      read: left.cache.read + right.cache.read,
      write: left.cache.write + right.cache.write,
    },
  }
}

function hasTokens(tokens: AssistantMessage["tokens"]) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write > 0
}

function assistantUsage(message: AssistantMessage, getParts: (messageID: string) => readonly Part[]) {
  const finishes = getParts(message.id).filter((part): part is Extract<Part, { type: "step-finish" }> =>
    part.type === "step-finish",
  )
  if (finishes.length === 0) return { tokens: message.tokens, cost: message.cost ?? 0 }
  return {
    tokens: finishes.reduce((sum, part) => addTokens(sum, part.tokens), zeroTokens()),
    cost: finishes.reduce((sum, part) => sum + part.cost, 0),
  }
}

function filterCompactedMessages(messages: readonly Message[], getParts: (messageID: string) => readonly Part[]) {
  const completed = new Set(
    messages.flatMap((message) => {
      if (message.role !== "assistant") return []
      if (message.summary !== true || !message.finish || message.error) return []
      return [message.parentID]
    }),
  )
  const latest = messages.findLastIndex((message) => {
    if (message.role !== "user") return false
    if (!completed.has(message.id)) return false
    return getParts(message.id).some((part) => part.type === "compaction")
  })
  const latestTruncate = messages.findLastIndex((message) => {
    if (message.role !== "user") return false
    return getParts(message.id).some((part) => part.type === "compaction" && part.truncated === true)
  })
  const truncateSlice = (() => {
    if (latestTruncate < 0) return undefined
    const marker = getParts(messages[latestTruncate]!.id).find((part) => part.type === "compaction")
    if (marker?.type !== "compaction" || !marker.tail_start_id) return messages.slice(latestTruncate)
    const tailIndex = messages.findIndex((message) => message.id >= marker.tail_start_id!)
    if (tailIndex < 0 || tailIndex > latestTruncate) return messages.slice(latestTruncate)
    return messages.slice(tailIndex)
  })()
  if (latest < 0) return truncateSlice ?? messages
  if (!truncateSlice) return messages.slice(latest)
  return latestTruncate > latest ? truncateSlice : messages.slice(latest)
}

function currentContextUsage(
  session: Session | undefined,
  messages: readonly Message[],
  getParts: (messageID: string) => readonly Part[],
  providers: readonly Provider[],
) {
  const visibleMessages = filterCompactedMessages(messages, getParts)
  const lastAssistantIndex = visibleMessages.findLastIndex(
    (item): item is AssistantMessage => item.role === "assistant" && hasTokens(assistantUsage(item, getParts).tokens),
  )
  const lastAssistant = lastAssistantIndex >= 0 ? (visibleMessages[lastAssistantIndex] as AssistantMessage) : undefined
  const latestAssistant = visibleMessages.findLast((item): item is AssistantMessage => item.role === "assistant")
  const latestUser = visibleMessages.findLast((item): item is Extract<Message, { role: "user" }> => item.role === "user")
  const lastUsage = lastAssistant ? assistantUsage(lastAssistant, getParts).tokens : undefined
  const exactTokens = lastUsage ? lastUsage.input + lastUsage.cache.read + lastUsage.cache.write : 0
  const liveAssistant = latestAssistant && !latestAssistant.time.completed ? latestAssistant : undefined
  const latestMessageIndex = visibleMessages.length - 1
  const compactedSummary =
    lastAssistant?.summary === true && getParts(lastAssistant.parentID).some((part) => part.type === "compaction")
  const liveTokens = compactedSummary
    ? estimateCurrentContextTokens(visibleMessages, getParts)
    : liveAssistant || (latestMessageIndex >= 0 && latestMessageIndex !== lastAssistantIndex)
      ? exactTokens
      : exactTokens || estimateCurrentContextTokens(visibleMessages, getParts)
  if (liveTokens <= 0) return { tokens: 0, percent: null as number | null }

  const providerID =
    session?.model?.providerID ??
    latestAssistant?.providerID ??
    latestUser?.model.providerID
  const modelID =
    session?.model?.id ??
    latestAssistant?.modelID ??
    latestUser?.model.modelID
  const limit = providerID && modelID ? providers.find((item) => item.id === providerID)?.models[modelID]?.limit.context : undefined
  return {
    tokens: liveTokens,
    percent: limit ? Math.round((liveTokens / limit) * 100) : null,
  }
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
    respectRevert?: boolean
  } = {},
) {
  const totals = sessions.reduce(
    (sum, session) => {
      const active = session.session ? (options.start ? session.session.time.updated >= options.start : true) : true
      let messages = options.start
        ? session.messages.filter((item) => item.time.created >= options.start!)
        : session.messages

      const revertID = options.respectRevert !== false ? session.session?.revert?.messageID : undefined
      if (revertID) {
        messages = messages.filter((m) => m.id < revertID)
      }

      const parts = messages.flatMap((message) =>
        session.getParts(message.id).map((part) => ({
          message,
          part,
        })),
      )
      const assistants = messages.filter((item): item is AssistantMessage => item.role === "assistant")
      const assistantUsages = assistants.map((message) => ({ message, ...assistantUsage(message, session.getParts) }))
      const generation = assistantUsages
        .filter((item) => item.tokens.output > 0 && !!item.message.time.completed)
        .reduce(
          (state, item) => {
            const completedAt = item.message.time.completed
            if (!completedAt) return state
            const startedAt = session
              .getParts(item.message.id)
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
      const cost = assistantUsages.reduce((acc, item) => acc + item.cost, 0)

      const reasoningTokens = assistantUsages.reduce((acc, item) => {
        let tokens = item.tokens.reasoning
        // Fallback for models that don't report reasoning tokens but have reasoning parts
        if (tokens === 0) {
          const reasoningParts = session.getParts(item.message.id).filter((p) => p.type === "reasoning")
          for (const part of reasoningParts) {
            if ("text" in part) {
              tokens += Math.ceil(part.text.length / 4)
            }
          }
        }
        return acc + tokens
      }, 0)

      const session_tokens = assistantUsages.reduce(
        (acc, item) =>
          acc +
          item.tokens.input +
          item.tokens.output +
          item.tokens.reasoning +
          item.tokens.cache.read +
          item.tokens.cache.write,
        0,
      )
      const last = assistantUsages.findLast((item) => hasTokens(item.tokens))
      const context_tokens = last ? last.tokens.input + last.tokens.cache.read + last.tokens.cache.write : 0
      const context_percent =
        last && context_tokens > 0
          ? (() => {
              const limit = providers.find((item) => item.id === last.message.providerID)?.models[last.message.modelID]?.limit.context
              if (!limit) return null
              return Math.round((context_tokens / limit) * 100)
            })()
          : null
      const model_usage = assistantUsages.reduce(
        (acc, item) => {
          const key = `${item.message.providerID}:${item.message.modelID}`
          const tokens =
            item.tokens.input +
            item.tokens.output +
            item.tokens.reasoning +
            item.tokens.cache.read +
            item.tokens.cache.write
          const prev = acc.get(key) ?? {
            providerID: item.message.providerID,
            modelID: item.message.modelID,
            name: modelLabel(providers, item.message.providerID, item.message.modelID),
            count: 0,
            tokens: 0,
            cost: 0,
          }
          acc.set(key, {
            ...prev,
            count: prev.count + 1,
            tokens: prev.tokens + tokens,
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
      const liveContext = currentContextUsage(session.session, messages, session.getParts, providers)

      return {
        input: sum.input + assistantUsages.reduce((acc, item) => acc + item.tokens.input, 0),
        output: sum.output + assistantUsages.reduce((acc, item) => acc + item.tokens.output, 0),
        reasoning: sum.reasoning + reasoningTokens,
        cache_read: sum.cache_read + assistantUsages.reduce((acc, item) => acc + item.tokens.cache.read, 0),
        cache_write: sum.cache_write + assistantUsages.reduce((acc, item) => acc + item.tokens.cache.write, 0),
        cost: sum.cost + cost,
        tools: sum.tools + parts.filter(({ part }) => part.type === "tool").length,
        compact: sum.compact + parts.filter(({ part }) => part.type === "compaction").length,
        generation_output: sum.generation_output + generation.output,
        generation_duration: sum.generation_duration + generation.duration,
        context_tokens: sum.context_tokens + liveContext.tokens,
        context_percent_total: sum.context_percent_total + (liveContext.percent ?? 0),
        context_percent_count: sum.context_percent_count + (liveContext.percent === null ? 0 : 1),
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

// Per-session accounting breakdown used by the sidebar's cumulative usage
// widget. Unlike `summarizeUsage`, these sums are maintained incrementally by
// `BilledUsageTracker`: a single full-history snapshot seeds them and then
// new messages/parts only adjust small per-message units.
export type BilledSums = {
  input: number
  output: number
  reasoning: number
  cache_read: number
  cache_write: number
  cost: number
  tools: number
  compact: number
  generation_output: number
  generation_duration: number
}

export function emptyBilledSums(): BilledSums {
  return {
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
  }
}

export function combineBilledSums(left: BilledSums, right: BilledSums): BilledSums {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cache_read: left.cache_read + right.cache_read,
    cache_write: left.cache_write + right.cache_write,
    cost: left.cost + right.cost,
    tools: left.tools + right.tools,
    compact: left.compact + right.compact,
    generation_output: left.generation_output + right.generation_output,
    generation_duration: left.generation_duration + right.generation_duration,
  }
}

export function billedAvgTokensPerSecond(input: Pick<BilledSums, "generation_output" | "generation_duration">) {
  if (input.generation_output > 0 && input.generation_duration > 0) {
    return formatTokensPerSecond(input.generation_output / (input.generation_duration / 1000))
  }
  return "0 t/s"
}
