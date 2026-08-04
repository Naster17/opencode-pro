import { Config } from "@/config/config"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { BashArity } from "@/permission/arity"
import { Plugin } from "@/plugin"
import { containsPath } from "@/project/instance-context"
import { Shell } from "@/shell/shell"
import { SessionID } from "@/session/schema"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Context, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
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
  action: Schema.Literals(["start", "read", "list", "stop"]).annotate({
    description: "Operation to perform: start, read, list, or stop",
  }),
  threadID: Schema.optional(Schema.String).annotate({ description: "Thread ID for read or stop" }),
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

type Thread = {
  id: string
  sessionID: SessionID
  command: string
  description: string
  cwd: string
  pid: number
  status: "running" | "exited" | "stopped" | "failed"
  startedAt: number
  updatedAt: number
  exitCode?: number | null
  error?: string
  cursor: number
  bytes: number
  chunks: Chunk[]
  handle: ChildProcessHandle
  scope: Scope.Scope
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
  readonly stop: (input: {
    sessionID: SessionID
    threadID: string
    signal?: Schema.Schema.Type<typeof Signal>
  }) => Effect.Effect<Thread, unknown>
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
      }
      s.threads.set(thread.id, thread)
      yield* publish(s, thread.sessionID)

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
            Effect.sync(() => {
              if (thread.status === "stopped") return
              thread.status = "failed"
              thread.error = error.message
              thread.exitCode = null
              thread.updatedAt = Date.now()
            }).pipe(Effect.andThen(publish(s, thread.sessionID))),
          onSuccess: (code) =>
            Effect.sync(() => {
              if (thread.status === "stopped") return
              thread.status = "exited"
              thread.exitCode = code
              thread.updatedAt = Date.now()
            }).pipe(Effect.andThen(publish(s, thread.sessionID))),
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
      yield* publish(yield* InstanceState.get(state), thread.sessionID)
      return thread
    })

    return { start, get, list, stop } satisfies Interface
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

      const out = preview(output(thread))
      return {
        title: `Started ${thread.description}`,
        output: [
          `Started shell thread ${thread.id}`,
          `status: ${thread.status}`,
          `pid: ${thread.pid}`,
          `cursor: ${thread.cursor}`,
          "",
          out,
        ].join("\n"),
        metadata: {
          action: "start",
          threadID: thread.id,
          status: thread.status,
          pid: thread.pid,
          cursor: thread.cursor,
          output: out,
          description: thread.description,
        },
      }
    })

    const read = Effect.fn("ShellThreadTool.read")(function* (params: Parameters, ctx: Tool.Context) {
      if (!params.threadID) throw new Error("shell_thread read requires threadID")
      const thread = yield* threads.get({ sessionID: ctx.sessionID, threadID: params.threadID })
      const out = preview(output(thread, params.since))
      return {
        title: `Read ${thread.description}`,
        output: [`Shell thread ${thread.id}`, `status: ${thread.status}`, `cursor: ${thread.cursor}`, "", out].join(
          "\n",
        ),
        metadata: {
          action: "read",
          threadID: thread.id,
          status: thread.status,
          exit: thread.exitCode,
          cursor: thread.cursor,
          output: out,
          description: thread.description,
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
      const out = `Stopped shell thread ${thread.id}\nstatus: ${thread.status}`
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
        }
      },
    }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer), Layer.provide(Bus.layer))

export * as ShellThread from "./shell_thread"
