import { afterEach, describe, expect, mock, test } from "bun:test"
import { APICallError } from "ai"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import * as Stream from "effect/Stream"
import z from "zod"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionLimits } from "../../src/session/limits"
import { Token } from "@/util/token"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import * as Log from "@opencode-ai/core/util/log"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SessionV2 } from "../../src/v2/session"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "@/provider/provider"
import * as SessionProcessorModule from "../../src/session/processor"
import { Snapshot } from "../../src/snapshot"
import { Storage } from "@/storage/storage"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestConfig } from "../fixture/config"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  messages(input: z.output<typeof SessionNs.MessagesInput.zod>) {
    return run(SessionNs.Service.use((svc) => svc.messages(input)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(() => {
  mock.restore()
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const wide = () => ProviderTest.fake({ model: createModel({ context: 100_000, output: 32_000 }) })

async function user(sessionID: SessionID, text: string) {
  const msg = await svc.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  await svc.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
}

async function assistant(sessionID: SessionID, parentID: MessageID, root: string) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      output: 0,
      input: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  await svc.updateMessage(msg)
  return msg
}

async function summaryAssistant(sessionID: SessionID, parentID: MessageID, root: string, text: string) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "compaction",
    agent: "compaction",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      output: 0,
      input: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    summary: true,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  await svc.updateMessage(msg)
  await svc.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
}

async function lastCompactionPart(sessionID: SessionID) {
  return (await svc.messages({ sessionID }))
    .at(-2)
    ?.parts.find((item): item is MessageV2.CompactionPart => item.type === "compaction")
}

function fake(
  input: Parameters<SessionProcessorModule.SessionProcessor.Interface["create"]>[0],
  result: "continue" | "compact",
) {
  const msg = input.assistantMessage
  return {
    get message() {
      return msg
    },
    parts: () => [],
    updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
    completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
    process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed(result)),
  } satisfies SessionProcessorModule.SessionProcessor.Handle
}

function layer(result: "continue" | "compact") {
  return Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) => Effect.succeed(fake(input, result))),
    }),
  )
}

function cfg(compaction?: Config.Info["compaction"]) {
  const base = Config.Info.zod.parse({})
  return TestConfig.layer({
    get: () => Effect.succeed({ ...base, compaction }),
  })
}

function runtime(
  result: "continue" | "compact",
  plugin = Plugin.defaultLayer,
  provider = ProviderTest.fake(),
  config = Config.defaultLayer,
) {
  const bus = Bus.layer
  return ManagedRuntime.make(
    Layer.mergeAll(SessionCompaction.layer, bus).pipe(
      Layer.provide(provider.layer),
      Layer.provide(SessionNs.defaultLayer),
      Layer.provide(layer(result)),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(plugin),
      Layer.provide(bus),
      Layer.provide(config),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SessionLimits.defaultLayer),
    ),
  )
}

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  layer("continue"),
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
  Storage.defaultLayer,
  SessionLimits.defaultLayer,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCompaction.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

function llm() {
  const queue: Array<
    Stream.Stream<LLM.Event, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLM.Event, unknown>)
  > = []

  return {
    push(stream: Stream.Stream<LLM.Event, unknown> | ((input: LLM.StreamInput) => Stream.Stream<LLM.Event, unknown>)) {
      queue.push(stream)
    },
    layer: Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          const item = queue.shift() ?? Stream.empty
          const stream = typeof item === "function" ? item(input) : item
          return stream.pipe(Stream.mapEffect((event) => Effect.succeed(event)))
        },
      }),
    ),
  }
}

function liveRuntime(layer: Layer.Layer<LLM.Service>, provider = ProviderTest.fake(), config = Config.defaultLayer) {
  const bus = Bus.layer
  const status = SessionStatus.layer.pipe(Layer.provide(bus))
  const processor = SessionProcessorModule.SessionProcessor.layer.pipe(Layer.provide(summary))
  return ManagedRuntime.make(
    Layer.mergeAll(SessionCompaction.layer.pipe(Layer.provide(processor)), processor, bus, status).pipe(
      Layer.provide(provider.layer),
      Layer.provide(SessionNs.defaultLayer),
      Layer.provide(Snapshot.defaultLayer),
      Layer.provide(layer),
      Layer.provide(Permission.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(status),
      Layer.provide(bus),
      Layer.provide(config),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SessionLimits.defaultLayer),
    ),
  )
}

function reply(
  text: string,
  capture?: (input: LLM.StreamInput) => void,
): (input: LLM.StreamInput) => Stream.Stream<LLM.Event, unknown> {
  return (input) => {
    capture?.(input)
    return Stream.make(
      { type: "start" } satisfies LLM.Event,
      { type: "text-start", id: "txt-0" } satisfies LLM.Event,
      { type: "text-delta", id: "txt-0", delta: text, text } as LLM.Event,
      { type: "text-end", id: "txt-0" } satisfies LLM.Event,
      {
        type: "finish-step",
        finishReason: "stop",
        rawFinishReason: "stop",
        response: { id: "res", modelId: "test-model", timestamp: new Date() },
        providerMetadata: undefined,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokenDetails: {
            textTokens: undefined,
            reasoningTokens: undefined,
          },
        },
      } satisfies LLM.Event,
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokenDetails: {
            textTokens: undefined,
            reasoningTokens: undefined,
          },
        },
      } satisfies LLM.Event,
    )
  }
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function plugin(ready: ReturnType<typeof defer>) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.session.compacting") return Effect.succeed(output)
      return Effect.sync(() => ready.resolve()).pipe(Effect.andThen(Effect.never), Effect.as(output))
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

function autocontinue(enabled: boolean) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(name: Name, _input: Input, output: Output) => {
      if (name !== "experimental.compaction.autocontinue") return Effect.succeed(output)
      return Effect.sync(() => {
        ;(output as { enabled: boolean }).enabled = enabled
        return output
      })
    },
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  })
}

