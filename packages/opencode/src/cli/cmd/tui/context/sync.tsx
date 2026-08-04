import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@opencode-ai/core/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onCleanup, onMount } from "solid-js"
import * as Log from "@opencode-ai/core/util/log"
import { emptyConsoleState, type ConsoleState } from "@/config/console-state"
import path from "path"
import { useKV } from "./kv"

function toolStateRank(status: "pending" | "running" | "completed" | "error") {
  if (status === "pending") return 0
  if (status === "running") return 1
  return 2
}

function shouldPreservePart(current: Part | undefined, next: Part) {
  if (!current || current.type !== "tool" || next.type !== "tool") return false
  return toolStateRank(current.state.status) > toolStateRank(next.state.status)
}

function isTextPart(part: Part): part is Extract<Part, { type: "text" | "reasoning" }> {
  return part.type === "text" || part.type === "reasoning"
}

function isLivePart(part: Part) {
  if (isTextPart(part)) return !part.time?.end
  if (part.type === "tool") return part.state.status === "pending" || part.state.status === "running"
  return false
}

function mergePart(current: Part | undefined, next: Part): Part {
  if (!current) return next
  if (shouldPreservePart(current, next)) return current
  if (!isTextPart(current) || !isTextPart(next)) return next
  if (next.time?.end) return next
  if (current.text.length <= next.text.length) return next
  if (!current.text.includes(next.text)) return next
  return { ...next, text: current.text } as Part
}

type QueuedPartDelta = {
  messageID: string
  partID: string
  field: string
  delta: string
}

type ShellThreadItem = {
  threadID: string
  status: "running" | "exited" | "stopped" | "failed"
  description: string
  startedAt: number
  updatedAt: number
}

function partDeltaKey(input: QueuedPartDelta) {
  return `${input.messageID}:${input.partID}:${input.field}`
}

