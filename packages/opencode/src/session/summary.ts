import { Effect, Layer, Context, Schema, Option } from "effect"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: MessageV2.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service

    const normalizeDiffs = Effect.fn("SessionSummary.normalizeDiffs")(function* (key: string[], diffs: Snapshot.FileDiff[]) {
      const next = diffs.map((item) => {
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
      if (next.some((item, i) => item.file !== diffs[i]?.file)) {
        yield* storage.write(key, next).pipe(Effect.ignore)
      }
      return next
    })

    const readDiffs = Effect.fn("SessionSummary.readDiffs")(function* (keys: string[][]) {
      for (const key of keys) {
        const diffs = yield* storage
          .read<Snapshot.FileDiff[]>(key)
          .pipe(Effect.map((diffs) => ({ diffs, key })), Effect.catch(() => Effect.succeed(undefined)))
        if (!diffs) continue
        return yield* normalizeDiffs(diffs.key, diffs.diffs)
      }
      return [] as Snapshot.FileDiff[]
    })

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: MessageV2.WithParts[] }) {
      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      if (from && to) return yield* snapshot.diffFull(from, to)
      return []
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      // Compute the session-wide diff bounds from a lazy paged stream instead
      // of materializing every message and part of the session in memory. The
      // stream walks newest-first, so the first step-finish seen is the latest
      // chronologically ("to") and the last step-start seen is the earliest
      // ("from").
      let from: string | undefined
      let to: string | undefined
      let any = false
      for (const item of MessageV2.stream(input.sessionID)) {
        any = true
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) {
            to ??= part.snapshot
            continue
          }
          if (part.type === "step-start" && part.snapshot) from = part.snapshot
        }
      }
      if (!any) return
      const diffs = from && to ? yield* snapshot.diffFull(from, to) : []
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })

      // The summarized turn was just completed, so both messages sit near the
      // tail; lazy newest-first lookups avoid loading the whole session.
      const targetOption = yield* sessions.findMessage(
        input.sessionID,
        (m) => m.info.id === input.messageID && m.info.role === "user",
      )
      if (Option.isNone(targetOption)) return
      const target = targetOption.value
      if (target.info.role !== "user") return
      const childOption = yield* sessions.findMessage(
        input.sessionID,
        (m) => m.info.role === "assistant" && m.info.parentID === input.messageID,
      )
      const messages = Option.isSome(childOption) ? [target, childOption.value] : [target]
      const msgDiffs = yield* computeDiff({ messages })
      
      // Check if stable_history is enabled (default: true)
      // When enabled, we don't modify old user messages to maintain cache stability
      const cfg = yield* config.get()
      const stableHistory = cfg.caching?.stable_history ?? true
      
      if (stableHistory) {
        // Store diffs separately without modifying the user message
        // This prevents cache invalidation caused by updating old messages
        yield* storage.write(["message_diff", input.sessionID, input.messageID], msgDiffs).pipe(Effect.ignore)
        return
      }

      // Legacy behavior: update the user message with diffs
      // This will invalidate the cache but preserves old behavior if needed
      target.info.summary = { ...target.info.summary, diffs: msgDiffs }
      yield* sessions.updateMessage(target.info)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      if (input.messageID) {
        return yield* readDiffs([
          ["message_diff", input.sessionID, input.messageID],
          ["message_diff", input.messageID],
        ])
      }

      return yield* readDiffs([["session_diff", input.sessionID]])
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export * as SessionSummary from "./summary"