describe("session.compaction.isOverflow", () => {
  it.live(
    "returns true when token count exceeds usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model, sessionID: SessionID.descending() })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when token count within usable context",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model, sessionID: SessionID.descending() })).toBe(false)
      }),
    ),
  )

  it.live(
    "includes cache.read in token count",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 60_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model, sessionID: SessionID.descending() })).toBe(true)
      }),
    ),
  )

  it.live(
    "respects input limit for input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model, sessionID: SessionID.descending() })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when input/output are within input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 200_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model, sessionID: SessionID.descending() })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when output within limit with input caps",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
        const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model, sessionID: SessionID.descending() })).toBe(false)
      }),
    ),
  )

  // ─── Regression tests ────────────────────────────────────────────────
  // Keep a consistent reserve near the context boundary regardless of
  // whether a model advertises a separate limit.input cap.

  it.live(
    "keeps headroom when limit.input is set",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const tokens = { input: 170_000, output: 12_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model, sessionID: SessionID.descending() })).toBe(true)
      }),
    ),
  )

  it.live(
    "keeps the same headroom without limit.input",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 170_000, output: 12_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        const result = yield* compact.isOverflow({ tokens, model, sessionID: SessionID.descending() })
        expect(result).toBe(true)
      }),
    ),
  )

  it.live(
    "stays symmetric with and without limit.input",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 166_000, output: 9_000, reasoning: 0, cache: { read: 5_000, write: 0 } }

        const withLimit = yield* compact.isOverflow({ tokens, model: withInputLimit, sessionID: SessionID.descending() })
        const withoutLimit = yield* compact.isOverflow({
          tokens,
          model: withoutInputLimit,
          sessionID: SessionID.descending(),
        })

        expect(withLimit).toBe(true)
        expect(withoutLimit).toBe(true)
      }),
    ),
  )

  it.live(
    "does not let reasoning tokens bypass overflow detection",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 60_000, output: 1_000, reasoning: 19_000, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model, sessionID: SessionID.descending() })).toBe(true)
      }),
    ),
  )

  it.live(
    "returns false when model context limit is 0",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 0, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model, sessionID: SessionID.descending() })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when compaction.auto is disabled",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
          expect(yield* compact.isOverflow({ tokens, model, sessionID: SessionID.descending() })).toBe(false)
        }),
      {
        config: {
          compaction: { auto: false },
        },
      },
    ),
  )

  it.live(
    "returns false when noCompact runtime flag is set for the session",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const limits = yield* SessionLimits.Service
        const sessionID = SessionID.descending()
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        yield* limits.set({ sessionID, enabled: true })
        expect(yield* compact.isOverflow({ tokens, model, sessionID })).toBe(false)
      }),
    ),
  )

  it.live(
    "suppresses overflow below the runtime token threshold",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const limits = yield* SessionLimits.Service
        const sessionID = SessionID.descending()
        const model = createModel({ context: 200_000, output: 32_000 })
        // 182_000 total tokens: above the usable limit, so overflow without a threshold.
        const tokens = { input: 170_000, output: 12_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(yield* compact.isOverflow({ tokens, model, sessionID })).toBe(true)

        const info = yield* limits.set({ sessionID, threshold: 300_000 })
        expect(info.enabled).toBe(false)
        expect(info.threshold).toBe(300_000)
        expect(yield* compact.isOverflow({ tokens, model, sessionID })).toBe(false)

        // At or above the threshold, normal overflow rules apply again.
        yield* limits.set({ sessionID, threshold: 150_000 })
        expect(yield* compact.isOverflow({ tokens, model, sessionID })).toBe(true)
      }),
    ),
  )

  it.live(
    "clears the threshold and lets full disable win over it",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const limits = yield* SessionLimits.Service
        const sessionID = SessionID.descending()
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 170_000, output: 12_000, reasoning: 0, cache: { read: 0, write: 0 } }

        yield* limits.set({ sessionID, threshold: 150_000 })
        yield* limits.set({ sessionID, enabled: true })
        expect(yield* compact.isOverflow({ tokens, model, sessionID })).toBe(false)

        const cleared = yield* limits.set({ sessionID, threshold: null })
        expect(cleared).toEqual({ enabled: false })
        expect(yield* compact.isOverflow({ tokens, model, sessionID })).toBe(true)
      }),
    ),
  )
})

describe("session.compaction.create", () => {
  it.live(
    "creates a compaction user message and part",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service

        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        expect(msgs).toHaveLength(1)
        expect(msgs[0].info.role).toBe("user")
        expect(msgs[0].parts).toHaveLength(1)
        expect(msgs[0].parts[0]).toMatchObject({
          type: "compaction",
          auto: true,
          overflow: true,
        })

        const v2 = yield* SessionV2.Service.use((svc) => svc.messages({ sessionID: info.id })).pipe(
          Effect.provide(SessionV2.defaultLayer),
        )
        expect(v2.at(-1)).toMatchObject({
          type: "compaction",
          reason: "auto",
          summary: "",
        })
      }),
    ),
  )
})

