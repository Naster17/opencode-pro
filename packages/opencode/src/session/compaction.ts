import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "@/util/token"
import * as Log from "@opencode-ai/core/util/log"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError, Storage } from "@/storage/storage"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Layer, Context, Schema, Option } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { makeRuntime } from "@/effect/run-service"
import { fn } from "@/util/fn"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"
import { CacheOptimizer } from "./cache-optimizer"
import { SessionLimits } from "./limits"

const log = Log.create({ service: "session.compaction" })

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
export const TRUNCATE_KEEP_TOKEN_RATIO = 0.25
export const TRUNCATE_KEEP_MIN_TOKENS = 20_000
export const TRUNCATE_KEEP_MAX_TOKENS = 100_000
export const TRUNCATE_KEEP_MIN_MESSAGES = 5
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
export const TRUNCATE_NOTICE = "[Earlier conversation truncated]"
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function filePlaceholder(part: MessageV2.FilePart): MessageV2.TextPart | undefined {
  if (part.mime === "text/plain" || part.mime === "application/x-directory") return
  return {
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: "text",
    text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
  }
}

// Sums the character footprint of a model-message structure the way
// JSON.stringify would serialize it, but without materializing a giant string.
// On huge sessions (hundreds of MB of tool output) stringify per estimate call
// caused multi-second pauses; string .length is O(1) so this is O(nodes).
function estimateStructureChars(value: unknown): number {
  if (value == null) return 0
  if (typeof value === "string") return value.length
  if (typeof value === "number" || typeof value === "boolean") return String(value).length
  if (Array.isArray(value)) {
    let sum = 2
    for (const item of value) sum += estimateStructureChars(item) + 1
    return sum
  }
  if (typeof value === "object") {
    let sum = 2
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      sum += key.length + 4 + estimateStructureChars(item)
    }
    return sum
  }
  return String(value).length
}

function estimateStructureTokens(value: unknown) {
  return Math.max(0, Math.round(estimateStructureChars(value) / 4))
}

function compactionMessages(messages: MessageV2.WithParts[]) {
  // Pass-through parts are shallow-copied so downstream plugin transforms can
  // never mutate the original store objects. This replaces the previous full
  // structuredClone of the entire visible history, which deep-copied every
  // string and stalled giant sessions right at compaction time.
  return messages.flatMap((message): MessageV2.WithParts[] => {
    if (message.info.role === "user") {
      const parts = message.parts.flatMap((part): MessageV2.Part[] => {
        if (part.type === "text" && !part.ignored && !part.synthetic && part.text.trim()) return [{ ...part }]
        if (part.type === "file") {
          const placeholder = filePlaceholder(part)
          return placeholder ? [placeholder] : []
        }
        return []
      })
      if (!parts.length) return []
      return [
        {
          info: {
            ...message.info,
            format: undefined,
            summary: undefined,
            system: undefined,
            tools: undefined,
          },
          parts,
        },
      ]
    }

    const parts = message.parts.flatMap((part): MessageV2.Part[] => {
      if (part.type === "text" && part.text.trim()) return [{ ...part }]
      if (part.type === "tool") {
        const status = part.state.status
        const result = status === "completed" ? "success" : status === "error" ? "error" : status
        return [
          {
            id: part.id,
            sessionID: part.sessionID,
            messageID: part.messageID,
            type: "text",
            text: `[Action: ${part.tool} | Result: ${result}]`,
            synthetic: true,
          } as MessageV2.TextPart,
        ]
      }
      if (part.type !== "reasoning" || !part.text.trim()) return []
      return [
        {
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          type: "text",
          text: part.text,
          metadata: part.metadata,
          time: part.time,
        },
      ]
    })
    if (!parts.length) return []
    return [{ info: message.info, parts }]
  })
}

function summaryText(message: MessageV2.WithParts) {
  const text = message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: MessageV2.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    const summary = summaryText(msg)
    // Truncate notices are not real summaries; a later /compact anchors on
    // the last real summary (or starts fresh) instead of merging with them.
    if (summary?.startsWith(TRUNCATE_NOTICE)) return []
    return [{ userIndex, assistantIndex, summary }]
  })
}

function buildPrompt(input: { previousSummary?: string; context: string[] }) {
  const anchor = input.previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        input.previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above."
  return [anchor, SUMMARY_TEMPLATE, ...input.context].join("\n\n")
}

