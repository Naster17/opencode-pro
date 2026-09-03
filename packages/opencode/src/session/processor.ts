import { Cause, Deferred, Effect, Layer, Context, Scope } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import * as Session from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { SessionLimits } from "./limits"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import * as Log from "@opencode-ai/core/util/log"
import { isRecord } from "@/util/record"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"
import { Modelv2 } from "@/v2/model"
import * as DateTime from "effect/DateTime"
import { ProviderError } from "@/provider/error"
import { ThinkTags } from "./think-tags"

const DOOM_LOOP_THRESHOLD = 3
const TOOL_ERROR_STALL_TIMEOUT = 5_000
const TOOL_RESULT_STALL_TIMEOUT = 60_000
const log = Log.create({ service: "session.processor" })

function positiveNumber(value: unknown) {
  if (typeof value !== "number") return
  if (!Number.isFinite(value) || value <= 0) return
  return value
}

function nonNegativeInteger(value: unknown) {
  if (typeof value !== "number") return
  if (!Number.isInteger(value) || value < 0) return
  return value
}

function usageTokens(value: unknown) {
  if (!isRecord(value)) return {}
  return {
    promptTokens:
      nonNegativeInteger(value.prompt_tokens) ??
      nonNegativeInteger(value.input_tokens) ??
      nonNegativeInteger(value.promptTokenCount) ??
      nonNegativeInteger(value.inputTokens) ??
      nonNegativeInteger(value.input_tokens_total),
    outputTokens:
      nonNegativeInteger(value.completion_tokens) ??
      nonNegativeInteger(value.output_tokens) ??
      nonNegativeInteger(value.candidatesTokenCount) ??
      nonNegativeInteger(value.outputTokens) ??
      nonNegativeInteger(value.generated_tokens),
  }
}

function rawStreamMetrics(raw: unknown) {
  if (!isRecord(raw)) return
  const timings = isRecord(raw.timings) ? raw.timings : undefined
  const progress = isRecord(raw.prompt_progress) ? raw.prompt_progress : undefined
  const usage = usageTokens(raw.usage)
  const messageUsage = usageTokens(isRecord(raw.message) ? raw.message.usage : undefined)
  const metadataUsage = usageTokens(raw.usageMetadata)
  const metaTokens = usageTokens(isRecord(raw.meta) ? raw.meta.tokens : undefined)
  if (!timings && !progress && !usage.promptTokens && !usage.outputTokens && !messageUsage.promptTokens && !messageUsage.outputTokens && !metadataUsage.promptTokens && !metadataUsage.outputTokens && !metaTokens.promptTokens && !metaTokens.outputTokens) return

  const progressProcessed = nonNegativeInteger(progress?.processed)
  const progressMs = positiveNumber(progress?.time_ms)
  const promptTokens =
    progress
      ? (progressProcessed ?? 0)
      : (nonNegativeInteger(timings?.prompt_n) ??
        usage.promptTokens ??
        messageUsage.promptTokens ??
        metadataUsage.promptTokens ??
        metaTokens.promptTokens)
  const promptMs = positiveNumber(timings?.prompt_ms)
  const outputTokens =
    progress
      ? undefined
      : (nonNegativeInteger(timings?.predicted_n) ??
        usage.outputTokens ??
        messageUsage.outputTokens ??
        metadataUsage.outputTokens ??
        metaTokens.outputTokens)
  const outputMs = positiveNumber(timings?.predicted_ms)
  const promptTokensPerSecond = progress
    ? progressProcessed && progressMs
      ? (progressProcessed / progressMs) * 1000
      : undefined
    : promptTokens && promptMs
      ? (promptTokens / promptMs) * 1000
      : positiveNumber(timings?.prompt_per_second)
  const outputTokensPerSecond = !progress && outputTokens
    ? outputMs
      ? (outputTokens / outputMs) * 1000
      : positiveNumber(timings?.predicted_per_second)
    : undefined
  const promptProgress = progress
    ? {
        total: nonNegativeInteger(progress.total) ?? 0,
        cache: nonNegativeInteger(progress.cache) ?? 0,
        processed: nonNegativeInteger(progress.processed) ?? 0,
        time_ms: nonNegativeInteger(progress.time_ms) ?? 0,
      }
    : undefined

  if (!promptTokens && !outputTokens && !promptTokensPerSecond && !outputTokensPerSecond && !promptProgress) return
  return {
    promptTokens,
    outputTokens,
    promptTokensPerSecond,
    outputTokensPerSecond,
    promptProgress,
  }
}

