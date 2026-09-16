import { Config } from "@/config/config"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import type { TaskPromptOps } from "@/tool/subagent"
import { Identifier } from "@/id/id"
import { BashArity } from "@/permission/arity"
import { Plugin } from "@/plugin"
import { containsPath } from "@/project/instance-context"
import { Shell } from "@/shell/shell"
import { SessionID } from "@/session/schema"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Context, Deferred, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import path from "path"
import * as Tool from "./tool"
import { ShellID } from "./shell/id"
import DESCRIPTION from "./shell_thread.txt"

const MAX_BYTES = 256 * 1024
const MAX_CHUNKS = 2_000

const Signal = Schema.Literals(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"])
export const ThreadSnapshot = Schema.Struct({
  threadID: Schema.String,
  status: Schema.Literals(["running", "exited", "stopped", "failed"]),
  description: Schema.String,
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type ThreadSnapshot = Schema.Schema.Type<typeof ThreadSnapshot>

const DETAIL_TAIL_CHARS = 16_000
const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const MAX_WAIT_TIMEOUT_MS = 300_000

export const ThreadDetail = Schema.Struct({
  threadID: Schema.String,
  status: Schema.Literals(["running", "exited", "stopped", "failed"]),
  description: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  pid: Schema.Finite,
  startedAt: Schema.Finite,
  updatedAt: Schema.Finite,
  exitCode: Schema.optional(Schema.NullOr(Schema.Finite)),
  error: Schema.optional(Schema.String),
  cursor: Schema.Finite,
  bytes: Schema.Finite,
  outputTail: Schema.String,
})
export type ThreadDetail = Schema.Schema.Type<typeof ThreadDetail>
export const Event = {
  Updated: BusEvent.define(
    "shell_thread.updated",
    Schema.Struct({
      sessionID: SessionID,
      threads: Schema.Array(ThreadSnapshot),
    }),
  ),
}
const Parameters = Schema.Struct({
  action: Schema.Literals(["start", "read", "list", "stop", "wait"]).annotate({
    description: "Operation to perform: start, read, list, stop, or wait",
  }),
  threadID: Schema.optional(Schema.String).annotate({ description: "Thread ID for read, stop, or single-thread wait" }),
  threadIDs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Thread IDs for wait. Uses threadID when omitted.",
  }),
  mode: Schema.optional(Schema.Literals(["any", "all"])).annotate({
    description: "Wait mode for multiple threads: any returns when the first completes, all waits for every thread. Defaults to all.",
  }),
  timeoutMs: Schema.optional(Schema.Number).annotate({
    description: "Max time to wait in milliseconds for wait or start with wait. Defaults to 30000, max 300000.",
  }),
  notify: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true and the thread is still running after timeoutMs, return immediately and post a synthetic followup message when it completes.",
  }),
  notifyMessage: Schema.optional(Schema.String).annotate({
    description: "Custom prefix for the synthetic followup message posted when notify fires.",
  }),
  wait: Schema.optional(Schema.Boolean).annotate({
    description: "When true with action start, wait for completion in the same call.",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "Shell command to run when action is start" }),
  description: Schema.optional(Schema.String).annotate({ description: "Short description for start" }),
  workdir: Schema.optional(Schema.String).annotate({ description: "Working directory for start" }),
  since: Schema.optional(Schema.Number).annotate({ description: "Read output chunks after this cursor" }),
  signal: Schema.optional(Signal).annotate({ description: "Signal to use for stop. Defaults to SIGTERM" }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

type Chunk = {
  seq: number
  text: string
  size: number
  time: number
}

type ThreadStatus = "running" | "exited" | "stopped" | "failed"

type Thread = {
  id: string
  sessionID: SessionID
  command: string
  description: string
  cwd: string
  pid: number
  status: ThreadStatus
  startedAt: number
  updatedAt: number
  exitCode?: number | null
  error?: string
  cursor: number
  bytes: number
  chunks: Chunk[]
  handle: ChildProcessHandle
  scope: Scope.Scope
  done: Deferred.Deferred<void>
}

type WaitResult = {
  thread: Thread
  completed: boolean
}

type State = {
  threads: Map<string, Thread>
}

function preview(text: string) {
  if (!text.trim()) return "(no output)"
  return text.trim()
}

function append(thread: Thread, text: string) {
  const size = Buffer.byteLength(text, "utf-8")
  thread.cursor += 1
  thread.updatedAt = Date.now()
  thread.bytes += size
  thread.chunks.push({ seq: thread.cursor, text, size, time: thread.updatedAt })
  while ((thread.bytes > MAX_BYTES || thread.chunks.length > MAX_CHUNKS) && thread.chunks.length > 1) {
    const first = thread.chunks.shift()
    if (first) thread.bytes -= first.size
  }
}

function output(thread: Thread, since?: number) {
  return thread.chunks
    .filter((chunk) => since === undefined || chunk.seq > since)
    .map((chunk) => chunk.text)
    .join("")
}

function summary(thread: Thread) {
  const exit = thread.exitCode === undefined ? "" : ` exit=${thread.exitCode}`
  return `${thread.id} ${thread.status}${exit} pid=${thread.pid} ${thread.description}`
}

function commandSpec(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

export interface Interface {
  readonly start: (input: {
    sessionID: SessionID
    command: string
    description: string
    cwd: string
    env: NodeJS.ProcessEnv
    shell: string
  }) => Effect.Effect<Thread, unknown>
  readonly get: (input: { sessionID: SessionID; threadID: string }) => Effect.Effect<Thread>
  readonly list: (sessionID: SessionID) => Effect.Effect<Thread[]>
  readonly inspect: (input: { sessionID: SessionID; tail?: number }) => Effect.Effect<ThreadDetail[]>
  readonly stop: (input: {
    sessionID: SessionID
    threadID: string
    signal?: Schema.Schema.Type<typeof Signal>
  }) => Effect.Effect<Thread, unknown>
  readonly wait: (input: {
    sessionID: SessionID
    threadIDs: string[]
    mode?: "any" | "all"
    timeoutMs?: number
  }) => Effect.Effect<WaitResult[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellThread") {}

export const layer: Layer.Layer<Service, never, ChildProcessSpawner> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("ShellThread.state")(function* () {
        const threads = new Map<string, Thread>()
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            Array.from(threads.values()),
            (thread) => Scope.close(thread.scope, Exit.void).pipe(Effect.ignore),
            { concurrency: "unbounded" },
          ),
        )
        return { threads }
      }),
    )

    const snapshot = (thread: Thread): ThreadSnapshot => ({
      threadID: thread.id,
      status: thread.status,
      description: thread.description,
      startedAt: thread.startedAt,
      updatedAt: thread.updatedAt,
    })

    const publish = Effect.fn("ShellThread.publish")(function* (s: State, sessionID: SessionID) {
      yield* bus.publish(Event.Updated, {
        sessionID,
        threads: Array.from(s.threads.values())
          .filter((thread) => thread.sessionID === sessionID && thread.status === "running")
          .map(snapshot),
      })
    })

    const get = Effect.fn("ShellThread.get")(function* (input: { sessionID: SessionID; threadID: string }) {
      const thread = (yield* InstanceState.get(state)).threads.get(input.threadID)
      if (!thread || thread.sessionID !== input.sessionID) throw new Error(`Shell thread not found: ${input.threadID}`)
      return thread
    })

    const list = Effect.fn("ShellThread.list")(function* (sessionID: string) {
      return Array.from((yield* InstanceState.get(state)).threads.values()).filter(
        (thread) => thread.sessionID === sessionID,
      )
    })

    const inspect = Effect.fn("ShellThread.inspect")(function* (input: { sessionID: SessionID; tail?: number }) {
      const items = yield* list(input.sessionID)
      const tail = input.tail ?? DETAIL_TAIL_CHARS
      return items.map(
        (thread): ThreadDetail => ({
          threadID: thread.id,
          status: thread.status,
          description: thread.description,
          command: thread.command,
          cwd: thread.cwd,
          pid: thread.pid,
          startedAt: thread.startedAt,
          updatedAt: thread.updatedAt,
          ...(thread.exitCode !== undefined ? { exitCode: thread.exitCode } : {}),
          ...(thread.error ? { error: thread.error } : {}),
          cursor: thread.cursor,
          bytes: thread.bytes,
          outputTail: output(thread).slice(-tail),
        }),
      )
    })

    const start = Effect.fn("ShellThread.start")(function* (input: {
      sessionID: SessionID
      command: string
      description: string
      cwd: string
      env: NodeJS.ProcessEnv
      shell: string
    }) {
      const s = yield* InstanceState.get(state)
      const scope = yield* Scope.make()
      const handle = yield* Scope.provide(scope)(
        spawner.spawn(commandSpec(input.shell, input.command, input.cwd, input.env)),
      )
      const done = yield* Deferred.make<void>()
      const thread: Thread = {
        id: Identifier.create("sht", "ascending"),
        sessionID: input.sessionID,
        command: input.command,
        description: input.description,
        cwd: input.cwd,
        pid: Number(handle.pid),
        status: "running",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        cursor: 0,
        bytes: 0,
        chunks: [],
        handle,
        scope,
        done,
      }
      s.threads.set(thread.id, thread)
      yield* publish(s, thread.sessionID)

      const settle = (update: () => void) =>
        Effect.gen(function* () {
          update()
          yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
          yield* publish(yield* InstanceState.get(state), thread.sessionID)
        })

      yield* Scope.provide(scope)(
        Stream.runForEach(Stream.decodeText(handle.all), (chunk) => Effect.sync(() => append(thread, chunk))).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              thread.status = thread.status === "running" ? "failed" : thread.status
              thread.error = String(cause)
              thread.updatedAt = Date.now()
            }),
          ),
          Effect.forkScoped,
        ),
      )

      yield* handle.exitCode.pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            settle(() => {
              if (thread.status === "stopped") return
              thread.status = "failed"
              thread.error = error.message
              thread.exitCode = null
              thread.updatedAt = Date.now()
            }),
          onSuccess: (code) =>
            settle(() => {
              if (thread.status === "stopped") return
              thread.status = "exited"
              thread.exitCode = code
              thread.updatedAt = Date.now()
            }),
        }),
        Effect.forkIn(scope),
      )

      return thread
    })

    const stop = Effect.fn("ShellThread.stop")(function* (input: {
      sessionID: SessionID
      threadID: string
      signal?: Schema.Schema.Type<typeof Signal>
    }) {
      const thread = yield* get(input)
      if (thread.status === "running") {
        thread.status = "stopped"
        thread.updatedAt = Date.now()
        yield* thread.handle
          .kill({ killSignal: input.signal ?? "SIGTERM", forceKillAfter: "3 seconds" })
          .pipe(Effect.ignore)
      }
      yield* Scope.close(thread.scope, Exit.void).pipe(Effect.ignore)
      yield* Deferred.succeed(thread.done, undefined).pipe(Effect.ignore)
      yield* publish(yield* InstanceState.get(state), thread.sessionID)
      return thread
    })

    const wait = Effect.fn("ShellThread.wait")(function* (input: {
      sessionID: SessionID
      threadIDs: string[]
      mode?: "any" | "all"
      timeoutMs?: number
    }) {
      const timeout = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
      if (!Number.isFinite(timeout) || timeout < 0) throw new Error(`Invalid timeoutMs: ${input.timeoutMs}`)
      if (timeout > MAX_WAIT_TIMEOUT_MS) throw new Error(`timeoutMs exceeds maximum of ${MAX_WAIT_TIMEOUT_MS} ms`)
      const ids = [...new Set(input.threadIDs)]
      if (ids.length === 0) throw new Error("shell_thread wait requires at least one thread ID")
      const mode = input.mode ?? "all"
      const s = yield* InstanceState.get(state)
      const found = ids.map((id) => {
        const thread = s.threads.get(id)
        if (!thread || thread.sessionID !== input.sessionID) throw new Error(`Shell thread not found: ${id}`)
        return thread
      })
      const pending = found.filter((thread) => thread.status === "running")
      if (pending.length === 0) return found.map((thread) => ({ thread, completed: true }))
      if (mode === "any") {
        yield* Effect.raceAll(pending.map((thread) => Deferred.await(thread.done))).pipe(
          Effect.timeoutOption(`${timeout} millis`),
        )
        return found.map((thread) => ({ thread, completed: thread.status !== "running" }))
      }
      yield* Effect.forEach(pending, (thread) => Deferred.await(thread.done), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.timeoutOption(`${timeout} millis`))
      return found.map((thread) => ({ thread, completed: thread.status !== "running" }))
    })

    return { start, get, list, inspect, stop, wait } satisfies Interface
  }),
)

