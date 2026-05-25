/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../../src/cli/cmd/tui/context/exit"
import { KVProvider, useKV } from "../../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { SDKProvider, type EventSource } from "../../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../../src/cli/cmd/tui/context/sync"
import { tmpdir } from "../../../fixture/fixture"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"

const worktree = "/tmp/opencode"
const directory = `${worktree}/packages/opencode`

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}

function eventSource(input?: { handler?: (event: GlobalEvent) => void }): EventSource {
  return {
    subscribe: async (handler) => {
      input && (input.handler = handler)
      return () => {}
    },
  }
}

function createFetch() {
  const session = [] as URL[]
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/session") session.push(url)

    switch (url.pathname) {
      case "/agent":
      case "/command":
      case "/experimental/workspace":
      case "/experimental/workspace/status":
      case "/formatter":
      case "/lsp":
        return json([])
      case "/config":
      case "/experimental/resource":
      case "/mcp":
      case "/provider/auth":
      case "/session/status":
        return json({})
      case "/config/providers":
        return json({ providers: {}, default: {} })
      case "/experimental/console":
        return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
      case "/path":
        return json({ home: "", state: "", config: "", worktree, directory })
      case "/project/current":
        return json({ id: "proj_test" })
      case "/provider":
        return json({ all: [], default: {}, connected: [] })
      case "/session":
        return json([])
      case "/vcs":
        return json({ branch: "main" })
    }

    throw new Error(`unexpected request: ${url.pathname}`)
  }) as typeof globalThis.fetch

  return { fetch, session }
}

async function mount() {
  const calls = createFetch()
  const events: { handler?: (event: GlobalEvent) => void } = {}
  let sync!: ReturnType<typeof useSync>
  let kv!: ReturnType<typeof useKV>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <ArgsProvider>
      <ExitProvider>
        <KVProvider>
          <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource(events)}>
            <ProjectProvider>
              <SyncProvider>
                <Probe
                  onReady={(ctx) => {
                    sync = ctx.sync
                    kv = ctx.kv
                    done()
                  }}
                />
              </SyncProvider>
            </ProjectProvider>
          </SDKProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  ))

  await ready
  await wait(() => sync.status === "complete")
  return {
    app,
    kv,
    sync,
    session: calls.session,
    emit(payload: Event) {
      events.handler?.({ directory, payload } as GlobalEvent)
    },
  }
}

function Probe(props: { onReady: (ctx: { kv: ReturnType<typeof useKV>; sync: ReturnType<typeof useSync> }) => void }) {
  const kv = useKV()
  const sync = useSync()

  onMount(() => {
    props.onReady({ kv, sync })
  })

  return <box />
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount()

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/opencode")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("preserves completed tool state when stale running update arrives in same flush", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount()

    try {
      const base = {
        id: "part_tool",
        sessionID: "session_1",
        messageID: "message_1",
        type: "tool" as const,
        tool: "read",
        callID: "call_1",
      }
      emit({
        id: "event_completed",
        type: "message.part.updated",
        properties: {
          sessionID: "session_1",
          time: 1,
          part: {
            ...base,
            state: {
              status: "completed",
              input: { filePath: "a.ts" },
              output: "ok",
              title: "Read",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        },
      })
      emit({
        id: "event_running",
        type: "message.part.updated",
        properties: {
          sessionID: "session_1",
          time: 2,
          part: {
            ...base,
            state: {
              status: "running",
              input: { filePath: "a.ts" },
              time: { start: 1 },
            },
          },
        },
      })

      await wait(() => sync.data.part.message_1?.[0]?.type === "tool")
      const part = sync.data.part.message_1?.[0]
      expect(part?.type).toBe("tool")
      if (part?.type === "tool") expect(part.state.status).toBe("completed")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