describe("session.compaction.prune", () => {
  it.live(
    "stores compacted tool IDs without mutating parts when stable_prune is enabled",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const storage = yield* Storage.Service
          const info = yield* ssn.create({})
          const a = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: info.id,
            type: "text",
            text: "first",
          })
          const b: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: a.id,
            time: { created: Date.now() },
            finish: "end_turn",
          }
          yield* ssn.updateMessage(b)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: b.id,
            sessionID: info.id,
            type: "tool",
            callID: crypto.randomUUID(),
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "x".repeat(200_000),
              title: "done",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
          for (const text of ["second", "third"]) {
            const msg = yield* ssn.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: info.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() },
            })
            yield* ssn.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: info.id,
              type: "text",
              text,
            })
          }

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          const compacted = yield* storage.read<{ partIDs?: string[] }>(["compacted_tool_session", info.id])
          expect(part?.type).toBe("tool")
          expect(part?.state.status).toBe("completed")
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeUndefined()
            expect(compacted.partIDs).toContain(part.id)
          }
        }),

      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )

  it.live(
    "mutates tool parts when stable_prune is disabled",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const a = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: info.id,
            type: "text",
            text: "first",
          })
          const b: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: a.id,
            time: { created: Date.now() },
            finish: "end_turn",
          }
          yield* ssn.updateMessage(b)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: b.id,
            sessionID: info.id,
            type: "tool",
            callID: crypto.randomUUID(),
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "x".repeat(200_000),
              title: "done",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
          for (const text of ["second", "third"]) {
            const msg = yield* ssn.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: info.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() },
            })
            yield* ssn.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: info.id,
              type: "text",
              text,
            })
          }

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          expect(part?.type).toBe("tool")
          expect(part?.state.status).toBe("completed")
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeNumber()
          }
        }),

      {
        config: {
          compaction: { prune: true, stable_prune: false },
        },
      },
    ),
  )

  it.live(
    "skips protected skill tool output",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const a = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: a.id,
          sessionID: info.id,
          type: "text",
          text: "first",
        })
        const b: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: info.id,
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: a.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        yield* ssn.updateMessage(b)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: b.id,
          sessionID: info.id,
          type: "tool",
          callID: crypto.randomUUID(),
          tool: "skill",
          state: {
            status: "completed",
            input: {},
            output: "x".repeat(200_000),
            title: "done",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        for (const text of ["second", "third"]) {
          const msg = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: info.id,
            type: "text",
            text,
          })
        }

        yield* compact.prune({ sessionID: info.id })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        expect(part?.type).toBe("tool")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeUndefined()
        }
      }),
    ),
  )

  const seedPruneFixture = (dir: string, sessionID: SessionID, opts?: { outputs?: number[]; tool?: string }) =>
    Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const first = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: first.id,
        sessionID,
        type: "text",
        text: "first",
      })
      const toolPartIDs: string[] = []
      for (const chars of opts?.outputs ?? [200_000]) {
        const b: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID,
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: first.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        yield* ssn.updateMessage(b)
        const part = yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: b.id,
          sessionID,
          type: "tool",
          callID: crypto.randomUUID(),
          tool: opts?.tool ?? "bash",
          state: {
            status: "completed",
            input: {},
            output: "x".repeat(chars),
            title: "done",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        toolPartIDs.push(part.id)
      }
      for (const text of ["second", "third"]) {
        const msg = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID,
          type: "text",
          text,
        })
      }
      return toolPartIDs
    })

  it.live(
    "dryRun reports candidates without mutating anything",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const storage = yield* Storage.Service
          const info = yield* ssn.create({})
          const toolPartIDs = yield* seedPruneFixture(dir, info.id)

          const preview = yield* compact.prune({ sessionID: info.id, dryRun: true })
          expect(preview.pruned).toBe(1)
          expect(preview.tokens).toBeGreaterThan(0)
          expect(preview.belowMinimum).toBe(false)

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((p) => p.id === toolPartIDs[0])
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeUndefined()
          }
          const compacted = yield* storage
            .read<{ partIDs?: string[] }>(["compacted_tool_session", info.id])
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          expect(compacted?.partIDs).toBeUndefined()
        }),
      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )

  it.live(
    "skips small sessions below the minimum threshold unless forced",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          // Chronological tool outputs: two old small ones that cross the protect
          // window only barely (~2k tokens of candidates), then a large new one
          // that stays inside the PRUNE_PROTECT window.
          const toolPartIDs = yield* seedPruneFixture(dir, info.id, { outputs: [2_000, 6_000, 155_000] })
          const storage = yield* Storage.Service

          const preview = yield* compact.prune({ sessionID: info.id, dryRun: true })
          expect(preview.belowMinimum).toBe(true)

          const result = yield* compact.prune({ sessionID: info.id })
          expect(result.pruned).toBe(0)

          const compactedIDs = Effect.gen(function* () {
            const stored = yield* storage
              .read<{ partIDs?: string[] }>(["compacted_tool_session", info.id])
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            return new Set(stored?.partIDs ?? [])
          })

          expect((yield* compactedIDs).has(toolPartIDs[1]!)).toBe(false)
          expect((yield* compactedIDs).has(toolPartIDs[2]!)).toBe(false)

          const forced = yield* compact.prune({ sessionID: info.id, force: true })
          expect(forced.pruned).toBe(2)
          expect((yield* compactedIDs).has(toolPartIDs[0]!)).toBe(true)
          expect((yield* compactedIDs).has(toolPartIDs[1]!)).toBe(true)
          expect((yield* compactedIDs).has(toolPartIDs[2]!)).toBe(false)
        }),
      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )

  it.live(
    "manual invocation bypasses the compaction.prune config gate",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          yield* seedPruneFixture(dir, info.id)

          const result = yield* compact.prune({ sessionID: info.id })
          expect(result.pruned).toBe(1)
        }),
      {
        config: {
          compaction: { prune: false },
        },
      },
    ),
  )

  it.live(
    "pruned outputs ship cleared on the main request path",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        yield* seedPruneFixture(dir, info.id)

        const pruned = yield* compact.prune({ sessionID: info.id, force: true })
        expect(pruned.pruned).toBe(1)

        // Timeline marker (the ----- Prune ----- bar) is recorded alongside.
        const model = createModel({ context: 200_000, output: 32_000 })
        const msgs = yield* ssn.messages({ sessionID: info.id })
        const marker = msgs.findLast(
          (msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "prune"),
        )
        expect(marker).toBeDefined()
        const markerPart = marker!.parts.find((part): part is MessageV2.PrunePart => part.type === "prune")
        expect(markerPart?.count).toBe(1)
        expect(markerPart?.partIDs.length).toBe(1)
        const toolOutput = (converted: unknown) => {
          const wire = converted as Array<{ role: string; content: Array<{ output?: { value?: unknown } }> }>
          return wire.find((msg) => msg.role === "tool")?.content[0]?.output?.value
        }

        // Main loop options (modelMessageOptions): marks must apply.
        const cleared = yield* MessageV2.toModelMessagesEffect(msgs, model, { compactToolOutput: true })
        expect(toolOutput(cleared)).toBe("[Old tool result content cleared]")

        // Without the flag the full output ships (documents the wiring contract).
        const full = yield* MessageV2.toModelMessagesEffect(msgs, model, {})
        expect(String(toolOutput(full)).length).toBeGreaterThan(100_000)
      }),
    ),
  )

  it.live(
    "prunes older tool outputs within a single turn beyond the protect window",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const storage = yield* Storage.Service
        const info = yield* ssn.create({})
        const user = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: info.id,
          type: "text",
          text: "explore",
        })
        const toolPartIDs: string[] = []
        for (let i = 0; i < 10; i++) {
          const assistant: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: user.id,
            time: { created: Date.now(), completed: Date.now() },
            finish: "end_turn",
          }
          yield* ssn.updateMessage(assistant)
          const part = yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: info.id,
            type: "tool",
            callID: crypto.randomUUID(),
            tool: "read",
            state: {
              status: "completed",
              input: {},
              output: "x".repeat(20_000),
              title: "done",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
          toolPartIDs.push(part.id)
        }

        // 10 uniform 5k-token outputs: newest 40k stay intact, oldest ~10k prune.
        const result = yield* compact.prune({ sessionID: info.id, force: true })
        expect(result.pruned).toBe(2)

        const stored = yield* storage
          .read<{ partIDs?: string[] }>(["compacted_tool_session", info.id])
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        const compacted = new Set(stored?.partIDs ?? [])
        expect(compacted.has(toolPartIDs[0]!)).toBe(true)
        expect(compacted.has(toolPartIDs[1]!)).toBe(true)
        expect(compacted.has(toolPartIDs[9]!)).toBe(false)
      }),
    ),
  )

  it.live(
    "skips tool outputs hidden behind a completed compaction marker",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const storage = yield* Storage.Service
        const info = yield* ssn.create({})

        const mkToolTurn = (text: string, output: string) =>
          Effect.gen(function* () {
            const user = yield* ssn.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: info.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() },
            })
            yield* ssn.updatePart({
              id: PartID.ascending(),
              messageID: user.id,
              sessionID: info.id,
              type: "text",
              text,
            })
            const assistant: MessageV2.Assistant = {
              id: MessageID.ascending(),
              role: "assistant",
              sessionID: info.id,
              mode: "build",
              agent: "build",
              path: { cwd: dir, root: dir },
              cost: 0,
              tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ref.modelID,
              providerID: ref.providerID,
              parentID: user.id,
              time: { created: Date.now(), completed: Date.now() },
              finish: "stop",
            }
            yield* ssn.updateMessage(assistant)
            return yield* ssn.updatePart({
              id: PartID.ascending(),
              messageID: assistant.id,
              sessionID: info.id,
              type: "tool",
              callID: crypto.randomUUID(),
              tool: "read",
              state: {
                status: "completed",
                input: {},
                output,
                title: "done",
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
            })
          })

        // Old turn with a big output, then a completed compaction pair hiding it.
        const hiddenPart = yield* mkToolTurn("old", "x".repeat(200_000))
        const markerMsg = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: markerMsg.id,
          sessionID: info.id,
          type: "compaction",
          auto: true,
        })
        yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: info.id,
          mode: "compaction",
          agent: "compaction",
          parentID: markerMsg.id,
          summary: true,
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        })

        // New turn with an equally big output on the wire.
        const visiblePart = yield* mkToolTurn("new", "y".repeat(200_000))

        // Only the visible output prunes; the hidden one never reaches the
        // wire so compressing it would only inflate the report.
        const result = yield* compact.prune({ sessionID: info.id, force: true })
        expect(result.pruned).toBe(1)

        const stored = yield* storage
          .read<{ partIDs?: string[] }>(["compacted_tool_session", info.id])
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        const compacted = new Set(stored?.partIDs ?? [])
        expect(compacted.has(visiblePart.id)).toBe(true)
        expect(compacted.has(hiddenPart.id)).toBe(false)
      }),
    ),
  )
})

