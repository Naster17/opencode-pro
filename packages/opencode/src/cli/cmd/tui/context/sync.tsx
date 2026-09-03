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
import { batch, createSignal, onCleanup, onMount } from "solid-js"
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
  // Server snapshots lag behind locally-applied deltas, so the local text is
  // the server text plus appended deltas. A prefix check is equivalent to the
  // previous substring scan but fails fast instead of scanning megabytes of
  // accumulated text on every part update of a huge session.
  if (!current.text.startsWith(next.text)) return next
  return { ...next, text: current.text } as Part
}

// Merges a fetched page of parts into whatever is already stored for a message.
// Uses Map/Set lookups so re-syncing a message with many parts stays O(P)
// instead of degrading to O(P^2) find/some scans.
function mergeStoredParts(existing: readonly Part[], incoming: readonly Part[]) {
  const current = new Map(existing.map((part) => [part.id, part]))
  const merged = incoming.map((part) => mergePart(current.get(part.id), part))
  const mergedIDs = new Set(merged.map((part) => part.id))
  const kept = existing.filter((part) => isLivePart(part) && !mergedIDs.has(part.id))
  return [...merged, ...kept].toSorted((a, b) => a.id.localeCompare(b.id))
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
  // Deltas are appends, so an already-applied delta is always a suffix of the
  // accumulated text. endsWith avoids an O(n) substring scan over large parts.
  if (event.field === "raw" && part.type === "tool" && part.state.status === "pending") {
    return part.state.raw.endsWith(event.delta)
  }
  if (event.field !== "text") return false
  if (part.type !== "text" && part.type !== "reasoning") return false
  return part.text.endsWith(event.delta)
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const PART_EVENT_FLUSH_MS = 16    // History is loaded lazily in a sliding window at the tail of the session.
    // Opening a session only fetches the most recent HISTORY_TAIL_LIMIT
    // messages; older pages (HISTORY_EARLIER_LIMIT each) are fetched on demand
    // when the user scrolls past the top of the loaded window. HISTORY_MESSAGE_CAP
    // bounds how many messages are retained once new ones keep arriving, dropping
    // the oldest so a long-lived session never balloons in the TUI store.
    const HISTORY_TAIL_LIMIT = 200
    const HISTORY_EARLIER_LIMIT = 200
    const HISTORY_MESSAGE_CAP = 250
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

    // Monotonic version bumped (throttled) whenever message/part data enters
    // the store — from SSE events and from REST history loads alike. Consumers
    // with expensive derived summaries (usage metrics) read this instead of
    // deep-tracking every part, so a streamed delta no longer rescans the whole
    // loaded history, while updates stay guaranteed: this fires on the exact
    // code paths that mutate the store.
    const [dataVersion, setDataVersion] = createSignal(0)
    let dataVersionTimer: ReturnType<typeof setTimeout> | undefined
    const bumpDataVersion = (immediate = false) => {
      if (immediate) {
        if (dataVersionTimer) {
          clearTimeout(dataVersionTimer)
          dataVersionTimer = undefined
        }
        setDataVersion((value) => value + 1)
        return
      }
      if (dataVersionTimer) return
      dataVersionTimer = setTimeout(() => {
        dataVersionTimer = undefined
        setDataVersion((value) => value + 1)
      }, 500)
    }
    onCleanup(() => {
      if (dataVersionTimer) clearTimeout(dataVersionTimer)
    })

    const fullSyncedSessions = new Set<string>()
    const fullHistorySyncedSessions = new Set<string>()
    // Lazy history windowing state: the next `before` cursor for older messages
    // of a session, whether the server still has older messages, and a guard
    // against overlapping "load earlier" fetches for the same session.
    const earlierCursor = new Map<string, string>()
    const hasMoreOlderSessions = new Map<string, boolean>()
    const earlierLoadingSessions = new Set<string>()
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
            const retry: QueuedPartDelta[] = []
            for (const pending of pendingPartDeltas.values()) {
              if (pending.messageID !== part.messageID || pending.partID !== part.id) continue
              pendingPartDeltas.delete(partDeltaKey(pending))
              if (partIncludesDelta(part, pending)) continue
              if (!applyDelta(pending)) retry.push(pending)
            }
            // Re-insert failures after the loop: re-setting during iteration
            // would move entries to the end and revisit them forever.
            for (const pending of retry) pendingPartDeltas.set(partDeltaKey(pending), pending)
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

    async function fetchSessionMessages(sessionID: string) {
      // Pages arrive newest-first; collect and reverse once at the end instead
      // of unshifting each page into the accumulator (O(N^2) copying).
      const pages: Awaited<ReturnType<typeof fetchMessagePage>>["messages"][] = []
      let before: string | undefined

      while (true) {
        const result = await sdk.client.session.messages({ sessionID, limit: 200, before })
        pages.push(result.data ?? [])
        const next = result.response.headers.get("x-next-cursor") ?? undefined
        if (!next) break
        before = next
      }

      return pages.reverse().flat()
    }

    // Fetch a single page of messages for a session. Without `before` this is
    // the most recent `limit` messages of the session; with `before` it is the
    // `limit` messages strictly older than the cursor. The returned `next` is the
    // cursor for the following (older) page, or undefined when the server has no
    // more older messages.
    async function fetchMessagePage(sessionID: string, limit: number, before?: string) {
      const result = await sdk.client.session.messages({ sessionID, limit, before })
      const next = result.response.headers.get("x-next-cursor") ?? undefined
      return { messages: result.data ?? [], next }
    }

    // The server encodes a history cursor as base64url JSON of the oldest loaded
    // message ({ id, time }), meaning "fetch messages older than this". Rebuild
    // it from whatever message is currently the earliest loaded one so that
    // evicting old messages never creates a gap when the user scrolls up again.
    function encodeCursor(message: { id: string; time: { created: number } }) {
      return Buffer.from(JSON.stringify({ id: message.id, time: message.time.created })).toString("base64url")
    }

    // Advance the load-earlier cursor to the message that is now the earliest
    // loaded one (after dropping older messages) and mark that older history
    // exists again. Dropping the oldest loaded message(s) always leaves older
    // messages on the server (the dropped ones are older than the new earliest
    // and can be re-fetched), so the flag decays back to false on the next
    // loadEarlier when the server reports the real page boundary.
    function setEarlierCursor(sessionID: string, earliest: { id: string; time: { created: number } } | undefined) {
      if (earliest) {
        earlierCursor.set(sessionID, encodeCursor(earliest))
        hasMoreOlderSessions.set(sessionID, true)
      } else {
        earlierCursor.delete(sessionID)
        hasMoreOlderSessions.delete(sessionID)
      }
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
          const previous = store.session_status[event.properties.sessionID]
          setStore("session_status", event.properties.sessionID, event.properties.status)
          // File edits only land in session_diff on explicit syncs, so the
          // code +/- stats went stale after every turn (visible again only
          // after a restart). Refresh the diff when a session goes idle.
          if (previous?.type !== "idle" && event.properties.status.type === "idle") {
            const sessionID = event.properties.sessionID
            void sdk.client.session
              .diff({ sessionID })
              .then((result) => {
                setStore("session_diff", sessionID, result.data ?? [])
                bumpDataVersion(true)
              })
              .catch(() => {})
          }
          break
        }

        case "message.updated": {
          bumpDataVersion()
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
          if (!fullHistorySyncedSessions.has(event.properties.info.sessionID) && updated.length > HISTORY_MESSAGE_CAP) {
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
            // Keep the "load earlier" cursor pointing at the new oldest loaded
            // message so a later scroll-up re-fetches the dropped messages
            // without leaving a gap in the window.
            setEarlierCursor(event.properties.info.sessionID, updated[1])
          }
          break
        }
        case "message.removed": {
          bumpDataVersion()
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
          bumpDataVersion()
          queuedPartEvents.push({
            type: "update",
            part: event.properties.part,
          })
          scheduleQueuedPartEvents()
          break
        }

        case "message.part.delta": {
          bumpDataVersion()
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
          bumpDataVersion()
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
        earlierCursor.clear()
        hasMoreOlderSessions.clear()
        earlierLoadingSessions.clear()
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
      // Throttled counter of message/part store mutations (SSE + REST loads).
      // Read this instead of deep-tracking parts when deriving expensive
      // summaries from the loaded history.
      dataVersion,
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
        async sync(sessionID: string, options?: { fullHistory?: boolean; limit?: number }) {
          const fullHistory = options?.fullHistory ?? false
          if (fullHistory && fullHistorySyncedSessions.has(sessionID)) return
          if (!fullHistory && (fullHistorySyncedSessions.has(sessionID) || fullSyncedSessions.has(sessionID))) return

          // Full history fetches every page once; the windowed path only fetches
          // the most recent `limit` messages and remembers the cursor for older
          // pages that `loadEarlier` will pull in as the user scrolls up.
          let next: string | undefined
          let messages: Awaited<ReturnType<typeof fetchSessionMessages>>
          if (fullHistory) {
            messages = await fetchSessionMessages(sessionID)
          } else {
            const page = await fetchMessagePage(sessionID, options?.limit ?? HISTORY_TAIL_LIMIT)
            messages = page.messages
            next = page.next
          }

          const [session, todo, diff] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
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
                draft.part[message.info.id] = mergeStoredParts(draft.part[message.info.id] ?? [], message.parts)
              }
              draft.session_diff[sessionID] = diff.data ?? []
            }),
          )
          bumpDataVersion(true)
          fullSyncedSessions.add(sessionID)
          if (fullHistory) {
            fullHistorySyncedSessions.add(sessionID)
            earlierCursor.delete(sessionID)
            hasMoreOlderSessions.delete(sessionID)
          } else {
            if (next) earlierCursor.set(sessionID, next)
            else earlierCursor.delete(sessionID)
            if (next) hasMoreOlderSessions.set(sessionID, true)
            else hasMoreOlderSessions.delete(sessionID)
          }
        },
        // Fetch the next older page of history and prepend it into the store.
        // Returns true when older messages were loaded (the viewport should be
        // re-anchored), false when there is nothing more to load.
        async loadEarlier(sessionID: string) {
          if (fullHistorySyncedSessions.has(sessionID)) return false
          if (earlierLoadingSessions.has(sessionID)) return false
          const cursor = earlierCursor.get(sessionID)
          if (!cursor) return false
          earlierLoadingSessions.add(sessionID)
          try {
            const { messages, next } = await fetchMessagePage(sessionID, HISTORY_EARLIER_LIMIT, cursor)
            if (messages.length === 0) {
              earlierCursor.delete(sessionID)
              hasMoreOlderSessions.delete(sessionID)
              return false
            }
            setStore(
              produce((draft) => {
                const existing = draft.message[sessionID] ?? []
                const existingIds = new Set(existing.map((message) => message.id))
                const fresh = messages.filter((message) => !existingIds.has(message.info.id))
                if (fresh.length === 0) return
                draft.message[sessionID] = [...fresh.map((message) => message.info), ...existing]
                for (const message of fresh) {
                  draft.part[message.info.id] = mergeStoredParts(draft.part[message.info.id] ?? [], message.parts)
                }
              }),
            )
            bumpDataVersion(true)
            if (next) earlierCursor.set(sessionID, next)
            else earlierCursor.delete(sessionID)
            if (next) hasMoreOlderSessions.set(sessionID, true)
            else hasMoreOlderSessions.delete(sessionID)
            return true
          } finally {
            earlierLoadingSessions.delete(sessionID)
          }
        },
        hasMoreOlder(sessionID: string) {
          return hasMoreOlderSessions.get(sessionID) === true
        },
        // Fetch the complete message list for a session without touching the
        // windowed store, used by transcript copy/export which need the whole
        // conversation regardless of how much history is currently loaded.
        async allMessages(sessionID: string) {
          const messages = await fetchSessionMessages(sessionID)
          return messages.map((message) => ({ info: message.info, parts: message.parts }))
        },
        // Hard bound for the lazy history window: drop the oldest loaded
        // messages until at most HISTORY_MESSAGE_CAP remain. The viewport must
        // be at the tail when this is called (the dropped messages sit above
        // it), and the load-earlier cursor is advanced to the new oldest message
        // so a later scroll-up re-fetches them without leaving a gap. Returns
        // the number of messages dropped.
        trimToTail(sessionID: string) {
          if (fullHistorySyncedSessions.has(sessionID)) return 0
          const messages = store.message[sessionID] ?? []
          const excess = messages.length - HISTORY_MESSAGE_CAP
          if (excess <= 0) return 0
          const dropped = messages.slice(0, excess)
          batch(() => {
            setStore(
              "message",
              sessionID,
              produce((draft) => {
                draft.splice(0, excess)
              }),
            )
            setStore(
              "part",
              produce((draft) => {
                for (const message of dropped) delete draft[message.id]
              }),
            )
          })
          setEarlierCursor(sessionID, messages[excess])
          return excess
        },
      },
      bootstrap,
    }
    return result
  },
})