export const ShellThreadTool = Tool.define<
  typeof Parameters,
  Record<string, unknown>,
  Config.Service | Plugin.Service | Service | AppFileSystem.Service
>(
  "shell_thread",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const threads = yield* Service
    const fs = yield* AppFileSystem.Service

    const resolveCwd = Effect.fn("ShellThreadTool.resolveCwd")(function* (workdir?: string) {
      const instance = yield* InstanceState.context
      if (!workdir) return { cwd: instance.directory }
      const cwd = path.resolve(instance.directory, workdir)
      if (!containsPath(cwd, instance)) {
        const target = (yield* fs.isDir(cwd)) ? cwd : path.dirname(cwd)
        return { cwd, external: target }
      }
      return { cwd }
    })

    const shellEnv = Effect.fn("ShellThreadTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return { ...process.env, ...extra.env }
    })

    const askShell = (ctx: Tool.Context, command: string) => {
      const tokens = command.trim().split(/\s+/).filter(Boolean)
      return ctx.ask({
        permission: ShellID.ToolID,
        patterns: [command],
        always: tokens.length ? [BashArity.prefix(tokens).join(" ") + " *"] : [],
        metadata: {},
      })
    }

    const resolveIDs = (params: Parameters) => {
      const ids = params.threadIDs ?? (params.threadID ? [params.threadID] : [])
      return [...new Set(ids)]
    }

    const waitDetail = (thread: Thread, completed: boolean) => {
      const out = preview(output(thread).slice(-DETAIL_TAIL_CHARS))
      const exit = thread.exitCode === undefined ? "" : `\nexit: ${thread.exitCode}`
      return {
        lines: [`## ${thread.description} (${thread.id})`, `status: ${thread.status}${exit}`, "", out],
        out,
      }
    }

    const abortEffect = (ctx: Tool.Context) =>
      Effect.callback<void>((resume) => {
        if (ctx.abort.aborted) return resume(Effect.void)
        const handler = () => resume(Effect.void)
        ctx.abort.addEventListener("abort", handler, { once: true })
        return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
      })

    const notifyText = (results: WaitResult[], prefix?: string) =>
      [
        prefix ?? "Background shell thread update:",
        ...results.map((result) => {
          const exit = result.thread.exitCode === undefined ? "" : `\nexit: ${result.thread.exitCode}`
          const tail = output(result.thread).slice(-DETAIL_TAIL_CHARS).trim()
          return `## ${result.thread.description} (${result.thread.id})\nstatus: ${result.thread.status}${exit}\n\n${tail || "(no output)"}`
        }),
        "Continue with your task using read/stop as needed.",
      ].join("\n\n")

    const armNotify = Effect.fn("ShellThreadTool.armNotify")(function* (
      ids: string[],
      mode: "any" | "all",
      ctx: Tool.Context,
      prefix?: string,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return
      const bridge = yield* EffectBridge.make()
      const workload = Effect.gen(function* () {
        const results = yield* threads.wait({ sessionID: ctx.sessionID, threadIDs: ids, mode })
        const healthy = results.filter(
          (result) => result.thread.sessionID === ctx.sessionID && result.completed,
        )
        if (healthy.length === 0) return
        yield* Effect.promise(() =>
          bridge.promise(
            Effect.gen(function* () {
              yield* ops.btw({
                sessionID: ctx.sessionID,
                parts: [{ type: "text" as const, text: notifyText(healthy, prefix), synthetic: true }],
              })
            }),
          ),
        )
      }).pipe(Effect.ignore)
      bridge.fork(workload)
    })

    const wait = Effect.fn("ShellThreadTool.wait")(function* (params: Parameters, ctx: Tool.Context) {
      const ids = resolveIDs(params)
      if (ids.length === 0) throw new Error("shell_thread wait requires threadID or threadIDs")
      const mode = params.mode ?? "all"
      const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error(`Invalid timeoutMs: ${params.timeoutMs}`)
      if (timeoutMs > MAX_WAIT_TIMEOUT_MS) throw new Error(`timeoutMs exceeds maximum of ${MAX_WAIT_TIMEOUT_MS} ms`)

      yield* ctx.metadata({ title: `Waiting on ${ids.join(", ")}`, metadata: { action: "wait", threadIDs: ids } })

      const settled = yield* Effect.race(
        threads
          .wait({ sessionID: ctx.sessionID, threadIDs: ids, mode, timeoutMs })
          .pipe(Effect.map((results) => ({ kind: "wait" as const, results }))),
        abortEffect(ctx).pipe(Effect.map(() => ({ kind: "abort" as const, results: undefined }))),
      )
      if (settled.kind === "abort") throw new Error("shell_thread wait aborted")
      const runningCount = settled.results.filter((result) => !result.completed).length
      const timedOut = runningCount > 0
      if (runningCount > 0 && params.notify) yield* armNotify(ids, mode, ctx, params.notifyMessage)

      const lines = settled.results.flatMap((result) => waitDetail(result.thread, result.completed).lines)
      if (runningCount > 0)
        lines.push(
          "",
          `<wait_timeout ms="${timeoutMs}" running="${runningCount}">`,
          "Still running — use read to poll, wait again, or stop to cancel. Never wait on servers, watchers, or other never-ending commands.",
        )
      const out = lines.join("\n")
      return {
        title: timedOut ? `Timed out waiting on ${ids.join(", ")}` : `Waited on ${ids.join(", ")}`,
        output: out,
        metadata: {
          action: "wait",
          timedOut,
          notified: timedOut && params.notify === true,
          mode,
          timeoutMs,
          output: out,
          threads: settled.results.map((result) => ({
            threadID: result.thread.id,
            status: result.thread.status,
            completed: result.completed,
            pid: result.thread.pid,
            cursor: result.thread.cursor,
            exit: result.thread.exitCode,
            output: waitDetail(result.thread, result.completed).out,
            description: result.thread.description,
            command: result.thread.command,
          })),
        },
      }
    })

    const start = Effect.fn("ShellThreadTool.start")(function* (params: Parameters, ctx: Tool.Context) {
      if (!params.command) throw new Error("shell_thread start requires command")
      if (!params.description) throw new Error("shell_thread start requires description")

      const resolved = yield* resolveCwd(params.workdir)
      if (resolved.external) {
        const pattern =
          process.platform === "win32"
            ? AppFileSystem.normalizePathPattern(path.join(resolved.external, "*"))
            : path.join(resolved.external, "*")
        yield* ctx.ask({ permission: "external_directory", patterns: [pattern], always: [pattern], metadata: {} })
      }
      yield* askShell(ctx, params.command)

      const shell = Shell.acceptable((yield* config.get()).shell)
      const thread = yield* threads.start({
        sessionID: ctx.sessionID,
        command: params.command,
        description: params.description,
        cwd: resolved.cwd,
        env: yield* shellEnv(ctx, resolved.cwd),
        shell,
      })

      if (params.wait) {
        return yield* wait(
          {
            ...params,
            action: "wait",
            threadID: thread.id,
            threadIDs: [thread.id],
            timeoutMs: params.timeoutMs,
          },
          ctx,
        )
      }

      const out = preview(output(thread))
      return {
        title: `Started ${thread.description}`,
        output: [`## ${thread.description} (${thread.id})`, `status: ${thread.status}`, `pid: ${thread.pid}`, "", out].join(
          "\n",
        ),
        metadata: {
          action: "start",
          threadID: thread.id,
          status: thread.status,
          pid: thread.pid,
          cursor: thread.cursor,
          output: out,
          description: thread.description,
          command: thread.command,
        },
      }
    })

    const read = Effect.fn("ShellThreadTool.read")(function* (params: Parameters, ctx: Tool.Context) {
      if (!params.threadID) throw new Error("shell_thread read requires threadID")
      const thread = yield* threads.get({ sessionID: ctx.sessionID, threadID: params.threadID })
      const out = preview(output(thread, params.since))
      const exit = thread.exitCode === undefined ? "" : `\nexit: ${thread.exitCode}`
      return {
        title: `Read ${thread.description}`,
        output: [`## ${thread.description} (${thread.id})`, `status: ${thread.status}${exit}`, "", out].join("\n"),
        metadata: {
          action: "read",
          threadID: thread.id,
          status: thread.status,
          exit: thread.exitCode,
          cursor: thread.cursor,
          output: out,
          description: thread.description,
          command: thread.command,
          pid: thread.pid,
        },
      }
    })

    const list = Effect.fn("ShellThreadTool.list")(function* (_params: Parameters, ctx: Tool.Context) {
      const items = yield* threads.list(ctx.sessionID)
      const out = items.length ? items.map(summary).join("\n") : "No shell threads for this session."
      return {
        title: "List shell threads",
        output: out,
        metadata: {
          action: "list",
          count: items.length,
          output: out,
          threads: items.map((thread) => ({
            threadID: thread.id,
            status: thread.status,
            pid: thread.pid,
            cursor: thread.cursor,
            exit: thread.exitCode,
            description: thread.description,
            command: thread.command,
          })),
        },
      }
    })

    const stop = Effect.fn("ShellThreadTool.stop")(function* (params: Parameters, ctx: Tool.Context) {
      if (!params.threadID) throw new Error("shell_thread stop requires threadID")
      const thread = yield* threads.stop({ sessionID: ctx.sessionID, threadID: params.threadID, signal: params.signal })
      const out = [`## ${thread.description} (${thread.id})`, `status: ${thread.status}`].join("\n")
      return {
        title: `Stopped ${thread.description}`,
        output: out,
        metadata: {
          action: "stop",
          threadID: thread.id,
          status: thread.status,
          exit: thread.exitCode,
          output: out,
          description: thread.description,
          command: thread.command,
          pid: thread.pid,
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context) => {
        switch (params.action) {
          case "start":
            return start(params, ctx).pipe(Effect.orDie)
          case "read":
            return read(params, ctx).pipe(Effect.orDie)
          case "list":
            return list(params, ctx).pipe(Effect.orDie)
          case "stop":
            return stop(params, ctx).pipe(Effect.orDie)
          case "wait":
            return wait(params, ctx).pipe(Effect.orDie)
        }
      },
    }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer), Layer.provide(Bus.layer))

export * as ShellThread from "./shell_thread"