function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction" || part.type === "prune")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

// Resolves the cut index (oldest-first) for a truncate pass, or 0 when there
// is nothing worth cutting. Explicit keepMessages counts messages; otherwise
// the window is token-based so sessions bloated by a few giant tool outputs
// still cut: keep the newest messages covering `ratio` of total tokens
// (default 25%, clamped to 20k-100k tokens, at least a few messages for
// coherence), snapped to a turn boundary by the caller.
function truncateCandidate(input: {
  count: number
  estimates: number[]
  totalTokens: number
  keepMessages?: number
  ratio?: number
}): number {
  if (input.keepMessages !== undefined && Number.isFinite(input.keepMessages)) {
    const keep = Math.min(Math.max(1, Math.floor(input.keepMessages)), input.count)
    if (input.count <= keep) return 0
    return input.count - keep
  }
  const explicit = input.ratio !== undefined && Number.isFinite(input.ratio) && input.ratio > 0
  const ratio = explicit ? input.ratio! : TRUNCATE_KEEP_TOKEN_RATIO
  if (ratio >= 1) return 0
  const budget = explicit
    ? input.totalTokens * ratio
    : Math.min(Math.max(input.totalTokens * ratio, TRUNCATE_KEEP_MIN_TOKENS), TRUNCATE_KEEP_MAX_TOKENS)
  if (input.totalTokens <= budget || input.count <= 1) return 0
  const minKeep = Math.min(input.count, TRUNCATE_KEEP_MIN_MESSAGES)
  let acc = 0
  let kept = 0
  for (let i = input.count - 1; i >= 0; i--) {
    acc += input.estimates[i]!
    kept++
    // i === 0 would cut nothing; fall back to dropping the first message when
    // a single giant old message holds the whole budget hostage.
    if (acc >= budget && kept >= minKeep) return Math.max(i, 1)
  }
  return 0
}