function interruptedToolInput(part: MessageV2.ToolPart, raw?: string) {
  const interruptedRaw = raw ?? (part.state.status === "pending" ? part.state.raw : "")
  if (part.state.status !== "pending" || !interruptedRaw.trim()) return part.state.input

  try {
    const parsed = JSON.parse(interruptedRaw) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    return part.state.input
  }

  return part.state.input
}

function interruptedToolMetadata(part: MessageV2.ToolPart, metadata: Record<string, unknown>, raw?: string) {
  const interruptedRaw = raw ?? (part.state.status === "pending" ? part.state.raw : "")
  if (part.state.status !== "pending" || !interruptedRaw.trim()) return { ...metadata, interrupted: true }
  return { ...metadata, interrupted: true, interruptedRaw }
}

function errorDetails(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return errorMessage(error)
}

function invalidToolCallFailure(error: unknown) {
  const detail = errorDetails(error)
  if (/NoSuchToolError|InvalidToolInputError|ToolCallRepairError|tool call repair/i.test(detail)) return detail
  if (!/tool[-_\s]?call|tool_calls|toolName|arguments/i.test(detail)) return
  if (!/invalid|parse|schema|repair|unknown|no such|not found|malformed/i.test(detail)) return
  return detail
}

function plainTextToolCallAttempt(text: string) {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) return
  const tool =
    compact.match(/to=functions\.([A-Za-z0-9_-]+)/)?.[1] ??
    compact.match(/<\|channel\|>[^<]*to=([A-Za-z0-9_-]+)/)?.[1]
  if (!tool) return
  if (!/(<\|start\|>|<\|channel\|>|<\|message\|>|<\|call\|>)/.test(compact)) return
  return { tool, text: compact }
}

export type Result = "compact" | "stop" | "continue"

export type Event = LLM.Event

export interface Handle {
  readonly message: MessageV2.Assistant
  readonly parts: () => MessageV2.Part[]
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
  ephemeral?: boolean
  ephemeralEvents?: EphemeralEvents
}

type EphemeralEvents = {
  readonly messageUpdated?: (message: MessageV2.Assistant) => Effect.Effect<void>
  readonly partUpdated?: (part: MessageV2.Part) => Effect.Effect<void>
  readonly partDelta?: (input: {
    sessionID: SessionID
    messageID: MessageV2.Part["messageID"]
    partID: MessageV2.Part["id"]
    field: string
    delta: string
  }) => Effect.Effect<void>
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
  raw: string
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: MessageV2.TextPart | undefined
  currentTextStartedAt: number | undefined
  currentTextMetadata: MessageV2.TextPart["metadata"] | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
  reasoningTagStripper: Record<string, ReturnType<typeof ThinkTags.createStripper>>
  inlineThink: ThinkTags.SplitState & { reasoningID?: string }
}