describe("session.compaction.truncate", () => {
  it.live(
    "cuts older messages, appends a marker, and keeps the tail in filterCompacted",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        const users: MessageV2.User[] = []
        for (const text of ["first", "second", "third"]) {
          const user = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          users.push(user)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: info.id,
            type: "text",
            text,
          })
          const assistant: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { output: 10, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: user.id,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
          }
          yield* ssn.updateMessage(assistant)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: info.id,
            type: "text",
            text: `reply to ${text}`,
          })
        }

        const result = yield* compact.truncate({
          sessionID: info.id,
          agent: "build",
          model: ref,
          keepMessages: 4,
        })
        // turn 1 (first + reply) removed; turns 2-3 kept
        expect(result.messages).toBe(2)
        expect(result.tokens).toBeGreaterThan(0)
        expect(result.keptMessages).toBeGreaterThanOrEqual(3)

        const msgs = yield* ssn.messages({ sessionID: info.id })
        // filterCompacted consumes stream-order (newest-first) messages, same
        // as the production prompt loop does.
        const filtered = MessageV2.filterCompacted(msgs.slice().reverse())
        // The kept tail survives in the model context; the removed head does not.
        expect(filtered.some((msg) => msg.info.id === users[1]!.id)).toBe(true)
        expect(filtered.some((msg) => msg.info.id === users[0]!.id)).toBe(false)

        const marker = filtered.find(
          (msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction"),
        )
        expect(marker).toBeDefined()
        const markerPart = marker!.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")
        expect(markerPart?.truncated).toBe(true)
        expect(markerPart?.tail_start_id).toBe(users[1]!.id)
        expect(markerPart?.removedMessages).toBe(2)
        expect(markerPart?.removedTokens).toBeGreaterThan(0)
        // No synthetic summary: the tail itself is the new history.
        const summaryMsg = filtered.find(
          (msg): msg is MessageV2.WithParts & { info: MessageV2.Assistant } =>
            msg.info.role === "assistant" && msg.info.summary === true,
        )
        expect(summaryMsg).toBeUndefined()
      }),
    ),
  )

  it.live("returns zeros when there is nothing to cut", provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const compact = yield* SessionCompaction.Service
      const ssn = yield* SessionNs.Service
      const info = yield* ssn.create({})
      const user = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: info.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID: info.id,
        type: "text",
        text: "only turn",
      })

      const result = yield* compact.truncate({ sessionID: info.id, agent: "build", model: ref })
      expect(result.messages).toBe(0)
      expect(result.tokens).toBe(0)
    }),
  ))

  it.live(
    "cuts a token-heavy session to the default window even with few messages",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const users: MessageV2.User[] = []
        for (let i = 0; i < 10; i++) {
          const tag = String(i).padStart(3, "0")
          const user = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          users.push(user)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: info.id,
            type: "text",
            text: `turn ${tag} ${"x".repeat(8000)}`,
          })
          const assistant: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { output: 10, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: user.id,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
          }
          yield* ssn.updateMessage(assistant)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: info.id,
            type: "text",
            text: `reply ${tag} ${"y".repeat(8000)}`,
          })
        }

        // 20 messages (~20k tokens): above the minimum budget, so the default
        // ~25% window cuts instead of reporting nothing.
        const result = yield* compact.truncate({ sessionID: info.id, agent: "build", model: ref })
        expect(result.messages).toBeGreaterThan(0)
        expect(result.messages + result.keptMessages).toBe(20)

        const msgs = yield* ssn.messages({ sessionID: info.id })
        const filtered = MessageV2.filterCompacted(msgs.slice().reverse())
        expect(filtered.some((msg) => msg.info.id === users[0]!.id)).toBe(false)
        expect(filtered.some((msg) => msg.info.id === users[9]!.id)).toBe(true)
        const marker = filtered.find(
          (msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction"),
        )
        const markerPart = marker!.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")
        expect(markerPart?.truncated).toBe(true)
      }),
    ),
  )

  it.live(
    "honors an explicit ratio override",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        for (let i = 0; i < 30; i++) {
          const tag = String(i).padStart(3, "0")
          const user = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: info.id,
            type: "text",
            text: `turn ${tag}`,
          })
          const assistant: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { output: 10, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: user.id,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
          }
          yield* ssn.updateMessage(assistant)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: info.id,
            type: "text",
            text: `reply ${tag}`,
          })
        }

        // ratio is a token fraction: uniform messages keep about half.
        const result = yield* compact.truncate({ sessionID: info.id, agent: "build", model: ref, ratio: 0.5 })
        expect(result.messages).toBeGreaterThan(0)
        expect(result.messages + result.keptMessages).toBe(60)
        expect(result.keptMessages).toBeGreaterThanOrEqual(28)
        expect(result.keptMessages).toBeLessThanOrEqual(32)
      }),
    ),
  )

  it.live("ignores tool outputs hidden behind a summary boundary", provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const compact = yield* SessionCompaction.Service
      const ssn = yield* SessionNs.Service
      const info = yield* ssn.create({})

      // Older turn with a big tool output…
      const first = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: info.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: first.id,
        sessionID: info.id,
        type: "text",
        text: "first",
      })
      const toolMsg: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        sessionID: info.id,
        mode: "build",
        agent: "build",
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        parentID: first.id,
        time: { created: Date.now() },
        finish: "end_turn",
      }
      yield* ssn.updateMessage(toolMsg)
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: toolMsg.id,
        sessionID: info.id,
        type: "tool",
        callID: crypto.randomUUID(),
        tool: "bash",
        state: {
          status: "completed",
          input: {},
          output: "x".repeat(200_000),
          title: "done",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      })

      // …then a completed compaction pair, then newer turns. The hidden tool
      // output never reaches the wire, so prune must leave it alone.
      const markerMsg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: info.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({
        id: PartID.ascending(),
        messageID: markerMsg.id,
        sessionID: info.id,
        type: "compaction",
        auto: true,
      })
      yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID: info.id,
        mode: "compaction",
        agent: "compaction",
        parentID: markerMsg.id,
        summary: true,
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })

      for (const text of ["second", "third"]) {
        const msg = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: info.id,
          type: "text",
          text,
        })
      }

      const result = yield* compact.prune({ sessionID: info.id })
      expect(result.pruned).toBe(0)
      expect(result.tokens).toBe(0)
    }),
  ))
})