function partIncludesDelta(part: Part, event: QueuedPartDelta) {
  if (event.field === "raw" && part.type === "tool" && part.state.status === "pending") {
    return part.state.raw.includes(event.delta)
  }
  if (event.field !== "text") return false
  if (part.type !== "text" && part.type !== "reasoning") return false
  return part.text.includes(event.delta)
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const PART_EVENT_FLUSH_MS = 16
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      shell_thread: {
        [sessionID: string]: ShellThreadItem[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      shell_thread: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const kv = useKV()

    const fullSyncedSessions = new Set<string>()
    const fullHistorySyncedSessions = new Set<string>()
    let syncedWorkspace = project.workspace.current()
    const queuedPartEvents: Array<{ type: "update"; part: Part } | ({ type: "delta" } & QueuedPartDelta)> = []
    const pendingPartDeltas = new Map<string, QueuedPartDelta>()
    let queuedPartFlush: ReturnType<typeof setTimeout> | undefined

    function flushQueuedPartEvents() {
      queuedPartFlush = undefined
      if (queuedPartEvents.length === 0) return
      const events = queuedPartEvents.splice(0)
      setStore(
        "part",
        produce((draft) => {
          const applyDelta = (event: QueuedPartDelta) => {
            const parts = draft[event.messageID]
            if (!parts) return false
            const result = Binary.search(parts, event.partID, (part) => part.id)
            if (!result.found) return false
            const part = parts[result.index]
            if (event.field === "raw" && part.type === "tool" && part.state.status === "pending") {
              part.state.raw += event.delta
              return true
            }
            if (event.field !== "text") return false
            if (part.type !== "text" && part.type !== "reasoning") return false
            part.text += event.delta
            return true
          }

          const applyPendingDeltas = (part: Part) => {
            for (const pending of [...pendingPartDeltas.values()]) {
              if (pending.messageID !== part.messageID || pending.partID !== part.id) continue
              pendingPartDeltas.delete(partDeltaKey(pending))
              if (partIncludesDelta(part, pending)) continue
              if (!applyDelta(pending)) pendingPartDeltas.set(partDeltaKey(pending), pending)
            }
          }

          for (const event of events) {
            if (event.type === "update") {
              const parts = draft[event.part.messageID]
              if (!parts) {
                draft[event.part.messageID] = [event.part]
                applyPendingDeltas(event.part)
                continue
              }
              const result = Binary.search(parts, event.part.id, (item) => item.id)
              if (result.found) {
                parts[result.index] = mergePart(parts[result.index], event.part)
                applyPendingDeltas(parts[result.index])
                continue
              }
              parts.splice(result.index, 0, event.part)
              applyPendingDeltas(event.part)
              continue
            }

            if (applyDelta(event)) continue
            if (event.field !== "text" && event.field !== "raw") continue
            const key = partDeltaKey(event)
            const existing = pendingPartDeltas.get(key)
            pendingPartDeltas.set(key, { ...event, delta: (existing?.delta ?? "") + event.delta })
          }
        }),
      )
    }

    function scheduleQueuedPartEvents() {
      if (queuedPartFlush) return
      queuedPartFlush = setTimeout(flushQueuedPartEvents, PART_EVENT_FLUSH_MS)
    }

    async function fetchSessionMessages(sessionID: string, fullHistory?: boolean) {
      if (!fullHistory) {
        const result = await sdk.client.session.messages({ sessionID, limit: 100 })
        return result.data ?? []
      }

      const all = []
      let before: string | undefined

      while (true) {
        const result = await sdk.client.session.messages({ sessionID, limit: 200, before })
        all.unshift(...(result.data ?? []))
        const next = result.response.headers.get("x-next-cursor") ?? undefined
        if (!next) break
        before = next
      }

      return all.flat()
    }

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions() {
      return sdk.client.session
        .list({ start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    event.subscribe((event) => {
      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (!fullHistorySyncedSessions.has(event.properties.info.sessionID) && updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          queuedPartEvents.push({
            type: "update",
            part: event.properties.part,
          })
          scheduleQueuedPartEvents()
          break
        }

        case "message.part.delta": {
          const previous = queuedPartEvents.at(-1)
          if (
            previous?.type === "delta" &&
            previous.messageID === event.properties.messageID &&
            previous.partID === event.properties.partID &&
            previous.field === event.properties.field
          ) {
            previous.delta += event.properties.delta
            scheduleQueuedPartEvents()
            break
          }
          queuedPartEvents.push({
            type: "delta",
            messageID: event.properties.messageID,
            partID: event.properties.partID,
            field: event.properties.field,
            delta: event.properties.delta,
          })
          scheduleQueuedPartEvents()
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "shell_thread.updated": {
          setStore("shell_thread", event.properties.sessionID, reconcile(event.properties.threads))
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          setStore("vcs", { branch: event.properties.branch })
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap(input: { fatal?: boolean } = {}) {
      const fatal = input.fatal ?? true
      const workspace = project.workspace.current()
      if (workspace !== syncedWorkspace) {
        fullSyncedSessions.clear()
        fullHistorySyncedSessions.clear()
        syncedWorkspace = workspace
      }
      const projectPromise = project.sync()
      const sessionListPromise = projectPromise.then(() => listSessions())

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      const blockingRequests: Promise<unknown>[] = [
        providersPromise,
        providerListPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ]

      await Promise.all(blockingRequests)
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const consoleState = responses[2]
            const agents = responses[3]
            const config = responses[4]
            const sessions = responses[5]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          void Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => setStore("console_state", reconcile(consoleState))),
            sdk.client.command.list({ workspace }).then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ workspace }).then((x) => {
              setStore("session_status", reconcile(x.data ?? {}))
            }),
            sdk.client.provider.auth({ workspace }).then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => setStore("vcs", reconcile(x.data))),
            project.workspace.sync(),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          Log.Default.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) {
            await exit(e)
          } else {
            throw e
          }
        })
    }

    onMount(() => {
      void bootstrap()
    })

    onCleanup(() => {
      if (queuedPartFlush) clearTimeout(queuedPartFlush)
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (process.env.OPENCODE_FAST_BOOT) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string, options?: { fullHistory?: boolean }) {
          const fullHistory = options?.fullHistory ?? false
          if (fullHistory && fullHistorySyncedSessions.has(sessionID)) return
          if (!fullHistory && fullSyncedSessions.has(sessionID)) return
          const [session, messages, todo, diff] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            fetchSessionMessages(sessionID, fullHistory),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
          ])
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = session.data!
              if (!match.found) draft.session.splice(match.index, 0, session.data!)
              draft.todo[sessionID] = todo.data ?? []
              draft.message[sessionID] = messages.map((x) => x.info)
              for (const message of messages) {
                const existing = draft.part[message.info.id] ?? []
                const merged = message.parts.map((part) => {
                  const current = existing.find((item) => item.id === part.id)
                  return mergePart(current, part)
                })
                draft.part[message.info.id] = [
                  ...merged,
                  ...existing.filter((part) => isLivePart(part) && !merged.some((item) => item.id === part.id)),
                ].toSorted((a, b) => a.id.localeCompare(b.id))
              }
              draft.session_diff[sessionID] = diff.data ?? []
            }),
          )
          fullSyncedSessions.add(sessionID)
          if (fullHistory) fullHistorySyncedSessions.add(sessionID)
        },
      },
      bootstrap,
    }
    return result
  },
})