type StreamEvent = Event

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Session.Service
  | Config.Service
  | Bus.Service
  | Snapshot.Service
  | Agent.Service
  | LLM.Service
  | Permission.Service
  | Plugin.Service
  | SessionSummary.Service
  | SessionStatus.Service
  | SessionLimits.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const limits = yield* SessionLimits.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        currentTextStartedAt: undefined,
        currentTextMetadata: undefined,
        reasoningMap: {},
        reasoningTagStripper: {},
        inlineThink: { active: false, pending: "" },
      }
      let aborted = false
      const localParts: MessageV2.Part[] = []
      const slog = log.clone().tag("session.id", input.sessionID).tag("messageID", input.assistantMessage.id)

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const updateMessage = (message: MessageV2.Assistant) => {
        if (input.ephemeral) {
          return (input.ephemeralEvents?.messageUpdated?.(structuredClone(message)) ?? Effect.void).pipe(
            Effect.as(message),
          )
        }
        return session.updateMessage(message)
      }

      const updatePart = <T extends MessageV2.Part>(part: T) => {
        if (!input.ephemeral) return session.updatePart(part)
        const index = localParts.findIndex((item) => item.id === part.id && item.messageID === part.messageID)
        if (index === -1) {
          localParts.push(part)
          localParts.sort((a, b) => a.id.localeCompare(b.id))
          return (input.ephemeralEvents?.partUpdated?.(structuredClone(part)) ?? Effect.void).pipe(Effect.as(part))
        }
        localParts[index] = part
        return (input.ephemeralEvents?.partUpdated?.(structuredClone(part)) ?? Effect.void).pipe(Effect.as(part))
      }

      const updatePartDelta = Effect.fnUntraced(function* (inputDelta: {
        sessionID: SessionID
        messageID: MessageV2.Part["messageID"]
        partID: MessageV2.Part["id"]
        field: string
        delta: string
      }) {
        if (input.ephemeral) {
          yield* input.ephemeralEvents?.partDelta?.(inputDelta) ?? Effect.void
          return
        }
        yield* session.updatePartDelta(inputDelta)
      })

      const getPart = Effect.fn("SessionProcessor.getPart")(function* (inputPart: {
        sessionID: SessionID
        messageID: MessageV2.Part["messageID"]
        partID: MessageV2.Part["id"]
      }) {
        if (input.ephemeral) {
          return localParts.find(
            (part) =>
              part.sessionID === inputPart.sessionID &&
              part.messageID === inputPart.messageID &&
              part.id === inputPart.partID,
          )
        }
        return yield* session.getPart(inputPart)
      })

      const parts = (messageID: MessageV2.Part["messageID"]) => {
        if (input.ephemeral) return localParts.filter((part) => part.messageID === messageID)
        return MessageV2.parts(messageID)
      }

      const startReasoning = Effect.fnUntraced(function* (
        reasoningID: string,
        metadata?: MessageV2.ReasoningPart["metadata"],
      ) {
        if (reasoningID in ctx.reasoningMap) return
        if (!input.ephemeral) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          EventV2.run(SessionEvent.Reasoning.Started.Sync, {
            sessionID: ctx.sessionID,
            reasoningID,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        ctx.reasoningMap[reasoningID] = {
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "reasoning",
          text: "",
          time: { start: Date.now() },
          metadata,
        }
        ctx.reasoningTagStripper[reasoningID] = ThinkTags.createStripper()
        yield* updatePart(ctx.reasoningMap[reasoningID])
      })

      const appendReasoning = Effect.fnUntraced(function* (
        reasoningID: string,
        text: string,
        metadata?: MessageV2.ReasoningPart["metadata"],
      ) {
        yield* startReasoning(reasoningID, metadata)
        const match = ctx.reasoningMap[reasoningID]
        if (!match) return
        const delta = (ctx.reasoningTagStripper[reasoningID] ??= ThinkTags.createStripper()).push(text)
        if (metadata) match.metadata = metadata
        if (!delta) return
        match.text += delta
        if (!input.ephemeral) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          EventV2.run(SessionEvent.Reasoning.Delta.Sync, {
            sessionID: ctx.sessionID,
            reasoningID,
            delta,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        yield* updatePartDelta({
          sessionID: match.sessionID,
          messageID: match.messageID,
          partID: match.id,
          field: "text",
          delta,
        })
      })

      const endReasoning = Effect.fnUntraced(function* (
        reasoningID: string,
        metadata?: MessageV2.ReasoningPart["metadata"],
      ) {
        const match = ctx.reasoningMap[reasoningID]
        if (!match) return
        const pending = ctx.reasoningTagStripper[reasoningID]?.flush() ?? ""
        if (pending) match.text += pending
        delete ctx.reasoningTagStripper[reasoningID]
        if (!input.ephemeral) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          EventV2.run(SessionEvent.Reasoning.Ended.Sync, {
            sessionID: ctx.sessionID,
            reasoningID,
            text: match.text,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        match.time = { ...match.time, end: Date.now() }
        if (metadata) match.metadata = metadata
        yield* updatePart(match)
        delete ctx.reasoningMap[reasoningID]
      })

      const startText = Effect.fnUntraced(function* (metadata?: MessageV2.TextPart["metadata"]) {
        if (ctx.currentText || ctx.currentTextStartedAt) return
        if (!input.ephemeral && !ctx.assistantMessage.summary) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          EventV2.run(SessionEvent.Text.Started.Sync, {
            sessionID: ctx.sessionID,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        ctx.currentTextStartedAt = Date.now()
        ctx.currentTextMetadata = metadata
      })

      const ensureText = Effect.fnUntraced(function* (metadata?: MessageV2.TextPart["metadata"]) {
        if (ctx.currentText) return ctx.currentText
        const start = ctx.currentTextStartedAt ?? Date.now()
        ctx.currentText = {
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "text",
          text: "",
          time: { start },
          metadata: metadata ?? ctx.currentTextMetadata,
        }
        yield* updatePart(ctx.currentText)
        return ctx.currentText
      })

      const appendText = Effect.fnUntraced(function* (text: string, metadata?: MessageV2.TextPart["metadata"]) {
        if (!text) return
        yield* startText(metadata)
        const part = yield* ensureText(metadata)
        part.text += text
        if (metadata) part.metadata = metadata
        if (!input.ephemeral && !ctx.assistantMessage.summary) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          EventV2.run(SessionEvent.Text.Delta.Sync, {
            sessionID: ctx.sessionID,
            delta: text,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        yield* updatePartDelta({
          sessionID: part.sessionID,
          messageID: part.messageID,
          partID: part.id,
          field: "text",
          delta: text,
        })
      })

      const appendTextStream = Effect.fnUntraced(function* (value: Extract<StreamEvent, { type: "text-delta" }>) {
        for (const part of ThinkTags.split(ctx.inlineThink, value.text)) {
          if (part.type === "reasoning") {
            ctx.inlineThink.reasoningID ??= `inline:${value.id}`
            yield* appendReasoning(ctx.inlineThink.reasoningID, part.text, value.providerMetadata)
            continue
          }
          yield* appendText(part.text, value.providerMetadata)
        }
        if (!ctx.inlineThink.active && ctx.inlineThink.reasoningID) {
          yield* endReasoning(ctx.inlineThink.reasoningID, value.providerMetadata)
          ctx.inlineThink.reasoningID = undefined
        }
      })

      const flushInlineThink = Effect.fnUntraced(function* () {
        for (const part of ThinkTags.flushSplit(ctx.inlineThink)) {
          if (part.type === "reasoning") {
            ctx.inlineThink.reasoningID ??= `inline:${ctx.assistantMessage.id}`
            yield* appendReasoning(ctx.inlineThink.reasoningID, part.text)
            continue
          }
          yield* appendText(part.text)
        }
        if (ctx.inlineThink.reasoningID) {
          yield* endReasoning(ctx.inlineThink.reasoningID)
          ctx.inlineThink.reasoningID = undefined
        }
        ctx.inlineThink.active = false
      })

      const convertCurrentTextToReasoning = Effect.fnUntraced(function* () {
        yield* flushInlineThink()
        if (!ctx.currentText) return
        if (!ctx.currentText.text.trim()) return
        const end = Date.now()
        yield* updatePart({
          id: ctx.currentText.id,
          messageID: ctx.currentText.messageID,
          sessionID: ctx.currentText.sessionID,
          type: "reasoning",
          text: ThinkTags.strip(ctx.currentText.text),
          time: { start: ctx.currentText.time?.start ?? end, end },
          metadata: ctx.currentText.metadata,
        } satisfies MessageV2.ReasoningPart)
        ctx.currentText = undefined
        ctx.currentTextStartedAt = undefined
        ctx.currentTextMetadata = undefined
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        const part = yield* getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return
        if (match.part.state.status === "completed" || match.part.state.status === "error") return match.part
        const part = yield* updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: MessageV2.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return
        if (match.part.state.status === "completed" || match.part.state.status === "error") {
          yield* settleToolCall(toolCallID)
          return
        }
        const start = match.part.state.status === "running" ? match.part.state.time.start : Date.now()
        yield* updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return false
        if (match.part.state.status === "completed" || match.part.state.status === "error") {
          yield* settleToolCall(toolCallID)
          return false
        }
        const start = match.part.state.status === "running" ? match.part.state.time.start : Date.now()
        yield* updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            time: { start, end: Date.now() },
          },
        })
        if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const appendInvalidToolCall = Effect.fn("SessionProcessor.appendInvalidToolCall")(function* (input: {
        tool: string
        error: string
        location: string
        raw?: string
      }) {
        const now = Date.now()
        const id = PartID.ascending()
        yield* updatePart({
          id,
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: "invalid",
          callID: `invalid-${id}`,
          state: {
            status: "error",
            input: {
              tool: input.tool,
              error: input.error,
            },
            error: input.error,
            metadata: {
              warning: true,
              location: input.location,
              ...(input.raw ? { raw: input.raw } : {}),
            },
            time: { start: now, end: now },
          },
        } satisfies MessageV2.ToolPart)
      })

      const recoverInvalidToolCallFailure = Effect.fn("SessionProcessor.recoverInvalidToolCallFailure")(function* (error: unknown) {
        const detail = invalidToolCallFailure(error)
        if (!detail) return false
        yield* appendInvalidToolCall({
          tool: "tool",
          location: "LLM stream",
          error: `Invalid tool call from the model at LLM stream: ${detail}. Use a structured tool call with a known tool name and valid JSON arguments instead of malformed tool-call data.`,
        })
        return true
      })

      const recoverPlainTextToolCallAttempt = Effect.fn("SessionProcessor.recoverPlainTextToolCallAttempt")(function* () {
        const text =
          ctx.currentText ??
          parts(ctx.assistantMessage.id)
            .slice()
            .reverse()
            .find((part) => part.type === "text" || part.type === "reasoning")
        if (!text) return false
        const attempt = plainTextToolCallAttempt(text.text)
        if (!attempt) return false
        text.text = ""
        text.time = { start: text.time?.start ?? Date.now(), end: Date.now() }
        yield* updatePart(text)
        yield* appendInvalidToolCall({
          tool: attempt.tool,
          location: `assistant ${text.type} part ${text.id}`,
          raw: attempt.text,
          error: `Invalid ${attempt.tool} call at assistant ${text.type} part ${text.id}: the model printed tool-call markup as plain text instead of making a structured tool call. Use the actual tool call channel/protocol with valid JSON arguments; do not print raw tokens like <|start|>, <|channel|>, <|message|>, or <|call|>.`,
        })
        return true
      })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "start":
            if (!input.ephemeral) yield* status.set(ctx.sessionID, { type: "busy" })
            return

          case "reasoning-start":
            yield* startReasoning(value.id, value.providerMetadata)
            return

          case "reasoning-delta":
            yield* appendReasoning(value.id, value.text, value.providerMetadata)
            return

          case "reasoning-end":
            yield* endReasoning(value.id, value.providerMetadata)
            return

          case "tool-input-start":
            yield* convertCurrentTextToReasoning()
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            if (!input.ephemeral) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Tool.Input.Started.Sync, {
                sessionID: ctx.sessionID,
                callID: value.id,
                name: value.toolName,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            const part = yield* updatePart({
              id: ctx.toolcalls[value.id]?.partID ?? PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "tool",
              tool: value.toolName,
              callID: value.id,
              state: { status: "pending", input: {}, raw: "" },
              metadata: value.providerExecuted ? { providerExecuted: true } : undefined,
            } satisfies MessageV2.ToolPart)
            ctx.toolcalls[value.id] = {
              done: yield* Deferred.make<void>(),
              partID: part.id,
              messageID: part.messageID,
              sessionID: part.sessionID,
              raw: "",
            }
            return

          case "tool-input-delta": {
            const toolCall = yield* readToolCall(value.id)
            if (!input.ephemeral) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Tool.Input.Delta.Sync, {
                sessionID: ctx.sessionID,
                callID: value.id,
                delta: value.delta,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            if (toolCall?.part.state.status !== "pending") return
            toolCall.call.raw += value.delta
            toolCall.part.state.raw += value.delta
            yield* updatePartDelta({
              sessionID: toolCall.part.sessionID,
              messageID: toolCall.part.messageID,
              partID: toolCall.part.id,
              field: "raw",
              delta: value.delta,
            })
            return
          }

          case "tool-input-end": {
            if (!input.ephemeral) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Tool.Input.Ended.Sync, {
                sessionID: ctx.sessionID,
                callID: value.id,
                text: "",
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            return
          }

          case "tool-call": {
            yield* convertCurrentTextToReasoning()
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            const toolCall = yield* readToolCall(value.toolCallId)
            if (!input.ephemeral) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Tool.Called.Sync, {
                sessionID: ctx.sessionID,
                callID: value.toolCallId,
                tool: value.toolName,
                input: value.input,
                provider: {
                  executed: toolCall?.part.metadata?.providerExecuted === true,
                  ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* updateToolCall(value.toolCallId, (match) => ({
              ...match,
              tool: value.toolName,
              state: {
                ...match.state,
                status: "running",
                input: value.input,
                time: { start: Date.now() },
              },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const recentParts = parts(ctx.assistantMessage.id).slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.toolName &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(value.input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.toolName],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.toolName, input: value.input },
              always: [value.toolName],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.toolCallId)
            if (!input.ephemeral) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Tool.Success.Sync, {
                sessionID: ctx.sessionID,
                callID: value.toolCallId,
                structured: value.output.metadata,
                content: [
                  {
                    type: "text",
                    text: value.output.output,
                  },
                  ...(value.output.attachments?.map((item: MessageV2.FilePart) => ({
                    type: "file",
                    uri: item.url,
                    mime: item.mime,
                    name: item.filename,
                  })) ?? []),
                ],
                provider: {
                  executed: toolCall?.part.metadata?.providerExecuted === true,
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* completeToolCall(value.toolCallId, value.output)
            return
          }

          case "tool-error": {
            const toolCall = yield* readToolCall(value.toolCallId)
            if (!input.ephemeral) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Tool.Failed.Sync, {
                sessionID: ctx.sessionID,
                callID: value.toolCallId,
                error: {
                  type: "unknown",
                  message: errorMessage(value.error),
                },
                provider: {
                  executed: toolCall?.part.metadata?.providerExecuted === true,
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* failToolCall(value.toolCallId, value.error)
            return
          }

          case "error":
            if (yield* recoverInvalidToolCallFailure(value.error)) return
            throw value.error

          case "start-step":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            if (!input.ephemeral && !ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Step.Started.Sync, {
                sessionID: ctx.sessionID,
                agent: input.assistantMessage.agent,
                model: {
                  id: Modelv2.ID.make(ctx.model.id),
                  providerID: Modelv2.ProviderID.make(ctx.model.providerID),
                  variant: Modelv2.VariantID.make(input.assistantMessage.variant ?? "default"),
                },
                snapshot: ctx.snapshot,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "finish-step": {
            const completedSnapshot = yield* snapshot.track()
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage,
              metadata: value.providerMetadata,
            })
            if (!input.ephemeral && !ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Step.Ended.Sync, {
                sessionID: ctx.sessionID,
                finish: value.finishReason,
                cost: usage.cost,
                tokens: usage.tokens,
                snapshot: completedSnapshot,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            ctx.assistantMessage.finish = value.finishReason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* updatePart({
              id: PartID.ascending(),
              reason: value.finishReason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
              metadata: value.providerMetadata,
            })
            yield* updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            if (!input.ephemeral) {
              yield* summary
                .summarize({
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.parentID,
                })
                .pipe(Effect.ignore, Effect.forkIn(scope))
            }
            const limit = yield* limits.get(ctx.sessionID)
            if (
              !input.ephemeral &&
              !ctx.assistantMessage.summary &&
              isOverflow({
                cfg: yield* config.get(),
                tokens: usage.tokens,
                model: ctx.model,
                noCompact: limit.enabled,
                threshold: limit.threshold,
              })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            yield* startText(value.providerMetadata)
            return

          case "text-delta":
            yield* appendTextStream(value)
            return

          case "text-end":
            yield* flushInlineThink()
            if (!ctx.currentText) {
              ctx.currentTextStartedAt = undefined
              ctx.currentTextMetadata = undefined
              return
            }
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            if (!input.ephemeral && !ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Text.Ended.Sync, {
                sessionID: ctx.sessionID,
                text: ctx.currentText.text,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* updatePart(ctx.currentText)
            ctx.currentText = undefined
            ctx.currentTextStartedAt = undefined
            ctx.currentTextMetadata = undefined
            return

          case "finish":
            return

          case "raw": {
            const metrics = rawStreamMetrics(value.rawValue)
            if (!metrics) return
            yield* bus.publish(MessageV2.Event.StreamMetrics, {
              sessionID: ctx.sessionID,
              messageID: ctx.assistantMessage.id,
              time: Date.now(),
              ...metrics,
            })
            return
          }

          default:
            slog.info("unhandled", { event: value.type, value })
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        yield* flushInlineThink()

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* updatePart(ctx.currentText)
          ctx.currentText = undefined
          ctx.currentTextStartedAt = undefined
          ctx.currentTextMetadata = undefined
        }

        for (const [reasoningID, part] of Object.entries(ctx.reasoningMap)) {
          const end = Date.now()
          const pending = ctx.reasoningTagStripper[reasoningID]?.flush() ?? ""
          yield* updatePart({
            ...part,
            text: part.text + pending,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}
        ctx.reasoningTagStripper = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          const pending = part.state.status === "pending"
          yield* updatePart({
            ...part,
            state: {
              status: "error",
              input: interruptedToolInput(part, match.call.raw),
              error: pending ? "Tool call interrupted before input completed" : "Tool execution aborted",
              metadata: interruptedToolMetadata(part, metadata, match.call.raw),
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        const error = parse(e)
        if (MessageV2.ContextOverflowError.isInstance(error) || ProviderError.isOverflow(errorMessage(e))) {
          if (input.ephemeral) {
            ctx.assistantMessage.error = error
            return
          }
          if (
            (yield* config.get()).compaction?.auto === false ||
            (yield* limits.get(ctx.assistantMessage.sessionID)).enabled
          ) {
            ctx.assistantMessage.error = error
            yield* bus.publish(Session.Event.Error, { sessionID: ctx.assistantMessage.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        if (!input.ephemeral && !ctx.assistantMessage.summary) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          EventV2.run(SessionEvent.Step.Failed.Sync, {
            sessionID: ctx.sessionID,
            error: {
              type: "unknown",
              message: errorMessage(e),
            },
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        ctx.assistantMessage.error = error
        if (!input.ephemeral) {
          yield* bus.publish(Session.Event.Error, {
            sessionID: ctx.assistantMessage.sessionID,
            error: ctx.assistantMessage.error,
          })
          yield* status.set(ctx.sessionID, { type: "idle" })
        }
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        slog.info("process")
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true
        const toolResultStallTimeout = (event: StreamEvent) =>
          Number(
            globalThis.process.env.OPENCODE_TEST_TOOL_RESULT_STALL_TIMEOUT_MS ??
              (event.type === "tool-error" ? TOOL_ERROR_STALL_TIMEOUT : TOOL_RESULT_STALL_TIMEOUT),
          )
        const toolResultSettled = yield* Deferred.make<number>()
        const signalToolResultSettled = Effect.fnUntraced(function* (event: StreamEvent) {
          if (event.type !== "tool-result" && event.type !== "tool-error") return
          if (Object.keys(ctx.toolcalls).length > 0) return
          yield* Deferred.succeed(toolResultSettled, toolResultStallTimeout(event)).pipe(Effect.ignore)
        })
        const toolResultStall = Deferred.await(toolResultSettled).pipe(
          Effect.flatMap((timeout) => Effect.sleep(timeout).pipe(Effect.as(timeout))),
          Effect.tap((timeout) =>
            Effect.sync(() =>
              slog.warn("stream stalled after settled tool call", {
                timeout,
              }),
            ),
          ),
        )

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.currentTextStartedAt = undefined
            ctx.currentTextMetadata = undefined
            ctx.reasoningMap = {}
            ctx.reasoningTagStripper = {}
            ctx.inlineThink = { active: false, pending: "" }
            const stream = llm.stream({ ...streamInput, ephemeral: input.ephemeral })

            yield* Effect.raceFirst(
              stream.pipe(
                Stream.tap((event) => handleEvent(event).pipe(Effect.andThen(signalToolResultSettled(event)))),
                Stream.takeUntil(() => ctx.needsCompaction),
                Stream.runDrain,
              ),
              toolResultStall,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.catchIf(
              (error) => invalidToolCallFailure(error) !== undefined,
              (error) => recoverInvalidToolCallFailure(error).pipe(Effect.asVoid),
            ),
            Effect.retry(
              SessionRetry.policy({
                parse,
                set: (info) => {
                  if (input.ephemeral) return Effect.void
                  // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
                  EventV2.run(SessionEvent.Retried.Sync, {
                    sessionID: ctx.sessionID,
                    attempt: info.attempt,
                    error: {
                      message: info.message,
                      isRetryable: true,
                    },
                    timestamp: DateTime.makeUnsafe(Date.now()),
                  })
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    next: info.next,
                  })
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          yield* recoverPlainTextToolCallAttempt()

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        parts() {
          return parts(ctx.assistantMessage.id)
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(SessionLimits.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