describe("session.compaction.process", () => {
  test("throws when parent is not a user message", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const msg = await user(session.id, "hello")
        const reply = await assistant(session.id, msg.id, tmp.path)
        const rt = runtime("continue")
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          await expect(
            rt.runPromise(
              SessionCompaction.Service.use((svc) =>
                svc.process({
                  parentID: reply.id,
                  messages: msgs,
                  sessionID: session.id,
                  auto: false,
                }),
              ),
            ),
          ).rejects.toThrow(`Compaction parent must be a user message: ${reply.id}`)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("publishes compacted event on continue", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const msg = await user(session.id, "hello")
        const msgs = await svc.messages({ sessionID: session.id })
        const done = defer()
        let seen = false
        const rt = runtime("continue", Plugin.defaultLayer, wide())
        let unsub: (() => void) | undefined
        try {
          unsub = await rt.runPromise(
            Bus.Service.use((svc) =>
              svc.subscribeCallback(SessionCompaction.Event.Compacted, (evt) => {
                if (evt.properties.sessionID !== session.id) return
                seen = true
                done.resolve()
              }),
            ),
          )

          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          await Promise.race([
            done.promise,
            wait(500).then(() => {
              throw new Error("timed out waiting for compacted event")
            }),
          ])
          expect(result).toBe("continue")
          expect(seen).toBe(true)
        } finally {
          unsub?.()
          await rt.dispose()
        }
      },
    })
  })

  test("marks summary message as errored on compact result", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const msg = await user(session.id, "hello")
        const rt = runtime("compact", Plugin.defaultLayer, wide())
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const summary = (await svc.messages({ sessionID: session.id })).find(
            (msg) => msg.info.role === "assistant" && msg.info.summary,
          )

          expect(result).toBe("stop")
          expect(summary?.info.role).toBe("assistant")
          if (summary?.info.role === "assistant") {
            expect(summary.info.finish).toBe("error")
            expect(JSON.stringify(summary.info.error)).toContain("Session too large to compact")
          }
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("adds synthetic continue prompt when auto is enabled", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const msg = await user(session.id, "hello")
        const rt = runtime("continue", Plugin.defaultLayer, wide())
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: true,
              }),
            ),
          )

          const all = await svc.messages({ sessionID: session.id })
          const last = all.at(-1)

          expect(result).toBe("continue")
          expect(last?.info.role).toBe("user")
          expect(last?.parts[0]).toMatchObject({
            type: "text",
            synthetic: true,
            metadata: { compaction_continue: true },
          })
          if (last?.parts[0]?.type === "text") {
            expect(last.parts[0].text).toContain("Continue if you have next steps")
          }
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("persists tail_start_id for retained recent turns", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        await user(session.id, "first")
        const keep = await user(session.id, "second")
        await user(session.id, "third")
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        const rt = runtime(
          "continue",
          Plugin.defaultLayer,
          wide(),
          cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }),
        )
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const part = await lastCompactionPart(session.id)
          expect(part?.type).toBe("compaction")
          expect(part?.tail_start_id).toBe(keep.id)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("shrinks retained tail to fit preserve token budget", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        await user(session.id, "first")
        await user(session.id, "x".repeat(2_000))
        const keep = await user(session.id, "tiny")
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        const rt = runtime("continue", Plugin.defaultLayer, wide(), cfg({ tail_turns: 2, preserve_recent_tokens: 100 }))
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const part = await lastCompactionPart(session.id)
          expect(part?.type).toBe("compaction")
          expect(part?.tail_start_id).toBe(keep.id)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("falls back to full summary when even one recent turn exceeds preserve token budget", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        await user(session.id, "first")
        await user(session.id, "y".repeat(2_000))
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        const rt = liveRuntime(stub.layer, wide(), cfg({ tail_turns: 1, preserve_recent_tokens: 20 }))
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const part = await lastCompactionPart(session.id)
          expect(part?.type).toBe("compaction")
          expect(part?.tail_start_id).toBeUndefined()
          expect(captured).toContain("yyyy")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("falls back to full summary when retained tail media exceeds preserve token budget", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        await user(session.id, "older")
        const recent = await user(session.id, "recent image turn")
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: recent.id,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          filename: "big.png",
          url: `data:image/png;base64,${"a".repeat(4_000)}`,
        })
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        const rt = liveRuntime(stub.layer, wide(), cfg({ tail_turns: 1, preserve_recent_tokens: 100 }))
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const part = await lastCompactionPart(session.id)
          expect(part?.type).toBe("compaction")
          expect(part?.tail_start_id).toBeUndefined()
          expect(captured).toContain("recent image turn")
          expect(captured).toContain("Attached image/png: big.png")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("summarizes the full visible segment before starting a fresh compacted segment", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        await user(session.id, "older")
        const recent = await user(session.id, "recent turn")
        const large = await assistant(session.id, recent.id, tmp.path)
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: large.id,
          sessionID: session.id,
          type: "text",
          text: "z".repeat(2_000),
        })
        const keep = await assistant(session.id, recent.id, tmp.path)
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: keep.id,
          sessionID: session.id,
          type: "text",
          text: "keep tail",
        })
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        const rt = liveRuntime(stub.layer, wide(), cfg({ tail_turns: 1, preserve_recent_tokens: 100 }))
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const part = await lastCompactionPart(session.id)
          expect(part?.type).toBe("compaction")
          expect(part?.tail_start_id).toBe(keep.id)
          expect(captured).toContain("zzzz")
          expect(captured).toContain("keep tail")

          const filtered = MessageV2.filterCompacted(MessageV2.stream(session.id))
          expect(filtered.map((msg) => msg.info.id)).toEqual([parent!, expect.any(String)])
          expect(filtered[1]?.info.role).toBe("assistant")
          expect(filtered[1]?.info.role === "assistant" ? filtered[1].info.summary : false).toBe(true)
          expect(filtered.map((msg) => msg.info.id)).not.toContain(large.id)
          expect(filtered.map((msg) => msg.info.id)).not.toContain(keep.id)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("allows plugins to disable synthetic continue prompt", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const msg = await user(session.id, "hello")
        const rt = runtime("continue", autocontinue(false), wide())
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: true,
              }),
            ),
          )

          const all = await svc.messages({ sessionID: session.id })
          const last = all.at(-1)

          expect(result).toBe("continue")
          expect(last?.info.role).toBe("assistant")
          expect(
            all.some(
              (msg) =>
                msg.info.role === "user" &&
                msg.parts.some(
                  (part) =>
                    part.type === "text" && part.synthetic && part.text.includes("Continue if you have next steps"),
                ),
            ),
          ).toBe(false)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("replays the prior user turn on overflow when earlier context exists", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        await user(session.id, "root")
        const replay = await user(session.id, "image")
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: replay.id,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          filename: "cat.png",
          url: "https://example.com/cat.png",
        })
        const msg = await user(session.id, "current")
        const rt = runtime("continue", Plugin.defaultLayer, wide())
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const result = await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: true,
                overflow: true,
              }),
            ),
          )

          const last = (await svc.messages({ sessionID: session.id })).at(-1)

          expect(result).toBe("continue")
          expect(last?.info.role).toBe("user")
          expect(last?.parts[0]?.type).toBe("text")
          if (last?.parts[0]?.type === "text") {
            expect(last.parts[0].text).toBe("current")
          }
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("falls back to overflow guidance when no replayable turn exists", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        // No user messages at all (only possible if session is corrupted or synthetic)
        const msg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: MessageID.ascending(), // non-existent
          time: { created: Date.now() },
        }
        await svc.updateMessage(msg)

        const rt = runtime("continue", Plugin.defaultLayer, wide())
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const result = await rt.runPromise(
            Effect.gen(function* () {
              const exit = yield* SessionCompaction.Service.use((svc) =>
                svc.process({
                  parentID: msg.id,
                  messages: msgs,
                  sessionID: session.id,
                  auto: true,
                  overflow: true,
                }),
              ).pipe(Effect.exit)
              return Exit.isSuccess(exit) ? "continue" : "stop"
            }),
          )

          expect(result).toBe("stop")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("stops quickly when aborted during retry backoff", async () => {
    const stub = llm()
    const ready = defer()
    stub.push(
      Stream.fromAsyncIterable(
        {
          async *[Symbol.asyncIterator]() {
            yield { type: "start" } as LLM.Event
            throw new APICallError({
              message: "boom",
              url: "https://example.com/v1/chat/completions",
              requestBodyValues: {},
              statusCode: 503,
              responseHeaders: { "retry-after-ms": "10000" },
              responseBody: '{"error":"boom"}',
              isRetryable: true,
            })
          },
        },
        (err) => err,
      ),
    )

    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const msg = await user(session.id, "hello")
        const msgs = await svc.messages({ sessionID: session.id })
        const abort = new AbortController()
        const rt = liveRuntime(stub.layer, wide())
        let off: (() => void) | undefined
        let run: Promise<"continue" | "stop"> | undefined
        try {
          off = await rt.runPromise(
            Bus.Service.use((svc) =>
              svc.subscribeCallback(SessionStatus.Event.Status, (evt) => {
                if (evt.properties.sessionID !== session.id) return
                if (evt.properties.status.type !== "retry") return
                ready.resolve()
              }),
            ),
          )

          run = rt
            .runPromiseExit(
              SessionCompaction.Service.use((svc) =>
                svc.process({
                  parentID: msg.id,
                  messages: msgs,
                  sessionID: session.id,
                  auto: false,
                }),
              ),
              { signal: abort.signal },
            )
            .then((exit) => {
              if (Exit.isFailure(exit)) {
                if (Cause.hasInterrupts(exit.cause) && abort.signal.aborted) return "stop"
                throw Cause.squash(exit.cause)
              }
              return exit.value
            })

          await Promise.race([
            ready.promise,
            wait(1000).then(() => {
              throw new Error("timed out waiting for retry status")
            }),
          ])

          const start = Date.now()
          abort.abort()
          const result = await Promise.race([
            run.then((value) => ({ kind: "done" as const, value, ms: Date.now() - start })),
            wait(250).then(() => ({ kind: "timeout" as const })),
          ])

          expect(result.kind).toBe("done")
          if (result.kind === "done") {
            expect(result.value).toBe("stop")
            expect(result.ms).toBeLessThan(250)
          }
        } finally {
          off?.()
          abort.abort()
          await rt.dispose()
          await run?.catch(() => undefined)
        }
      },
    })
  })

  test("does not leave a summary assistant when aborted before processor setup", async () => {
    const ready = defer()

    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const msg = await user(session.id, "hello")
        const msgs = await svc.messages({ sessionID: session.id })
        const abort = new AbortController()
        const rt = runtime("continue", plugin(ready), wide())
        let run: Promise<"continue" | "stop"> | undefined
        try {
          run = rt
            .runPromiseExit(
              SessionCompaction.Service.use((svc) =>
                svc.process({
                  parentID: msg.id,
                  messages: msgs,
                  sessionID: session.id,
                  auto: false,
                }),
              ),
              { signal: abort.signal },
            )
            .then((exit) => {
              if (Exit.isFailure(exit)) {
                if (Cause.hasInterrupts(exit.cause) && abort.signal.aborted) return "stop"
                throw Cause.squash(exit.cause)
              }
              return exit.value
            })

          await Promise.race([
            ready.promise,
            wait(1000).then(() => {
              throw new Error("timed out waiting for compaction hook")
            }),
          ])

          abort.abort()
          expect(await run).toBe("stop")

          const all = await svc.messages({ sessionID: session.id })
          expect(all.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
        } finally {
          abort.abort()
          await rt.dispose()
          await run?.catch(() => undefined)
        }
      },
    })
  })

  test("does not allow tool calls while generating the summary", async () => {
    const stub = llm()
    stub.push(
      Stream.make(
        { type: "start" } satisfies LLM.Event,
        { type: "tool-input-start", id: "call-1", toolName: "_noop" } satisfies LLM.Event,
        { type: "tool-call", toolCallId: "call-1", toolName: "_noop", input: {} } satisfies LLM.Event,
        {
          type: "finish-step",
          finishReason: "tool-calls",
          rawFinishReason: "tool_calls",
          response: { id: "res", modelId: "test-model", timestamp: new Date() },
          providerMetadata: undefined,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            inputTokenDetails: {
              noCacheTokens: undefined,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokenDetails: {
              textTokens: undefined,
              reasoningTokens: undefined,
            },
          },
        } satisfies LLM.Event,
        {
          type: "finish",
          finishReason: "tool-calls",
          rawFinishReason: "tool_calls",
          totalUsage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            inputTokenDetails: {
              noCacheTokens: undefined,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokenDetails: {
              textTokens: undefined,
              reasoningTokens: undefined,
            },
          },
        } satisfies LLM.Event,
      ),
    )

    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const msg = await user(session.id, "hello")
        const rt = liveRuntime(stub.layer, wide())
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: msg.id,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const summary = (await svc.messages({ sessionID: session.id })).find(
            (item) => item.info.role === "assistant" && item.info.summary,
          )

          expect(summary?.info.role).toBe("assistant")
          expect(summary?.parts.some((part) => part.type === "tool")).toBe(false)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("summarizes the full visible segment input without injecting the compaction seed prompt", async () => {
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )

    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        await user(session.id, "older context")
        await user(session.id, "keep this turn")
        await user(session.id, "and this one too")
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        const rt = liveRuntime(stub.layer, wide())
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          expect(captured).toContain("older context")
          expect(captured).toContain("keep this turn")
          expect(captured).toContain("and this one too")
          expect(captured).not.toContain(
            "Use the following assistant summary as the conversation context carried forward from the previous chat.",
          )
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("excludes tool output from compaction summary input", async () => {
    const stub = llm()
    let captured = ""
    stub.push(
      reply("summary", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )

    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const first = await user(session.id, "run something")
        const replyMsg = await assistant(session.id, first.id, tmp.path)
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: replyMsg.id,
          sessionID: session.id,
          type: "text",
          text: "Ran the command",
        })
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: replyMsg.id,
          sessionID: session.id,
          type: "tool",
          callID: crypto.randomUUID(),
          tool: "bash",
          state: {
            status: "completed",
            input: { cmd: "echo hi" },
            output: "SECRET_TOOL_OUTPUT",
            title: "done",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        await user(session.id, "continue")
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        const rt = liveRuntime(stub.layer, wide())
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          expect(captured).toContain("run something")
          expect(captured).toContain("Ran the command")
          expect(captured).toContain("continue")
          expect(captured).not.toContain("SECRET_TOOL_OUTPUT")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("anchors repeated compactions with the previous summary", async () => {
    const stub = llm()
    let captured = ""
    stub.push(reply("summary one"))
    stub.push(
      reply("summary two", (input) => {
        captured = JSON.stringify(input.messages)
      }),
    )

    await using tmp = await tmpdir({ git: true })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        await user(session.id, "older context")
        await user(session.id, "keep this turn")
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        const rt = liveRuntime(stub.layer, wide())
        try {
          let msgs = await svc.messages({ sessionID: session.id })
          let parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          await user(session.id, "latest turn")
          await SessionCompaction.create({
            sessionID: session.id,
            agent: "build",
            model: ref,
            auto: false,
          })

          msgs = MessageV2.filterCompacted(MessageV2.stream(session.id))
          parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          expect(captured).toContain("<previous-summary>")
          expect(captured).toContain("summary one")
          expect(captured.match(/summary one/g)?.length).toBe(1)
          expect(captured).toContain("## Constraints & Preferences")
          expect(captured).toContain("## Progress")
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("repeated compactions keep only the latest compacted segment visible", async () => {
    const stub = llm()
    stub.push(reply("summary one"))
    stub.push(reply("summary two"))
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        const u1 = await user(session.id, "one")
        const u2 = await user(session.id, "two")
        const u3 = await user(session.id, "three")
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        const rt = liveRuntime(stub.layer, wide(), cfg({ tail_turns: 2, preserve_recent_tokens: 10_000 }))
        try {
          let msgs = await svc.messages({ sessionID: session.id })
          let parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const u4 = await user(session.id, "four")
          await SessionCompaction.create({
            sessionID: session.id,
            agent: "build",
            model: ref,
            auto: false,
          })

          msgs = MessageV2.filterCompacted(MessageV2.stream(session.id))
          parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const filtered = MessageV2.filterCompacted(MessageV2.stream(session.id))
          const ids = filtered.map((msg) => msg.info.id)

          expect(ids).not.toContain(u1.id)
          expect(ids).not.toContain(u2.id)
          expect(ids).not.toContain(u3.id)
          expect(ids).not.toContain(u4.id)
          expect(ids).toEqual([parent!, expect.any(String)])
          expect(filtered.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(true)
          expect(
            filtered.some((msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction")),
          ).toBe(true)
        } finally {
          await rt.dispose()
        }
      },
    })
  })

  test("ignores previous summaries when sizing the retained tail", async () => {
    await using tmp = await tmpdir()
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({})
        await user(session.id, "older")
        const keep = await user(session.id, "keep this turn")
        const keepReply = await assistant(session.id, keep.id, tmp.path)
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: keepReply.id,
          sessionID: session.id,
          type: "text",
          text: "keep reply",
        })

        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })
        const firstCompaction = (await svc.messages({ sessionID: session.id })).at(-1)?.info.id
        expect(firstCompaction).toBeTruthy()
        await summaryAssistant(session.id, firstCompaction!, tmp.path, "summary ".repeat(800))

        const recent = await user(session.id, "recent turn")
        const recentReply = await assistant(session.id, recent.id, tmp.path)
        await svc.updatePart({
          id: PartID.ascending(),
          messageID: recentReply.id,
          sessionID: session.id,
          type: "text",
          text: "recent reply",
        })

        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: false,
        })

        const rt = runtime("continue", Plugin.defaultLayer, wide(), cfg({ tail_turns: 2, preserve_recent_tokens: 500 }))
        try {
          const msgs = await svc.messages({ sessionID: session.id })
          const parent = msgs.at(-1)?.info.id
          expect(parent).toBeTruthy()
          await rt.runPromise(
            SessionCompaction.Service.use((svc) =>
              svc.process({
                parentID: parent!,
                messages: msgs,
                sessionID: session.id,
                auto: false,
              }),
            ),
          )

          const part = await lastCompactionPart(session.id)
          expect(part?.type).toBe("compaction")
          expect(part?.tail_start_id).toBe(keep.id)
        } finally {
          await rt.dispose()
        }
      },
    })
  })
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("SessionNs.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: 800,
          cacheReadTokens: 200,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("subtracts cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // AI SDK v6 normalizes inputTokens to include cached tokens for all providers
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: 800,
          cacheReadTokens: 200,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("separates reasoning tokens from output tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: 400,
          reasoningTokens: 100,
        },
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(400)
    expect(result.tokens.reasoning).toBe(100)
    expect(result.tokens.total).toBe(1500)
  })

  test("does not double count reasoning tokens in cost", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 0,
        output: 15,
        cache: { read: 0, write: 0 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 0,
        outputTokens: 1_000_000,
        totalTokens: 1_000_000,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: 750_000,
          reasoningTokens: 250_000,
        },
      },
    })

    expect(result.tokens.output).toBe(750_000)
    expect(result.tokens.reasoning).toBe(250_000)
    expect(result.cost).toBe(15)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "computes total from components for %s models",
    (npm) => {
      const model = createModel({ context: 100_000, output: 32_000, npm })
      // AI SDK v6: inputTokens includes cached tokens for all providers
      const usage = {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: 800,
          cacheReadTokens: 200,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      }
      if (npm === "@ai-sdk/amazon-bedrock") {
        const result = SessionNs.getUsage({
          model,
          usage,
          metadata: {
            bedrock: {
              usage: {
                cacheWriteInputTokens: 300,
              },
            },
          },
        })

        // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
        expect(result.tokens.input).toBe(500)
        expect(result.tokens.cache.read).toBe(200)
        expect(result.tokens.cache.write).toBe(300)
        // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
        expect(result.tokens.total).toBe(1500)
        return
      }

      const result = SessionNs.getUsage({
        model,
        usage,
        metadata: {
          anthropic: {
            cacheCreationInputTokens: 300,
          },
        },
      })

      // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
      expect(result.tokens.input).toBe(500)
      expect(result.tokens.cache.read).toBe(200)
      expect(result.tokens.cache.write).toBe(300)
      // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
      expect(result.tokens.total).toBe(1500)
    },
  )

  test("extracts cache write tokens from vertex metadata key", () => {
    const model = createModel({ context: 100_000, output: 32_000, npm: "@ai-sdk/google-vertex/anthropic" })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: 800,
          cacheReadTokens: 200,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
      metadata: {
        vertex: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.input).toBe(500)
    expect(result.tokens.cache.read).toBe(200)
    expect(result.tokens.cache.write).toBe(300)
  })
})