function splitTurn(input: {
  messages: MessageV2.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: MessageV2.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    // Estimate each message once and walk suffix sums. Re-estimating a growing
    // slice per start position converted the message conversion into an
    // O(turns x session bytes) workload on giant sessions.
    const sizes = yield* Effect.forEach(
      input.messages.slice(input.turn.start, input.turn.end),
      (msg) => input.estimate({ messages: [msg], model: input.model }),
      { concurrency: 1 },
    )
    const suffix = new Array<number>(sizes.length + 1).fill(0)
    for (let i = sizes.length - 1; i >= 0; i--) {
      suffix[i] = suffix[i + 1]! + sizes[i]!
    }
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = suffix[start - input.turn.start]!
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
    sessionID: SessionID
  }) => Effect.Effect<boolean>
  readonly prune: (input: {
    sessionID: SessionID
    force?: boolean
    dryRun?: boolean
  }) => Effect.Effect<{
    pruned: number
    tokens: number
    belowMinimum?: boolean
    scanned: number
    protectedTokens: number
    alreadyCleared: boolean
  }>
  readonly truncate: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    keepMessages?: number
    ratio?: number
    keepTurns?: number
  }) => Effect.Effect<{ messages: number; tokens: number; keptMessages: number; kept: number }>
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Bus.Service
  | Config.Service
  | Session.Service
  | Agent.Service
  | Plugin.Service
  | SessionProcessor.Service
  | Provider.Service
  | Storage.Service
  | SessionLimits.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const storage = yield* Storage.Service
    const limits = yield* SessionLimits.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
      sessionID: SessionID
    }) {
      const limit = yield* limits.get(input.sessionID)
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        noCompact: limit.enabled,
        threshold: limit.threshold,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return estimateStructureTokens(msgs)
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) log.info("tail fallback", { budget, size, total })
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // Walks newest-first and keeps the most recent PRUNE_PROTECT tokens worth
    // of tool outputs intact, then erases the output of older tool calls to
    // free context space. Protection is token-based (not turn-based) so
    // single-turn sessions bloated by dozens of tool calls still prune. Only
    // wire-visible history is walked: outputs hidden behind a completed
    // compaction/truncate marker are already out of context, pruning them
    // would only inflate the report.
    // Manual invocations (via the API) bypass the compaction.prune config gate;
    // the auto call site in session/prompt.ts applies that gate itself.
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: {
      sessionID: SessionID
      force?: boolean
      dryRun?: boolean
    }) {
      log.info("pruning", { force: input.force, dryRun: input.dryRun })

      const cfg = yield* config.get()
      const stablePrune = cfg.compaction?.stable_prune ?? true

      const existing = yield* session
        .get(input.sessionID)
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!existing) return { pruned: 0, tokens: 0, scanned: 0, protectedTokens: 0, alreadyCleared: false }

      // Check if stable_prune is enabled to determine how to check for already-compacted parts
      const alreadyCompacted = new Set<string>()

      if (stablePrune) {
        // Load already compacted parts from storage
        const stored = yield* storage
          .read<{ partIDs?: string[] }>(["compacted_tool_session", input.sessionID])
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (stored?.partIDs) {
          for (const id of stored.partIDs) alreadyCompacted.add(id)
        }
      }

      let total = 0
      let pruned = 0
      let scanned = 0
      let alreadyCleared = false
      const toPrune: MessageV2.ToolPart[] = []
      const completed = new Set<string>()
      let cutoff: string | undefined

      // Walk newest-first through a lazy paged stream instead of materializing
      // the entire session; the loop almost always stops at the first compacted
      // boundary near the tail, so giant sessions never leave the first pages.
      // Messages hidden behind a completed compaction/truncate marker never
      // reach the wire, so pruning them only inflates the report: mirror
      // filterCompacted() and stop at the newest marker's cut.
      loop: for (const msg of MessageV2.stream(input.sessionID)) {
        if (cutoff && msg.info.id < cutoff) break loop
        if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error) {
          completed.add(msg.info.parentID)
          continue
        }
        if (msg.info.role === "user") {
          const markerPart = msg.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")
          if (markerPart) {
            if (markerPart.truncated) cutoff = markerPart.tail_start_id ?? msg.info.id
            else if (completed.has(msg.info.id)) cutoff = msg.info.id
            continue
          }
        }
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

          // Check if already compacted (either in storage or in part itself)
          if (stablePrune) {
            if (alreadyCompacted.has(part.id)) {
              alreadyCleared = true
              break loop
            }
          } else {
            if (part.state.time.compacted) {
              alreadyCleared = true
              break loop
            }
          }

          scanned++
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      log.info("found", { pruned, total })
      const protectedTokens = Math.max(0, total - pruned)

      if (input.dryRun)
        return {
          pruned: toPrune.length,
          tokens: pruned,
          belowMinimum: !input.force && pruned <= PRUNE_MINIMUM,
          scanned,
          protectedTokens,
          alreadyCleared,
        }

      if (!input.force && pruned <= PRUNE_MINIMUM)
        return { pruned: 0, tokens: 0, scanned, protectedTokens, alreadyCleared }

      if (toPrune.length > 0) {
        const compactedAt = Date.now()
        const appliedIDs = toPrune.map((part) => part.id)

        if (stablePrune) {
          // Store compacted metadata separately to avoid modifying old parts.
          // This prevents cache invalidation. The compacted status is checked in toModelMessagesEffect.
          const compactedPartIDs = toPrune.flatMap((part) =>
            part.state.status === "completed" ? [part.id] : [],
          )
          const existing = yield* storage
            .read<{ compacted: number; partIDs?: string[] }>(["compacted_tool_session", input.sessionID])
            .pipe(Effect.catch(() => Effect.succeed({ compacted: compactedAt, partIDs: [] })))
          yield* storage
            .write(["compacted_tool_session", input.sessionID], {
              compacted: compactedAt,
              partIDs: Array.from(new Set([...(existing.partIDs ?? []), ...compactedPartIDs])),
            })
            .pipe(Effect.ignore)
          log.info("pruned (stable)", { count: toPrune.length, partIDs: compactedPartIDs.length })
        } else {
          // LEGACY BEHAVIOR: Modify tool parts directly (breaks cache)
          for (const part of toPrune) {
            if (part.state.status === "completed") {
              part.state.time.compacted = Date.now()
              yield* session.updatePart(part)
            }
          }
          log.info("pruned (legacy)", { count: toPrune.length })
        }

        // Timeline marker: renders a "Prune" separator and lets undo (revert)
        // restore the compressed tool outputs via the recorded partIDs.
        let lastUser: MessageV2.User | undefined
        for (const msg of MessageV2.stream(input.sessionID)) {
          if (msg.info.role !== "user") continue
          lastUser = msg.info
          break
        }
        if (lastUser) {
          const markerMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            model: lastUser.model,
            sessionID: input.sessionID,
            agent: lastUser.agent,
            time: { created: Date.now() },
          })
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: markerMsg.id,
            sessionID: input.sessionID,
            type: "prune",
            count: toPrune.length,
            tokens: pruned,
            partIDs: appliedIDs,
          })
        }
      }

      return { pruned: toPrune.length, tokens: pruned, scanned, protectedTokens, alreadyCleared }
    })

    // Truncation is a hard cut without an LLM summary (Cline-style): keep the
    // most recent slice verbatim as the new history, drop everything older
    // from the model context. By default the kept window is token-based
    // (~25% of visible tokens, 20k-100k) so sessions bloated by a few giant
    // tool outputs still cut, and it snaps to a turn boundary so tool pairs
    // stay intact. A single marker records the cut so filterCompacted()
    // slices the history and undo/redo can revert it; the full history stays
    // on disk.
    const truncate = Effect.fn("SessionCompaction.truncate")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      keepMessages?: number
      ratio?: number
      keepTurns?: number
    }) {
      const all = yield* MessageV2.filterCompactedEffect(input.sessionID)
      const estimateMsg = (msg: MessageV2.WithParts) =>
        Token.estimate(JSON.stringify({ role: msg.info.role, parts: msg.parts }))
      const estimates = all.map(estimateMsg)
      const totalTokens = estimates.reduce((sum, est) => sum + est, 0)
      const candidate = truncateCandidate({
        count: all.length,
        estimates,
        totalTokens,
        keepMessages: input.keepMessages,
        ratio: input.ratio,
      })
      const turnStarts = turns(all).map((t) => t.start)
      const snapped = turnStarts.find((start) => start >= candidate)
      const cutIndex = candidate <= 0 ? 0 : (snapped ?? candidate)
      if (cutIndex <= 0) {
        return { messages: 0, tokens: 0, keptMessages: all.length, kept: 0 }
      }

      const keptMsgs = all.slice(cutIndex)
      const keptTokens = keptMsgs.reduce((sum, msg) => sum + estimateMsg(msg), 0)

      const removed = all.slice(0, cutIndex)
      const removedTokens = removed.reduce((sum, msg) => sum + estimateMsg(msg), 0)

      const markerMsg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: markerMsg.id,
        sessionID: input.sessionID,
        type: "compaction",
        auto: false,
        truncated: true,
        tail_start_id: all[cutIndex]?.info.id,
        removedMessages: removed.length,
        removedTokens,
      })

      yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
      log.info("truncated", { removed: removed.length, removedTokens, keptTokens })

      return { messages: removed.length, tokens: removedTokens, keptMessages: keptMsgs.length, kept: keptTokens }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent && replay) {
          messages = input.messages.slice(0, idx)
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const visible = history.filter((_, index) => !hidden.has(index))
      const selected = yield* select({
        messages: visible,
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })
      const msgs = compactionMessages(visible)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
        compactToolOutput: true,
        stripProviderMetadata: CacheOptimizer.shouldStripProviderMetadata(model, cfg),
      })
      const ctx = yield* InstanceState.context
      const msg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new MessageV2.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        // The summary message was just written; a lazy newest-first lookup
        // avoids materializing the whole session to find it.
        const found = yield* session.findMessage(input.sessionID, (item) => item.info.id === msg.id)
        const summary = summaryText(
          Option.isSome(found)
            ? found.value
            : {
                info: msg,
                parts: [],
              },
        )
        EventV2.run(SessionEvent.Compaction.Ended.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          text: summary ?? "",
          include: selected.tail_start_id,
        })
        yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
      EventV2.run(SessionEvent.Compaction.Started.Sync, {
        sessionID: input.sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        reason: input.auto ? "auto" : "manual",
      })
    })

    return Service.of({
      isOverflow,
      prune,
      truncate,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(SessionLimits.defaultLayer),
  ),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function isOverflow(input: {
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  sessionID: SessionID
}) {
  return runPromise((svc) => svc.isOverflow(input))
}

export async function prune(input: { sessionID: SessionID }) {
  return runPromise((svc) => svc.prune(input))
}

export const create = fn(
  z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
  }),
  (input) => runPromise((svc) => svc.create(input)),
)

export * as SessionCompaction from "./compaction"
