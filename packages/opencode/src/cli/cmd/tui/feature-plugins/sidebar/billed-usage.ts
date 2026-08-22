import { batch, createSignal } from "solid-js"
import type { AssistantMessage, Event, Message, Part } from "@opencode-ai/sdk/v2"
import { combineBilledSums, emptyBilledSums, type BilledSums } from "@tui/util/usage"

type PartKind = "tool" | "compaction" | "reasoning" | "finish"

type Finish = {
  tokens: AssistantMessage["tokens"]
  cost: number
}

type Entry = {
  info: Message | undefined
  tools: number
  compact: number
  generationStart: number | undefined
  reasoningByPart: Map<string, number>
  finishes: Map<string, Finish>
  partKind: Map<string, PartKind>
}

export type AllMessages = Array<{ info: Message; parts: Part[] }>

function partKind(part: Part): PartKind | undefined {
  if (part.type === "tool") return "tool"
  if (part.type === "compaction") return "compaction"
  if (part.type === "reasoning") return "reasoning"
  if (part.type === "step-finish") return "finish"
  return undefined
}

// Tracks cumulative billed usage (input/output/reasoning/cache/cost/tools/
// compact) for a set of sessions without holding their full history in the
// reactive sync store. A full snapshot is fetched once per session (transiently,
// outside the store) and collapsed into per-message accounting units; afterwards
// new messages and part updates only adjust those units through events, so the
// totals stay accurate without ever re-fetching the whole conversation.
export class BilledUsageTracker {
  private entries = new Map<string, Entry>()
  private tracked = new Set<string>()
  private baselined = new Set<string>()
  private inFlight = new Set<string>()
  private readonly version = createSignal(0)
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private fetchAll: (sessionID: string) => Promise<AllMessages>) {}

  get totals(): BilledSums {
    this.version[0]()
    let totals = emptyBilledSums()
    for (const entry of this.entries.values()) {
      totals = combineBilledSums(totals, this.entryTotals(entry))
    }
    return totals
  }

  setTracked(ids: Iterable<string>) {
    this.tracked = new Set(ids)
  }

  // Fetch a session's full history once and seed per-message units from it.
  // Idempotent and guarded against overlapping fetches for the same session.
  async ensureBaseline(sessionID: string) {
    if (!this.tracked.has(sessionID)) return
    if (this.baselined.has(sessionID) || this.inFlight.has(sessionID)) return
    this.inFlight.add(sessionID)
    try {
      const messages = await this.fetchAll(sessionID)
      batch(() => {
        for (const { info, parts } of messages) {
          this.entries.set(info.id, this.entryFromMessage(info, parts))
        }
      })
      this.baselined.add(sessionID)
      this.bump()
    } finally {
      this.inFlight.delete(sessionID)
    }
  }

  // Clears all state; called when switching to a different root session so the
  // snapshot is rebuilt from the new session's history on demand.
  reset() {
    this.dispose()
    this.bump()
  }

  // Clears everything without scheduling another refresh. Called on teardown.
  dispose() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    this.entries.clear()
    this.tracked.clear()
    this.baselined.clear()
    this.inFlight.clear()
  }

  // Fires any pending throttled refresh immediately. Exposed for tests.
  flush() {
    if (!this.flushTimer) return
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.version[1]((value) => value + 1)
  }

  onEvent(event: Event) {
    switch (event.type) {
      case "message.updated":
        this.onMessageUpdated(event.properties.sessionID, event.properties.info)
        break
      case "message.removed":
        this.onMessageRemoved(event.properties.sessionID, event.properties.messageID)
        break
      case "message.part.updated":
        this.onPartUpdated(event.properties.part)
        break
      case "message.part.delta":
        this.onPartDelta(
          event.properties.sessionID,
          event.properties.messageID,
          event.properties.partID,
          event.properties.field,
          event.properties.delta,
        )
        break
      case "message.part.removed":
        this.onPartRemoved(event.properties.sessionID, event.properties.messageID, event.properties.partID)
        break
    }
  }

  private onMessageUpdated(sessionID: string, info: Message) {
    if (!this.tracked.has(sessionID)) return
    this.ensureEntry(info.id, info)
    this.bump()
  }

  private onMessageRemoved(sessionID: string, messageID: string) {
    if (!this.tracked.has(sessionID)) return
    if (this.entries.delete(messageID)) this.bump()
  }

  private onPartUpdated(part: Part) {
    if (!this.tracked.has(part.sessionID)) return
    // Parts can arrive before the message.updated event (race), so create the
    // entry lazily; tokens/cost are filled in once the message info lands.
    const entry = this.ensureEntry(part.messageID)
    this.applyPart(entry, part)
    this.bump()
  }

  private onPartDelta(sessionID: string, messageID: string, partID: string, field: string, delta: string) {
    if (!this.tracked.has(sessionID)) return
    if (field !== "text") return
    const entry = this.entries.get(messageID)
    if (!entry) return
    const current = entry.reasoningByPart.get(partID)
    if (current === undefined) return
    entry.reasoningByPart.set(partID, current + delta.length)
    this.bump()
  }

  private onPartRemoved(sessionID: string, messageID: string, partID: string) {
    if (!this.tracked.has(sessionID)) return
    const entry = this.entries.get(messageID)
    if (!entry) return
    this.removePart(entry, partID)
    this.bump()
  }

  private ensureEntry(messageID: string, info?: Message): Entry {
    let entry = this.entries.get(messageID)
    if (!entry) {
      entry = this.newEntry(info)
      this.entries.set(messageID, entry)
    } else if (info) {
      entry.info = info
    }
    return entry
  }

  private newEntry(info?: Message): Entry {
    return {
      info,
      tools: 0,
      compact: 0,
      generationStart: undefined,
      reasoningByPart: new Map(),
      finishes: new Map(),
      partKind: new Map(),
    }
  }

  private entryFromMessage(info: Message, parts: readonly Part[]): Entry {
    const entry = this.newEntry(info)
    for (const part of parts) this.applyPart(entry, part)
    return entry
  }

  // Fold a part into an entry. Tool/compact counts only increment for part ids
  // not seen before, so calling this repeatedly with the same part (streaming
  // updates) stays idempotent.
  private applyPart(entry: Entry, part: Part) {
    const kind = partKind(part)
    if (kind) {
      if (!entry.partKind.has(part.id)) {
        if (kind === "tool") entry.tools++
        else if (kind === "compaction") entry.compact++
      }
      entry.partKind.set(part.id, kind)
    }
    if (part.type === "reasoning") entry.reasoningByPart.set(part.id, part.text.length)
    if (part.type === "step-finish") entry.finishes.set(part.id, { tokens: part.tokens, cost: part.cost })
    if (
      (part.type === "text" || part.type === "reasoning") &&
      part.time?.start &&
      entry.generationStart === undefined
    ) {
      entry.generationStart = part.time.start
    }
  }

  private removePart(entry: Entry, partID: string) {
    const kind = entry.partKind.get(partID)
    if (kind === "tool") entry.tools = Math.max(0, entry.tools - 1)
    else if (kind === "compaction") entry.compact = Math.max(0, entry.compact - 1)
    entry.partKind.delete(partID)
    entry.reasoningByPart.delete(partID)
    entry.finishes.delete(partID)
  }

  private entryTotals(entry: Entry): BilledSums {
    const sums = emptyBilledSums()
    sums.tools = entry.tools
    sums.compact = entry.compact
    const info = entry.info
    if (!info || info.role !== "assistant") return sums

    let tokens = info.tokens
    let cost = info.cost ?? 0
    if (entry.finishes.size > 0) {
      let input = 0
      let output = 0
      let reasoning = 0
      let cacheRead = 0
      let cacheWrite = 0
      cost = 0
      for (const finish of entry.finishes.values()) {
        input += finish.tokens.input
        output += finish.tokens.output
        reasoning += finish.tokens.reasoning
        cacheRead += finish.tokens.cache.read
        cacheWrite += finish.tokens.cache.write
        cost += finish.cost
      }
      tokens = { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } }
    }

    sums.input = tokens.input
    sums.output = tokens.output
    sums.cache_read = tokens.cache.read
    sums.cache_write = tokens.cache.write
    sums.cost = cost

    let reasoning = tokens.reasoning
    if (reasoning === 0) {
      let chars = 0
      for (const length of entry.reasoningByPart.values()) chars += length
      reasoning = Math.ceil(chars / 4)
    }
    sums.reasoning = reasoning

    if (info.time.completed && tokens.output > 0 && entry.generationStart !== undefined) {
      const duration = info.time.completed - entry.generationStart
      if (duration > 0) {
        sums.generation_output = tokens.output
        sums.generation_duration = duration
      }
    }
    return sums
  }

  private bump() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.version[1]((value) => value + 1)
    }, 100)
  }
}
