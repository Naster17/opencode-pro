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
import type { AssistantMessage, Event, GlobalEvent } from "@opencode-ai/sdk/v2"

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

function assistantInfo(id: string, created: number): AssistantMessage {
  return {
    id,
    sessionID: "session_1",
    role: "assistant",
    time: { created },
    parentID: "",
    modelID: "test-model",
    providerID: "test-provider",
    mode: "build",
    agent: "build",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "completed",
  }
}

function eventSource(input?: { handler?: (event: GlobalEvent) => void }): EventSource {
  return {
    subscribe: async (handler) => {
      input && (input.handler = handler)
      return () => {}
    },
  }
}

function createFetch(input?: { messageServer?: { total: number } }) {
  const session = [] as URL[]
  const messageRequests = { value: 0 }
  const total = input?.messageServer?.total ?? 0
  const messageInfo = (index: number) => ({
    id: `msg_${String(index + 1).padStart(4, "0")}`,
    sessionID: "session_1",
    role: "assistant" as const,
    time: { created: 1000 + index },
  })
  const messageWithParts = (index: number) => ({
    info: messageInfo(index),
    parts: [
      {
        id: `part_${String(index + 1).padStart(4, "0")}`,
        messageID: `msg_${String(index + 1).padStart(4, "0")}`,
        sessionID: "session_1",
        type: "text" as const,
        text: "hello",
        time: { start: 1, end: 2 },
      },
    ],
  })
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
      case "/session/session_1/todo":
      case "/session/session_1/diff":
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
      case "/session/session_1":
        return json({ id: "session_1", title: "Test", time: { created: 1, updated: 1 } })
      case "/session/session_1/message": {
        messageRequests.value++
        const limit = Number(url.searchParams.get("limit") ?? 0)
        const before = url.searchParams.get("before")
        if (before === null) {
          const start = Math.max(0, total - limit)
          const items = Array.from({ length: total - start }, (_, i) => messageWithParts(start + i))
          const headers: Record<string, string> = { "content-type": "application/json" }
          if (total > limit) headers["x-next-cursor"] = "cursor-1"
          return new Response(JSON.stringify(items), { headers })
        }
        const remaining = total - limit
        const items = Array.from({ length: Math.max(0, remaining) }, (_, i) => messageWithParts(i))
        return new Response(JSON.stringify(items), { headers: { "content-type": "application/json" } })
      }
      case "/vcs":
        return json({ branch: "main" })
    }

    throw new Error(`unexpected request: ${url.pathname}`)
  }) as typeof globalThis.fetch

  return { fetch, session, messageRequests }
}

async function mount(input?: { messageServer?: { total: number } }) {
  const calls = createFetch(input)
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
    messageRequests: calls.messageRequests,
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

  test("loads a history window at the tail and pulls older messages on demand", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync, messageRequests } = await mount({ messageServer: { total: 350 } })

    try {
      await sync.session.sync("session_1")
      expect(sync.data.message.session_1?.length).toBe(200)
      expect(sync.data.message.session_1?.[0].id).toBe("msg_0151")
      expect(sync.data.message.session_1?.at(-1)?.id).toBe("msg_0350")
      expect(sync.session.hasMoreOlder("session_1")).toBe(true)

      // Repeated windowed sync is a no-op (guarded) and must not refetch.
      await sync.session.sync("session_1")
      expect(sync.data.message.session_1?.length).toBe(200)

      expect(await sync.session.loadEarlier("session_1")).toBe(true)
      expect(sync.data.message.session_1?.length).toBe(350)
      expect(sync.data.message.session_1?.[0].id).toBe("msg_0001")
      expect(sync.data.message.session_1?.at(-1)?.id).toBe("msg_0350")
      expect(sync.session.hasMoreOlder("session_1")).toBe(false)

      // The cursor is exhausted: loadEarlier short-circuits without a request.
      expect(await sync.session.loadEarlier("session_1")).toBe(false)
      expect(sync.data.message.session_1?.length).toBe(350)

      const all = await sync.session.allMessages("session_1")
      expect(all.length).toBe(350)
      expect(all[0].info.id).toBe("msg_0001")

      // 1 tail + 1 loadEarlier + 2 allMessages pages, then exhausted guards.
      expect(messageRequests.value).toBe(4)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("evicts the oldest messages once a windowed session grows past the cap", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync, emit } = await mount({ messageServer: { total: 350 } })

    try {
      await sync.session.sync("session_1")
      expect(sync.data.message.session_1?.length).toBe(200)
      expect(sync.data.message.session_1?.[0].id).toBe("msg_0151")

      // 50 new messages land within the 250 cap: nothing is evicted.
      for (let i = 0; i < 50; i++) {
        emit({
          id: `event_new_${i}`,
          type: "message.updated",
          properties: {
            sessionID: "session_1",
            info: assistantInfo(`msg_new_${i}`, 5000 + i),
          },
        })
      }
      await wait(() => (sync.data.message.session_1?.length ?? 0) === 250)
      expect(sync.data.message.session_1?.[0].id).toBe("msg_0151")

      // One more crosses the cap: the oldest message is evicted.
      emit({
        id: "event_new_50",
        type: "message.updated",
        properties: {
          sessionID: "session_1",
          info: assistantInfo("msg_new_50", 5050),
        },
      })
      await wait(() => (sync.data.message.session_1?.[0]?.id ?? "") === "msg_0152")
      expect(sync.data.message.session_1?.length).toBe(250)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("trimToTail drops the oldest loaded messages and reloads them without a gap", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mount({ messageServer: { total: 350 } })

    try {
      await sync.session.sync("session_1")
      expect(await sync.session.loadEarlier("session_1")).toBe(true)
      expect(sync.data.message.session_1?.length).toBe(350)
      expect(sync.data.message.session_1?.[0].id).toBe("msg_0001")
      expect(sync.data.part.msg_0001).toBeTruthy()

      // Trim back to the 250 cap: oldest 100 messages and their parts are gone.
      expect(sync.session.trimToTail("session_1")).toBe(100)
      expect(sync.data.message.session_1?.length).toBe(250)
      expect(sync.data.message.session_1?.[0].id).toBe("msg_0101")
      expect(sync.data.part.msg_0001).toBeUndefined()
      expect(sync.data.part.msg_0101).toBeTruthy()

      // Trimming to the cap is a no-op once already bounded.
      expect(sync.session.trimToTail("session_1")).toBe(0)

      // The load-earlier cursor was advanced to the new oldest loaded message,
      // so scrolling up again re-fetches the dropped messages contiguously.
      expect(sync.session.hasMoreOlder("session_1")).toBe(true)
      expect(await sync.session.loadEarlier("session_1")).toBe(true)
      expect(sync.data.message.session_1?.length).toBe(350)
      expect(sync.data.message.session_1?.[0].id).toBe("msg_0001")
      expect(sync.data.message.session_1?.some((m) => m.id === "msg_0100")).toBe(true)
      expect(sync.data.message.session_1?.some((m) => m.id === "msg_0101")).toBe(true)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
