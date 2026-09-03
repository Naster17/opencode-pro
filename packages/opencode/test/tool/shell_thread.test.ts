import { describe, expect, test } from "bun:test"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Truncate } from "@/tool/truncate"
import { ShellThread, ShellThreadTool } from "@/tool/shell_thread"
import { ShellID } from "@/tool/shell/id"
import { MessageID, SessionID } from "@/session/schema"
import { WithInstance } from "@/project/with-instance"
import { Effect, Layer, ManagedRuntime } from "effect"
import path from "path"
import type { Permission } from "@/permission"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Config.defaultLayer,
    Agent.defaultLayer,
    ShellThread.defaultLayer,
  ),
)

const projectRoot = path.join(__dirname, "../..")

const ctx = (requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []) => ({
  sessionID: SessionID.make("ses_shell_thread"),
  messageID: MessageID.make("msg_shell_thread"),
  callID: "call_shell_thread",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
    }),
})

function init() {
  return runtime.runPromise(ShellThreadTool.pipe(Effect.flatMap((info) => info.init())))
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("tool.shell_thread", () => {
  test("starts without waiting for command completion", async () => {
    if (process.platform === "win32") return

    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const tool = await init()
        const started = Date.now()
        const result = await Effect.runPromise(
          tool.execute(
            {
              action: "start",
              command: "sleep 2; echo done",
              description: "Slow echo",
            },
            ctx(),
          ),
        )

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(result.metadata.status).toBe("running")
        expect(result.metadata.threadID).toBeString()

        await Effect.runPromise(
          tool.execute({ action: "stop", threadID: String(result.metadata.threadID), signal: "SIGKILL" }, ctx()),
        )
      },
    })
  })

  test("reads output, lists threads, and stops running thread", async () => {
    if (process.platform === "win32") return

    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const tool = await init()
        const start = await Effect.runPromise(
          tool.execute(
            {
              action: "start",
              command: "printf first; sleep 0.2; printf second; sleep 5",
              description: "Streaming command",
            },
            ctx(),
          ),
        )
        const threadID = String(start.metadata.threadID)

        await wait(400)

        const read = await Effect.runPromise(tool.execute({ action: "read", threadID }, ctx()))
        expect(read.output).toContain("first")
        expect(read.output).toContain("second")
        expect(read.metadata.cursor).toBeGreaterThan(0)

        const list = await Effect.runPromise(tool.execute({ action: "list" }, ctx()))
        expect(list.output).toContain(threadID)
        expect(list.output).toContain("running")
        expect(list.metadata.threads).toContainEqual(
          expect.objectContaining({ threadID, status: "running", description: "Streaming command" }),
        )

        const stop = await Effect.runPromise(tool.execute({ action: "stop", threadID, signal: "SIGKILL" }, ctx()))
        expect(stop.metadata.status).toBe("stopped")
      },
    })
  })

  test("inspect returns command, pid, status, and output tail", async () => {
    if (process.platform === "win32") return

    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const tool = await init()
        const start = await Effect.runPromise(
          tool.execute(
            {
              action: "start",
              command: "echo inspect-me; sleep 5",
              description: "Inspect target",
            },
            ctx(),
          ),
        )
        const threadID = String(start.metadata.threadID)

        await wait(300)
        const details = await runtime.runPromise(
          ShellThread.Service.use((service) =>
            service.inspect({ sessionID: SessionID.make("ses_shell_thread") }),
          ),
        )
        const detail = details.find((item) => item.threadID === threadID)
        expect(detail).toBeDefined()
        expect(detail!.status).toBe("running")
        expect(detail!.command).toBe("echo inspect-me; sleep 5")
        expect(detail!.description).toBe("Inspect target")
        expect(detail!.pid).toBeNumber()
        expect(detail!.outputTail).toContain("inspect-me")

        await Effect.runPromise(
          tool.execute({ action: "stop", threadID, signal: "SIGKILL" }, ctx()),
        )
      },
    })
  })

  test("start requests normal shell permission", async () => {
    if (process.platform === "win32") return

    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const tool = await init()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const result = await Effect.runPromise(
          tool.execute(
            {
              action: "start",
              command: "sleep 5",
              description: "Permission check",
            },
            ctx(requests),
          ),
        )

        expect(requests.some((request) => request.permission === ShellID.ToolID)).toBe(true)

        await Effect.runPromise(
          tool.execute({ action: "stop", threadID: String(result.metadata.threadID), signal: "SIGKILL" }, ctx()),
        )
      },
    })
  })
})
