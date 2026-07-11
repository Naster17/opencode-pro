import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  onCleanup,
  on,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js"
import path from "path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { selectedForeground, tint, useTheme } from "@tui/context/theme"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, TextAttributes, RGBA } from "@opentui/core"
import { Prompt, type BtwSubmission, type PromptRef } from "@tui/component/prompt"
import type {
  AssistantMessage,
  Part,
  Provider,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
} from "@opencode-ai/sdk/v2"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import type { Tool } from "@/tool/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { ShellTool } from "@/tool/shell"
import { ShellID } from "@/tool/shell/id"
import type { GlobTool } from "@/tool/glob"
import { TodoWriteTool } from "@/tool/todo"
import type { GrepTool } from "@/tool/grep"
import type { EditTool } from "@/tool/edit"
import type { ApplyPatchTool } from "@/tool/apply_patch"
import type { WebFetchTool } from "@/tool/webfetch"
import type { WebSearchTool } from "@/tool/websearch"
import type { SubagentTool } from "@/tool/subagent"
import type { QuestionTool } from "@/tool/question"
import type { SkillTool } from "@/tool/skill"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useEditorContext } from "@tui/context/editor"
import { useCommandDialog } from "@tui/component/dialog-command"
import type { DialogContext } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { SubagentFooter } from "./subagent-footer.tsx"
import { Flag } from "@opencode-ai/core/flag/flag"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import parsers from "../../../../../../parsers-config.ts"
import * as Clipboard from "../../util/clipboard"
import { errorMessage } from "@/util/error"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import * as Editor from "../../util/editor"
import stripAnsi from "strip-ansi"
import { parsePatch } from "diff"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { Filesystem } from "@/util/filesystem"
import { formatCompactTokens } from "../../util/usage"
import { Global } from "@opencode-ai/core/global"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { formatTranscript } from "../../util/transcript"
import { UI } from "@/cli/ui.ts"
import { useTuiConfig } from "../../context/tui-config"
import { getScrollAcceleration } from "../../util/scroll"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { DialogGoUpsell } from "../../component/dialog-go-upsell"
import { SessionRetry } from "@/session/retry"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { Token } from "@/util/token"
import * as SystemPrompt from "@/session/system"
import { ThinkTags } from "@/session/think-tags"
import { useBtwUsage } from "../../context/btw"

addDefaultParsers(parsers.parsers)

const GO_UPSELL_LAST_SEEN_AT = "go_upsell_last_seen_at"
const GO_UPSELL_DONT_SHOW = "go_upsell_dont_show"
const GO_UPSELL_WINDOW = 86_400_000 // 24 hrs
const STREAM_RATE_WINDOW = 5000
const STREAM_RATE_MAX_SAMPLES = 120
const STREAM_RATE_UPDATE_INTERVAL = 250
const STREAM_RATE_MIN_WINDOW = 1200
const STREAM_RATE_SMOOTHING = 0.18
const PROMPT_RATE_MIN_WINDOW = 1500

type AssistantDerivedMetrics = {
  estimatedOutputTokens: number
  responseStartedAt?: number
  generationStartedAt?: number
  promptTokensPerSecond?: number
  outputTokensPerSecond?: number
}

type CodeStats = {
  additions: number
  deletions: number
}

type MessageMetrics = {
  startedAt?: number
  codeStats: CodeStats
}

type LiveAssistantMetrics = {
  messageID?: string
  now: number
  responseStartedAt?: number
  textStartedAt?: number
  firstTokenAt?: number
  promptTokens?: number
  outputTokens?: number
  promptTokensPerSecond?: number
  outputTokensPerSecond?: number
  streamSamples: { time: number; tokens: number }[]
}

type BtwTurn = {
  id: string
  sessionID: string
  question: string
  startedAt: number
  status: "pending" | "completed" | "error"
  responses: BtwResponse[]
  error?: string
}

type BtwResponse = {
  info: AssistantMessage
  parts: Part[]
  codeStats: CodeStats
}

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  codeBlockExpansion: () => "collapse" | "extend"
  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

export function Session() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const event = useEvent()
  const project = useProject()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  const visible = createMemo(() => !session()?.parentID && permissions().length === 0 && questions().length === 0)
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0)

  const pending = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant" && !x.time.completed)?.id
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })
  const [liveAssistant, setLiveAssistant] = createSignal<LiveAssistantMetrics>({
    now: Date.now(),
    streamSamples: [],
  })
  const [liveBtwResponses, setLiveBtwResponses] = createSignal<Record<string, LiveAssistantMetrics>>({})

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)
  const [codeBlockExpansion, setCodeBlockExpansion] = kv.signal<"collapse" | "extend">(
    "code_block_expansion",
    tuiConfig.code_block?.default_mode === "extended" ? "extend" : "collapse",
  )
  const [visualClearAfter, setVisualClearAfter] = createSignal<string>()

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)
  const providers = createMemo(() => Model.index(sync.data.provider))

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const sdk = useSDK()
  const editor = useEditorContext()
  const btwUsage = useBtwUsage()
  const [btwTurns, setBtwTurns] = createSignal<BtwTurn[]>([])
  const sessionBtwTurns = createMemo(() => btwTurns().filter((turn) => turn.sessionID === route.sessionID))
  const activeBtwActionLabel = createMemo(() => {
    const turn = sessionBtwTurns().findLast((item) => item.status === "pending")
    const response = turn?.responses.at(-1)
    if (!response) return turn ? "processing" : undefined
    return btwActionLabel(response.parts)
  })
  const activeActionLabel = createMemo(() => activeBtwActionLabel() ?? liveAssistantActionLabel())
  const queuedBtwPartUpdates = new Map<string, { turnID: string; part: Part }>()
  const queuedBtwPartDeltas = new Map<
    string,
    { turnID: string; messageID: string; partID: string; field: string; delta: string }
  >()
  let queuedBtwPartFlush: ReturnType<typeof setTimeout> | undefined

  function upsertBtwResponse(turnID: string, info: AssistantMessage) {
    setBtwTurns((current) =>
      current.map((turn) => {
        if (turn.id !== turnID) return turn
        const existing = turn.responses.find((response) => response.info.id === info.id)
        return {
          ...turn,
          responses: existing
            ? turn.responses.map((response) =>
                response.info.id === info.id
                  ? {
                      ...response,
                      info,
                      codeStats: info.time.completed
                        ? maxCodeStats(response.codeStats, messageCodeStats(response.parts))
                        : response.codeStats,
                    }
                  : response,
              )
            : [...turn.responses, { info, parts: [], codeStats: emptyCodeStats() }],
        }
      }),
    )
  }

  function flushQueuedBtwPartEvents() {
    queuedBtwPartFlush = undefined
    if (queuedBtwPartUpdates.size === 0 && queuedBtwPartDeltas.size === 0) return
    const updates = [...queuedBtwPartUpdates.values()]
    const deltas = [...queuedBtwPartDeltas.values()]
    queuedBtwPartUpdates.clear()
    queuedBtwPartDeltas.clear()

    setBtwTurns((current) =>
      current.map((turn) => {
        const turnUpdates = updates.filter((update) => update.turnID === turn.id)
        const turnDeltas = deltas.filter((delta) => delta.turnID === turn.id)
        if (turnUpdates.length === 0 && turnDeltas.length === 0) return turn

        return {
          ...turn,
          responses: turn.responses.map((response) => {
            const parts = response.parts
              .map((part) => {
                const updated = turnUpdates.find(
                  (update) => update.part.messageID === response.info.id && update.part.id === part.id,
                )?.part
                const next = updated ?? part
                const partDeltas = turnDeltas.filter((delta) => delta.messageID === response.info.id && delta.partID === next.id)
                if (next.type === "tool" && next.state.status === "pending") {
                  const currentRaw = part.type === "tool" && part.state.status === "pending" ? part.state.raw : undefined
                  const deltaRaw = partDeltas
                    .filter((delta) => delta.field === "raw")
                    .map((delta) => delta.delta)
                    .join("")
                  return {
                    ...next,
                    state: {
                      ...next.state,
                      raw: updated && next.state.raw !== currentRaw ? next.state.raw : next.state.raw + deltaRaw,
                    },
                  }
                }
                if (next.type !== "text" && next.type !== "reasoning") return next
                const currentText = part.type === "text" || part.type === "reasoning" ? part.text : undefined
                const deltaText = partDeltas
                  .filter((delta) => delta.field === "text")
                  .map((delta) => delta.delta)
                  .join("")
                return {
                  ...next,
                  text: updated && next.text !== currentText ? next.text : next.text + deltaText,
                }
              })
              .concat(
                turnUpdates
                  .filter(
                    (update) =>
                      update.part.messageID === response.info.id &&
                      !response.parts.some((part) => part.id === update.part.id),
                  )
                  .map((update) => {
                    if (update.part.type === "tool" && update.part.state.status === "pending") {
                      const deltaRaw = turnDeltas
                        .filter(
                          (delta) =>
                            delta.messageID === response.info.id && delta.partID === update.part.id && delta.field === "raw",
                        )
                        .map((delta) => delta.delta)
                        .join("")
                      return { ...update.part, state: { ...update.part.state, raw: update.part.state.raw + deltaRaw } }
                    }
                    if (update.part.type !== "text" && update.part.type !== "reasoning") return update.part
                    if (update.part.time?.end) return update.part
                    return {
                      ...update.part,
                      text:
                        update.part.text +
                        turnDeltas
                          .filter(
                            (delta) =>
                              delta.messageID === response.info.id && delta.partID === update.part.id && delta.field === "text",
                          )
                          .map((delta) => delta.delta)
                          .join(""),
                    }
                  }),
              )
              .toSorted((a, b) => a.id.localeCompare(b.id))
            return {
              ...response,
              parts,
              codeStats: messageCodeStats(parts),
            }
          }),
        }
      }),
    )
  }

  function scheduleQueuedBtwPartEvents() {
    if (queuedBtwPartFlush) return
    queuedBtwPartFlush = setTimeout(flushQueuedBtwPartEvents, 16)
  }

  onCleanup(() => {
    if (queuedBtwPartFlush) clearTimeout(queuedBtwPartFlush)
  })

  function liveAssistantActionLabel() {
    const assistant = lastAssistant()
    if (!assistant) return
    if (assistant.time.completed) return
    const parts = sync.data.part[assistant.id] ?? []
    if (parts.some((part) => assistantPartVisible(part, showThinking(), showDetails()))) return
    if (parts.some((part) => part.type === "reasoning" && reasoningContent(part.text) && !showThinking())) {
      return "thinking hidden"
    }
    if (liveAssistant().firstTokenAt || (liveAssistant().outputTokens ?? 0) > 0) return "receiving output"
    return "processing prompt"
  }

  function appendBtwPartDelta(input: {
    turnID: string
    messageID: string
    partID: string
    field: string
    delta: string
  }) {
    if (input.field !== "text" && input.field !== "raw") return
    const key = `${input.turnID}:${input.messageID}:${input.partID}:${input.field}`
    const existing = queuedBtwPartDeltas.get(key)
    queuedBtwPartDeltas.set(key, { ...input, delta: (existing?.delta ?? "") + input.delta })
    scheduleQueuedBtwPartEvents()
  }

  function countBtwUsage(turnID: string, info: AssistantMessage) {
    const response = btwTurns()
      .find((turn) => turn.id === turnID)
      ?.responses.find((item) => item.info.id === info.id)
    btwUsage.add(info.sessionID, { info, parts: response?.parts ?? [] })
  }

  function updateLiveBtwResponse(messageID: string, update: (current?: LiveAssistantMetrics) => LiveAssistantMetrics) {
    setLiveBtwResponses((current) => ({
      ...current,
      [messageID]: update(current[messageID]),
    }))
  }

  async function submitBtw(input: BtwSubmission) {
    const turn: BtwTurn = {
      id: input.messageID,
      sessionID: input.sessionID,
      question: input.input,
      startedAt: Date.now(),
      status: "pending",
      responses: [],
    }
    setBtwTurns((current) => [...current, turn])
    toBottom()

    const response = await sdk.client.session
      .btw({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.model,
        agent: input.agent,
        variant: input.variant,
        parts: input.parts,
      })
      .catch((error) => ({ error, data: undefined }))
    if (response.error || !response.data) {
      const message = errorMessage(response.error ?? "BTW request failed")
      setBtwTurns((current) =>
        current.map((item) => (item.id === input.messageID ? { ...item, status: "error", error: message } : item)),
      )
      toast.show({ message, variant: "error" })
      toBottom()
      return
    }
    if (response.data.info.role !== "assistant") {
      const message = "BTW request returned a non-assistant response"
      setBtwTurns((current) =>
        current.map((item) => (item.id === input.messageID ? { ...item, status: "error", error: message } : item)),
      )
      toast.show({ message, variant: "error" })
      toBottom()
      return
    }

    const assistant = response.data.info

    setBtwTurns((current) =>
      current.map((item) =>
        item.id === input.messageID
          ? (() => {
              const existing = item.responses.find((current) => current.info.id === assistant.id)
              return {
                ...item,
                status: "completed",
                responses: [
                  ...item.responses.filter((current) => current.info.id !== assistant.id),
                  {
                    info: assistant,
                    parts: response.data.parts,
                    codeStats: maxCodeStats(
                      existing?.codeStats ?? emptyCodeStats(),
                      messageCodeStats(response.data.parts),
                    ),
                  },
                ].toSorted((a, b) => a.info.id.localeCompare(b.info.id)),
              }
            })()
          : item,
      ),
    )
    btwUsage.add(input.sessionID, { info: assistant, parts: response.data.parts })
    toBottom()
  }

  createEffect(() => {
    const sessionID = route.sessionID
    void (async () => {
      const previousWorkspace = project.workspace.current()
      const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
      if (!result.data) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        navigate({ type: "home" })
        return
      }

      if (result.data.workspaceID !== previousWorkspace) {
        project.workspace.set(result.data.workspaceID)

        // Sync all the data for this workspace. Note that this
        // workspace may not exist anymore which is why this is not
        // fatal. If it doesn't we still want to show the session
        // (which will be non-interactive)
        try {
          await sync.bootstrap({ fatal: false })
        } catch {}
      }
      editor.reconnect(result.data.directory)
      await sync.session.sync(sessionID, { fullHistory: true })
      if (route.sessionID === sessionID && scroll) scroll.scrollBy(100_000)
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      navigate({ type: "home" })
    })
  })

  let lastSwitch: string | undefined = undefined
  event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const keybind = useKeybind()
  const dialog = useDialog()
  const renderer = useRenderer()

  event.on("session.status", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    if (evt.properties.status.type !== "retry") return
    if (evt.properties.status.message !== SessionRetry.GO_UPSELL_MESSAGE) return
    if (dialog.stack.length > 0) return

    const seen = kv.get(GO_UPSELL_LAST_SEEN_AT)
    if (typeof seen === "number" && Date.now() - seen < GO_UPSELL_WINDOW) return

    if (kv.get(GO_UPSELL_DONT_SHOW)) return

    void DialogGoUpsell.show(dialog).then((dontShowAgain) => {
      if (dontShowAgain) kv.set(GO_UPSELL_DONT_SHOW, true)
      kv.set(GO_UPSELL_LAST_SEEN_AT, Date.now())
    })
  })

  event.on("session.next.reasoning.started", (evt) => {
    const assistant = lastAssistant()
    if (!assistant) return
    if (assistant.time.completed) return
    if (evt.properties.sessionID !== route.sessionID) return
    setLiveAssistant((current) =>
      current.messageID !== assistant.id
        ? {
            messageID: assistant.id,
            now: evt.properties.timestamp,
            responseStartedAt: evt.properties.timestamp,
            streamSamples: [],
          }
        : {
            ...current,
            now: evt.properties.timestamp,
            responseStartedAt: current.responseStartedAt ?? evt.properties.timestamp,
          },
    )
  })

  event.on("session.next.text.started", (evt) => {
    const assistant = lastAssistant()
    if (!assistant) return
    if (assistant.time.completed) return
    if (evt.properties.sessionID !== route.sessionID) return
    setLiveAssistant((current) =>
      current.messageID !== assistant.id
        ? {
            messageID: assistant.id,
            now: evt.properties.timestamp,
            responseStartedAt: evt.properties.timestamp,
            textStartedAt: evt.properties.timestamp,
            streamSamples: [],
          }
        : {
            ...current,
            now: evt.properties.timestamp,
            responseStartedAt: current.responseStartedAt ?? evt.properties.timestamp,
            textStartedAt: current.textStartedAt ?? evt.properties.timestamp,
          },
    )
  })

  event.on("message.part.delta", (evt) => {
    const assistant = lastAssistant()
    if (!assistant) return
    if (assistant.id !== evt.properties.messageID) return
    if (evt.properties.field !== "text") return
    const now = Date.now()
    const tokens = estimateStreamTokens(evt.properties.delta)
    setLiveAssistant((current) =>
      current.messageID !== assistant.id
        ? {
            messageID: assistant.id,
            now,
            responseStartedAt: now,
            textStartedAt: now,
            firstTokenAt: now,
            outputTokens: tokens,
            streamSamples: [{ time: now, tokens }],
          }
        : {
            ...current,
            now,
            responseStartedAt: current.responseStartedAt ?? now,
            textStartedAt: current.textStartedAt ?? now,
            firstTokenAt: current.firstTokenAt ?? now,
            outputTokens: (current.outputTokens ?? 0) + tokens,
            streamSamples: [
              ...current.streamSamples.filter((sample) => now - sample.time <= STREAM_RATE_WINDOW),
              { time: now, tokens },
            ].slice(-STREAM_RATE_MAX_SAMPLES),
          },
    )
  })

  event.on("message.stream.metrics", (evt) => {
    const assistant = lastAssistant()
    if (!assistant) return
    if (assistant.id !== evt.properties.messageID) return
    if (assistant.time.completed) return
    if (evt.properties.sessionID !== route.sessionID) return
    const outputStarted = !evt.properties.promptProgress && (evt.properties.outputTokens ?? 0) > 0
    setLiveAssistant((current) =>
      current.messageID !== assistant.id
        ? {
            messageID: assistant.id,
            now: evt.properties.time,
            firstTokenAt: outputStarted ? evt.properties.time : undefined,
            promptTokens: evt.properties.promptTokens,
            outputTokens: outputStarted ? evt.properties.outputTokens : undefined,
            promptTokensPerSecond: evt.properties.promptTokensPerSecond,
            outputTokensPerSecond: outputStarted ? evt.properties.outputTokensPerSecond : undefined,
            streamSamples: [],
          }
        : {
            ...current,
            now: evt.properties.time,
            responseStartedAt: current.responseStartedAt ?? (outputStarted ? evt.properties.time : undefined),
            firstTokenAt: current.firstTokenAt ?? (outputStarted ? evt.properties.time : undefined),
            promptTokens: evt.properties.promptTokens ?? current.promptTokens,
            outputTokens: outputStarted ? (evt.properties.outputTokens ?? current.outputTokens) : current.outputTokens,
            promptTokensPerSecond: evt.properties.promptTokensPerSecond ?? current.promptTokensPerSecond,
            outputTokensPerSecond: outputStarted
              ? (evt.properties.outputTokensPerSecond ?? current.outputTokensPerSecond)
              : current.outputTokensPerSecond,
          },
    )
  })

  event.on("session.btw.started", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    const now = Date.now()
    updateLiveBtwResponse(evt.properties.info.id, (current) => ({
      messageID: evt.properties.info.id,
      now,
      responseStartedAt: current?.responseStartedAt,
      textStartedAt: current?.textStartedAt,
      firstTokenAt: current?.firstTokenAt,
      streamSamples: current?.streamSamples ?? [],
    }))
    upsertBtwResponse(evt.properties.turnID, evt.properties.info)
    toBottom()
  })

  event.on("session.btw.updated", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    const info = evt.properties.info
    updateLiveBtwResponse(info.id, (current) => ({
      messageID: info.id,
      now: info.time.completed ?? Date.now(),
      responseStartedAt: current?.responseStartedAt ?? (info.time.completed ? info.time.created : undefined),
      textStartedAt: current?.textStartedAt,
      firstTokenAt: current?.firstTokenAt,
      streamSamples: current?.streamSamples ?? [],
    }))
    if (info.time.completed) {
      batch(() => {
        flushQueuedBtwPartEvents()
        upsertBtwResponse(evt.properties.turnID, info)
      })
      countBtwUsage(evt.properties.turnID, info)
      toBottom()
      return
    }
    upsertBtwResponse(evt.properties.turnID, info)
    toBottom()
  })

  event.on("session.btw.part.updated", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    const now = Date.now()
    const textStartedAt =
      evt.properties.part.type === "text" && evt.properties.part.text.length > 0
        ? (evt.properties.part.time?.start ?? now)
        : undefined
    queuedBtwPartUpdates.set(`${evt.properties.turnID}:${evt.properties.part.messageID}:${evt.properties.part.id}`, {
      turnID: evt.properties.turnID,
      part: evt.properties.part,
    })
    updateLiveBtwResponse(evt.properties.part.messageID, (current) => ({
      messageID: evt.properties.part.messageID,
      now,
      responseStartedAt: current?.responseStartedAt ?? textStartedAt ?? now,
      textStartedAt: current?.textStartedAt ?? textStartedAt,
      firstTokenAt: current?.firstTokenAt,
      streamSamples: current?.streamSamples ?? [],
    }))
    scheduleQueuedBtwPartEvents()
    toBottom()
  })

  event.on("session.btw.part.delta", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    const now = Date.now()
    if (evt.properties.field === "text") {
      const tokens = estimateStreamTokens(evt.properties.delta)
      updateLiveBtwResponse(evt.properties.messageID, (current) => ({
        messageID: evt.properties.messageID,
        now,
        responseStartedAt: current?.responseStartedAt ?? now,
        textStartedAt: current?.textStartedAt ?? now,
        firstTokenAt: current?.firstTokenAt ?? now,
        outputTokens: (current?.outputTokens ?? 0) + tokens,
        streamSamples: [
          ...(current?.streamSamples ?? []).filter((sample) => now - sample.time <= STREAM_RATE_WINDOW),
          { time: now, tokens },
        ].slice(-STREAM_RATE_MAX_SAMPLES),
      }))
    }
    appendBtwPartDelta({
      turnID: evt.properties.turnID,
      messageID: evt.properties.messageID,
      partID: evt.properties.partID,
      field: evt.properties.field,
      delta: evt.properties.delta,
    })
  })

  // Allow exit when in child session (prompt is hidden)
  const exit = useExit()

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    const pad = (text: string) => text.padEnd(10, " ")
    const weak = (text: string) => UI.Style.TEXT_DIM + pad(text) + UI.Style.TEXT_NORMAL
    const logo = UI.logo("  ").split(/\r?\n/)
    return exit.message.set(
      [
        `${logo[0] ?? ""}`,
        `${logo[1] ?? ""}`,
        `${logo[2] ?? ""}`,
        `${logo[3] ?? ""}`,
        ``,
        `  ${weak("Session")}${UI.Style.TEXT_NORMAL_BOLD}${title}${UI.Style.TEXT_NORMAL}`,
        `  ${weak("Continue")}${UI.Style.TEXT_NORMAL_BOLD}opencode -s ${session()?.id}${UI.Style.TEXT_NORMAL}`,
        ``,
      ].join("\n"),
    )
  })

  useKeyboard((evt) => {
    if (!session()?.parentID) return
    if (keybind.match("app_exit", evt)) {
      evt.preventDefault()
      evt.stopPropagation()
      void exit()
    }
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  function clearVisibleMessages() {
    const last = messages().at(-1)?.id
    if (!last) return
    setVisualClearAfter(last)
    toBottom()
  }

  const local = useLocal()

  function moveFirstChild() {
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) {
      navigate({
        type: "session",
        sessionID: next.id,
      })
    }
  }

  function moveChild(direction: number) {
    if (children().length === 1) return

    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) {
      navigate({
        type: "session",
        sessionID: sessions[next].id,
      })
    }
  }

  function childSessionHandler(func: (dialog: DialogContext) => void) {
    return (dialog: DialogContext) => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func(dialog)
    }
  }

  const command = useCommandDialog()
  command.register(() => [
    {
      title: session()?.share?.url ? "Copy share link" : "Share session",
      value: "session.share",
      suggested: route.type === "session",
      keybind: "session_share",
      category: "Session",
      enabled: sync.data.config.share !== "disabled",
      slash: {
        name: "share",
      },
      onSelect: async (dialog) => {
        const copy = (url: string) =>
          Clipboard.copy(url)
            .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
            .catch(() => toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }))
        const url = session()?.share?.url
        if (url) {
          await copy(url)
          dialog.clear()
          return
        }
        if (!kv.get("share_consent", false)) {
          const ok = await DialogConfirm.show(dialog, "Share Session", "Are you sure you want to share it?")
          if (ok !== true) return
          kv.set("share_consent", true)
        }
        await sdk.client.session
          .share({
            sessionID: route.sessionID,
          })
          .then((res) => copy(res.data!.share!.url))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to share session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Rename session",
      value: "session.rename",
      keybind: "session_rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      keybind: "session_timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork session",
      value: "session.fork",
      keybind: "session_fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              if (!messageID) return
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      keybind: "session_compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      onSelect: (dialog) => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        void sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      keybind: "session_unshare",
      category: "Session",
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      onSelect: async (dialog) => {
        await sdk.client.session
          .unshare({
            sessionID: route.sessionID,
          })
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to unshare session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      keybind: "messages_undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      onSelect: async (dialog) => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        void sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt?.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      keybind: "messages_redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      onSelect: (dialog) => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          void sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt?.set({ input: "", parts: [] })
          return
        }
        void sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal",
      category: "Session",
      onSelect: (dialog) => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: showThinking() ? "Hide thinking blocks" : "Show thinking blocks",
      value: "session.toggle.thinking.visibility",
      keybind: "display_thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        setShowThinking((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: `Cycle thinking level (${local.model.variant.thinking()})`,
      value: "session.toggle.model.thinking",
      keybind: "thinking_level_cycle",
      category: "Session",
      slash: {
        name: "thinking-mode",
        aliases: ["toggle-thinking-mode"],
      },
      onSelect: (dialog) => {
        local.model.variant.cycleThinking()
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "Session",
      onSelect: (dialog) => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Collapse code blocks",
      value: "session.code_blocks.collapse",
      category: "Session",
      slash: {
        name: "collapse",
      },
      onSelect: (dialog) => {
        setCodeBlockExpansion(() => "collapse")
        dialog.clear()
      },
    },
    {
      title: "Extend code blocks",
      value: "session.code_blocks.extend",
      category: "Session",
      slash: {
        name: "extend",
      },
      onSelect: (dialog) => {
        setCodeBlockExpansion(() => "extend")
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showGenericToolOutput() ? "Hide generic tool output" : "Show generic tool output",
      value: "session.toggle.generic_tool_output",
      category: "Session",
      onSelect: (dialog) => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      keybind: "messages_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      keybind: "messages_line_up",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      keybind: "messages_line_down",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      keybind: "messages_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      keybind: "messages_last",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Clear visible messages",
      value: "session.clear",
      keybind: "messages_clear",
      category: "Session",
      slash: {
        name: "clear",
      },
      onSelect: (dialog) => {
        clearVisibleMessages()
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: "Session",
      hidden: true,
      onSelect: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      keybind: "messages_next",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      keybind: "messages_copy",
      category: "Session",
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        Clipboard.copy(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              providers: sync.data.provider,
            },
          )
          await Clipboard.copy(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      keybind: "session_export",
      category: "Session",
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Filesystem.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Filesystem.write(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      keybind: "session_child_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        moveFirstChild()
        dialog.clear()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      keybind: "session_parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        moveChild(1)
        dialog.clear()
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      onSelect: childSessionHandler((dialog) => {
        moveChild(-1)
        dialog.clear()
      }),
    },
  ])

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  const renderedMessages = createMemo(() => {
    const cutoff = visualClearAfter()
    if (!cutoff) return messages()
    return messages().filter((message) => message.id > cutoff)
  })
  const renderedBtwTurnsAfter = (message: AssistantMessage | UserMessage, index: number) => {
    const next = renderedMessages()[index + 1]
    return sessionBtwTurns().filter((turn) => turn.id > message.id && (!next || turn.id < next.id))
  }
  const renderedLeadingBtwTurns = createMemo(() => {
    const first = renderedMessages()[0]
    return sessionBtwTurns().filter((turn) => !first || turn.id < first.id)
  })

  const messageMetrics = createMemo(() => {
    const result = new Map<string, MessageMetrics>()
    let startedAt: number | undefined
    let turnCodeStats = emptyCodeStats()

    for (const message of messages()) {
      const parts = sync.data.part[message.id] ?? []

      if (message.role === "user") {
        startedAt = message.time.created
        turnCodeStats = emptyCodeStats()
        result.set(message.id, { codeStats: emptyCodeStats() })
        continue
      }

      if (message.role === "assistant") {
        turnCodeStats = mergeCodeStats(turnCodeStats, messageCodeStats(parts))
        result.set(message.id, { startedAt, codeStats: turnCodeStats })
        continue
      }
    }

    return result
  })

  const livePromptTokens = createMemo(() => {
    const assistant = lastAssistant()
    if (!assistant) return 0
    if (assistant.time.completed) return 0
    const sessionMessages = messages()
    let promptTokens = 0
    let parent: UserMessage | undefined
    for (const message of sessionMessages) {
      promptTokens += (sync.data.part[message.id] ?? []).reduce((sum, part) => sum + estimatePromptPartTokens(part), 0)
      if (message.id !== assistant.parentID) continue
      if (message.role === "user") parent = message
      break
    }
    const providerModel = sync.data.provider.find((item) => item.id === assistant.providerID)?.models[assistant.modelID]
    return (
      promptTokens +
      Token.estimate(
        [
          ...(providerModel ? SystemPrompt.provider(providerModel as Parameters<typeof SystemPrompt.provider>[0]) : []),
          parent?.system ?? "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
    )
  })

  function estimateBtwPromptTokens(turn: BtwTurn, response: BtwResponse) {
    if (response.info.tokens.input > 0) return response.info.tokens.input
    const providerModel = sync.data.provider.find((item) => item.id === response.info.providerID)?.models[
      response.info.modelID
    ]
    const sessionPromptTokens = messages()
      .filter((message) => message.id < turn.id)
      .reduce(
        (sum, message) =>
          sum +
          (sync.data.part[message.id] ?? []).reduce((partSum, part) => partSum + estimatePromptPartTokens(part), 0),
        0,
      )
    return (
      sessionPromptTokens +
      Token.estimate(
        [
          ...(providerModel ? SystemPrompt.provider(providerModel as Parameters<typeof SystemPrompt.provider>[0]) : []),
          turn.question,
        ]
          .filter(Boolean)
          .join("\n"),
      )
    )
  }

  createEffect(() => {
    const assistant = lastAssistant()
    if (!assistant) {
      setLiveAssistant({ now: Date.now(), streamSamples: [] })
      return
    }
    setLiveAssistant((current) =>
      current.messageID === assistant.id
        ? current
        : {
            messageID: assistant.id,
            now: Date.now(),
            streamSamples: [],
          },
    )
    if (assistant.time.completed) return
    const timer = setInterval(() => {
      const now = Date.now()
      setLiveAssistant((current) =>
        current.messageID !== assistant.id
          ? current
          : {
              ...current,
              now,
              streamSamples: current.streamSamples
                .filter((sample) => now - sample.time <= STREAM_RATE_WINDOW)
                .slice(-STREAM_RATE_MAX_SAMPLES),
            },
      )
    }, STREAM_RATE_UPDATE_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })

  // snap to bottom when session changes
  createEffect(
    on(
      () => route.sessionID,
      () => setVisualClearAfter(undefined),
    ),
  )
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        sessionID: route.sessionID,
        conceal,
        showThinking,
        showTimestamps,
        showDetails,
        showGenericToolOutput,
        codeBlockExpansion,
        diffWrapMode,
        providers,
        sync,
        tui: tuiConfig,
      }}
    >
      <box flexDirection="row">
        <box flexGrow={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
          <Show when={session()}>
            <scrollbox
              ref={(r) => (scroll = r)}
              viewportOptions={{
                paddingRight: showScrollbar() ? 1 : 0,
              }}
              verticalScrollbarOptions={{
                paddingLeft: 1,
                visible: showScrollbar(),
                trackOptions: {
                  backgroundColor: theme.backgroundElement,
                  foregroundColor: theme.border,
                },
              }}
              stickyScroll={true}
              stickyStart="bottom"
              flexGrow={1}
              scrollAcceleration={scrollAcceleration()}
            >
              <box height={1} />
              <Index each={renderedLeadingBtwTurns()}>
                {(turn) => (
                  <BtwMessage
                    turn={turn}
                    live={(messageID) => liveBtwResponses()[messageID]}
                    estimatedPromptTokens={(response) => estimateBtwPromptTokens(turn(), response)}
                  />
                )}
              </Index>
              <For each={renderedMessages()}>
                {(message, index) => (
                  <>
                    <Switch>
                      <Match when={message.id === revert()?.messageID}>
                        {(function () {
                          const command = useCommandDialog()
                          const [hover, setHover] = createSignal(false)
                          const dialog = useDialog()

                          const handleUnrevert = async () => {
                            const confirmed = await DialogConfirm.show(
                              dialog,
                              "Confirm Redo",
                              "Are you sure you want to restore the reverted messages?",
                            )
                            if (confirmed) {
                              command.trigger("session.redo")
                            }
                          }

                          return (
                            <box
                              onMouseOver={() => setHover(true)}
                              onMouseOut={() => setHover(false)}
                              onMouseUp={handleUnrevert}
                              marginTop={1}
                              flexShrink={0}
                              border={["left"]}
                              customBorderChars={SplitBorder.customBorderChars}
                              borderColor={theme.backgroundPanel}
                            >
                              <box
                                paddingTop={1}
                                paddingBottom={1}
                                paddingLeft={2}
                                backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                              >
                                <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                                <text fg={theme.textMuted}>
                                  <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or /redo to
                                  restore
                                </text>
                                <Show when={revert()!.diffFiles?.length}>
                                  <box marginTop={1}>
                                    <For each={revert()!.diffFiles}>
                                      {(file) => (
                                        <text fg={theme.text}>
                                          {file.filename}
                                          <Show when={file.additions > 0}>
                                            <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                          </Show>
                                          <Show when={file.deletions > 0}>
                                            <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                          </Show>
                                        </text>
                                      )}
                                    </For>
                                  </box>
                                </Show>
                              </box>
                            </box>
                          )
                        })()}
                      </Match>
                      <Match when={revert()?.messageID && message.id >= revert()!.messageID}>
                        <></>
                      </Match>
                      <Match when={message.role === "user"}>
                        <UserMessage
                          index={index()}
                          onMouseUp={() => {
                            if (renderer.getSelection()?.getSelectedText()) return
                            dialog.replace(() => (
                              <DialogMessage
                                messageID={message.id}
                                sessionID={route.sessionID}
                                setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                              />
                            ))
                          }}
                          message={message as UserMessage}
                          parts={sync.data.part[message.id] ?? []}
                          pending={pending()}
                        />
                      </Match>
                      <Match when={message.role === "assistant"}>
                        <AssistantMessage
                          last={lastAssistant()?.id === message.id}
                          message={message as AssistantMessage}
                          parts={sync.data.part[message.id] ?? []}
                          metrics={messageMetrics().get(message.id)}
                          estimatedPromptTokens={lastAssistant()?.id === message.id ? livePromptTokens() : 0}
                          live={lastAssistant()?.id === message.id ? liveAssistant() : undefined}
                        />
                      </Match>
                    </Switch>
                    <Index each={renderedBtwTurnsAfter(message, index())}>
                      {(turn) => (
                        <BtwMessage
                          turn={turn}
                          live={(messageID) => liveBtwResponses()[messageID]}
                          estimatedPromptTokens={(response) => estimateBtwPromptTokens(turn(), response)}
                        />
                      )}
                    </Index>
                  </>
                )}
              </For>
            </scrollbox>
            <box flexShrink={0}>
              <Show when={permissions().length > 0}>
                <PermissionPrompt request={permissions()[0]} />
              </Show>
              <Show when={permissions().length === 0 && questions().length > 0}>
                <QuestionPrompt request={questions()[0]} />
              </Show>
              <Show when={session()?.parentID}>
                <SubagentFooter />
              </Show>
              <Show when={visible()}>
                <TuiPluginRuntime.Slot
                  name="session_prompt"
                  mode="replace"
                  session_id={route.sessionID}
                  visible={visible()}
                  disabled={disabled()}
                  on_submit={toBottom}
                  ref={bind}
                >
                  <Prompt
                    visible={visible()}
                    ref={bind}
                    disabled={disabled()}
                    onBtwSubmit={submitBtw}
                    activeActionLabel={activeActionLabel}
                    onSubmit={() => {
                      toBottom()
                    }}
                    sessionID={route.sessionID}
                    right={<TuiPluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                  />
                </TuiPluginRuntime.Slot>
              </Show>
            </box>
          </Show>
          <Toast />
        </box>
        <Show when={sidebarVisible()}>
          <Switch>
            <Match when={wide()}>
              <Sidebar sessionID={route.sessionID} />
            </Match>
            <Match when={!wide()}>
              <box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                alignItems="flex-end"
                backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
              >
                <Sidebar sessionID={route.sessionID} />
              </box>
            </Match>
          </Switch>
        </Show>
      </box>
    </context.Provider>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type === "text" && !x.synthetic) {
          return x.text
        }
        return null
      })
      .filter(Boolean)
    return texts.join("\n\n")
  })
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  return (
    <>
      <Show when={text()}>
        <box
          id={props.message.id}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = createMemo(() => {
                      if (file.mime.startsWith("image/")) return theme.accent
                      if (file.mime === "application/pdf") return theme.primary
                      return theme.secondary
                    })
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

function BtwMessage(props: {
  turn: () => BtwTurn
  live: (messageID: string) => LiveAssistantMetrics | undefined
  estimatedPromptTokens: (response: BtwResponse) => number
}) {
  const { theme } = useTheme()
  const codeStats = createMemo(() =>
    props.turn().responses.reduce((sum, response) => mergeCodeStats(sum, response.codeStats), emptyCodeStats()),
  )

  return (
    <>
      <box
        id={props.turn().id}
        border={["left"]}
        borderColor={theme.warning}
        customBorderChars={SplitBorder.customBorderChars}
        marginTop={1}
        flexShrink={0}
      >
        <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel} flexShrink={0}>
          <text fg={theme.text}>
            <span style={{ bg: theme.warning, fg: theme.background, bold: true }}> Btw </span> {props.turn().question}
          </text>
        </box>
      </box>
      <Show when={props.turn().error}>
        {(error) => (
          <box paddingLeft={3}>
            <CompactErrorBlock title="Btw failed" error={error()} />
          </box>
        )}
      </Show>
      <Index each={props.turn().responses}>
        {(response, index) => (
          <BtwResponseMessage
            response={response}
            showFooter={() => index === props.turn().responses.length - 1}
            live={() => props.live(response().info.id)}
            startedAt={() => props.turn().startedAt}
            estimatedPromptTokens={() => props.estimatedPromptTokens(response())}
            codeStats={codeStats}
          />
        )}
      </Index>
    </>
  )
}

function BtwResponseMessage(props: {
  response: () => BtwResponse
  showFooter: () => boolean
  live: () => LiveAssistantMetrics | undefined
  startedAt: () => number
  estimatedPromptTokens: () => number
  codeStats: () => CodeStats
}) {
  return (
    <>
      <Index each={props.response().parts}>
        {(part, index) => (
          <MessagePart
            part={part()}
            message={props.response().info}
            last={index === props.response().parts.length - 1}
          />
        )}
      </Index>
      <Show when={props.showFooter()}>
        <BtwResponseFooter
          response={props.response}
          live={props.live}
          startedAt={props.startedAt}
          estimatedPromptTokens={props.estimatedPromptTokens}
          codeStats={props.codeStats}
        />
      </Show>
    </>
  )
}

function BtwResponseFooter(props: {
  response: () => BtwResponse
  live: () => LiveAssistantMetrics | undefined
  startedAt: () => number
  estimatedPromptTokens: () => number
  codeStats: () => CodeStats
}) {
  const ctx = use()
  const { theme } = useTheme()
  const [smoothedLiveTokensPerSecond, setSmoothedLiveTokensPerSecond] = createSignal(0)
  const [latestLiveTokensPerSecond, setLatestLiveTokensPerSecond] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const model = createMemo(() =>
    Model.name(ctx.providers(), props.response().info.providerID, props.response().info.modelID),
  )
  const final = createMemo(() => {
    const finish = props.response().info.finish
    return Boolean(finish && !["tool-calls", "unknown"].includes(finish))
  })
  const live = createMemo(() => (!final() ? props.live() : undefined))
  const derived = createMemo(() => assistantDerivedMetrics(props.response().parts))
  const duration = createMemo(() => {
    const end = final() ? props.response().info.time.completed : (live()?.now ?? now())
    if (!end) return 0
    return Math.max(0, end - props.startedAt())
  })
  const generationDuration = createMemo(() => {
    const generationStartedAt = live()?.firstTokenAt ?? live()?.textStartedAt ?? derived().generationStartedAt
    if (!generationStartedAt) return 0
    const end = final() ? props.response().info.time.completed : (live()?.now ?? now())
    if (!end) return 0
    return Math.max(0, end - generationStartedAt)
  })
  const promptProcessingDuration = createMemo(() => {
    const end = live()?.firstTokenAt ?? derived().responseStartedAt ?? live()?.now ?? now()
    return Math.max(0, end - props.startedAt())
  })
  const promptTokensPerSecond = createMemo(() => {
    const serverRate = live()?.promptTokensPerSecond
    if (serverRate !== undefined) return serverRate
    const inputTokens = live()?.promptTokens ?? props.estimatedPromptTokens()
    if (inputTokens <= 0) return 0
    const seconds = Math.max(promptProcessingDuration(), PROMPT_RATE_MIN_WINDOW) / 1000
    return inputTokens / seconds
  })
  const liveWindowTokensPerSecond = createMemo(() => {
    const current = live()?.now ?? now()
    const recent = (live()?.streamSamples ?? []).filter((sample) => current - sample.time <= STREAM_RATE_WINDOW)
    if (recent.length === 0) return 0
    const tokens = recent.reduce((total, sample) => total + sample.tokens, 0)
    const started = live()?.firstTokenAt ?? live()?.textStartedAt ?? recent[0]?.time
    if (!started) return 0
    const seconds = Math.max(current - Math.min(started, recent[0]?.time ?? started), STREAM_RATE_MIN_WINDOW) / 1000
    return tokens / seconds
  })
  const averageLiveTokensPerSecond = createMemo(() => {
    if (final()) return 0
    if (derived().estimatedOutputTokens <= 0) return 0
    if (generationDuration() <= 0) return 0
    return derived().estimatedOutputTokens / (generationDuration() / 1000)
  })
  const liveTokensPerSecond = createMemo(() => {
    if (final()) return 0
    const serverRate = live()?.outputTokensPerSecond
    if (serverRate !== undefined) return serverRate
    const outputTokens = live()?.outputTokens ?? 0
    if (outputTokens > 0 && generationDuration() > 0) return outputTokens / (generationDuration() / 1000)
    const windowed = liveWindowTokensPerSecond()
    if (windowed > 0) return windowed
    return averageLiveTokensPerSecond()
  })
  const finalTokensPerSecond = createMemo(() => {
    const serverRate = derived().outputTokensPerSecond
    if (serverRate !== undefined) return serverRate
    if (!final()) return 0
    if (generationDuration() <= 0) return 0
    const outputTokens =
      props.response().info.tokens.output > 0 ? props.response().info.tokens.output : derived().estimatedOutputTokens
    if (outputTokens <= 0) return 0
    return outputTokens / (generationDuration() / 1000)
  })
  const displayLiveTokensPerSecond = createMemo(() => {
    const serverRate = live()?.outputTokensPerSecond
    if (serverRate !== undefined) return serverRate
    const smoothed = smoothedLiveTokensPerSecond()
    if (smoothed > 0) return smoothed
    return liveTokensPerSecond()
  })
  const metrics = createMemo(() => {
    if (final()) {
      const outputRate = finalTokensPerSecond()
      return [
        outputRate > 0 ? `↑ ${formatTokensPerSecond(outputRate)}` : "",
        duration() > 0 ? Locale.duration(duration()) : "",
      ].filter(Boolean)
    }

    if (!live()?.firstTokenAt && (live()?.outputTokens ?? 0) <= 0) {
      return [
        `↓ ${formatTokensPerSecond(promptTokensPerSecond())}`,
        duration() > 0 ? Locale.duration(duration()) : "",
      ].filter(Boolean)
    }

    return [
      `↑ ${formatTokensPerSecond(displayLiveTokensPerSecond())}`,
      duration() > 0 ? Locale.duration(duration()) : "",
    ].filter(Boolean)
  })
  const codeStats = createMemo(() => (final() ? props.codeStats() : emptyCodeStats()))

  createEffect(() => {
    setLatestLiveTokensPerSecond(liveTokensPerSecond())
  })

  createEffect(() => {
    if (final()) return
    if (!live()) return
    const timer = setInterval(() => {
      const next = latestLiveTokensPerSecond()
      const prev = smoothedLiveTokensPerSecond()
      if (next <= 0) {
        setSmoothedLiveTokensPerSecond(prev * (1 - STREAM_RATE_SMOOTHING))
        return
      }
      if (prev <= 0) {
        setSmoothedLiveTokensPerSecond(next)
        return
      }
      setSmoothedLiveTokensPerSecond(prev + (next - prev) * STREAM_RATE_SMOOTHING)
    }, STREAM_RATE_UPDATE_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    if (props.response().info.time.completed) return
    const timer = setInterval(() => setNow(Date.now()), STREAM_RATE_UPDATE_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box paddingLeft={3}>
      <text marginTop={1}>
        <span style={{ fg: theme.warning }}>▣ </span>
        <span style={{ fg: theme.text }}>Btw</span>
        <span style={{ fg: theme.textMuted }}> · {model()}</span>
        <Show when={metrics().length > 0}>
          <span style={{ fg: theme.textMuted }}> · {metrics().join(" · ")}</span>
        </Show>
        <Show when={codeStats().additions > 0 || codeStats().deletions > 0}>
          <span style={{ fg: theme.textMuted }}> · </span>
          <Show when={codeStats().additions > 0}>
            <span style={{ fg: theme.diffAdded }}>+{formatCompactTokens(codeStats().additions)}</span>
          </Show>
          <Show when={codeStats().additions > 0 && codeStats().deletions > 0}>
            <span style={{ fg: theme.textMuted }}> </span>
          </Show>
          <Show when={codeStats().deletions > 0}>
            <span style={{ fg: theme.diffRemoved }}>-{formatCompactTokens(codeStats().deletions)}</span>
          </Show>
        </Show>
      </text>
    </box>
  )
}

function AssistantMessage(props: {
  message: AssistantMessage
  parts: Part[]
  last: boolean
  metrics?: MessageMetrics
  estimatedPromptTokens?: number
  live?: LiveAssistantMetrics
}) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const [smoothedLiveTokensPerSecond, setSmoothedLiveTokensPerSecond] = createSignal(0)
  const [latestLiveTokensPerSecond, setLatestLiveTokensPerSecond] = createSignal(0)
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  const live = createMemo(() => (!final() && props.last ? props.live : undefined))

  const derived = createMemo<AssistantDerivedMetrics>(() => assistantDerivedMetrics(props.parts))

  const startedAt = createMemo(() => {
    return props.metrics?.startedAt
  })

  const duration = createMemo(() => {
    if (!startedAt()) return 0
    const end = final() ? props.message.time.completed : live()?.now
    if (!end) return 0
    return Math.max(0, end - startedAt()!)
  })

  const estimatedOutputTokens = createMemo(() => derived().estimatedOutputTokens)

  const estimatedPromptTokens = createMemo(() => props.estimatedPromptTokens ?? 0)

  const generationDuration = createMemo(() => {
    const generationStartedAt = live()?.firstTokenAt ?? live()?.textStartedAt ?? derived().generationStartedAt
    if (!generationStartedAt) return 0
    const end = final() ? props.message.time.completed : live()?.now
    if (!end) return 0
    return Math.max(0, end - generationStartedAt)
  })

  const promptProcessingDuration = createMemo(() => {
    if (!startedAt()) return 0
    const end = live()?.firstTokenAt ?? derived().responseStartedAt ?? live()?.now
    if (!end) return 0
    return Math.max(0, end - startedAt()!)
  })

  const promptTokensPerSecond = createMemo(() => {
    const serverRate = live()?.promptTokensPerSecond
    if (serverRate !== undefined) return serverRate
    const inputTokens = live()?.promptTokens ?? estimatedPromptTokens()
    if (inputTokens <= 0) return 0
    const seconds = Math.max(promptProcessingDuration(), PROMPT_RATE_MIN_WINDOW) / 1000
    return inputTokens / seconds
  })

  const liveWindowTokensPerSecond = createMemo(() => {
    const current = live()?.now ?? 0
    const recent = (live()?.streamSamples ?? []).filter((sample) => current - sample.time <= STREAM_RATE_WINDOW)
    if (recent.length === 0) return 0
    const tokens = recent.reduce((total, sample) => total + sample.tokens, 0)
    const started = live()?.firstTokenAt ?? live()?.textStartedAt ?? recent[0]?.time
    if (!started) return 0
    const seconds = Math.max(current - Math.min(started, recent[0]?.time ?? started), STREAM_RATE_MIN_WINDOW) / 1000
    return tokens / seconds
  })

  const averageLiveTokensPerSecond = createMemo(() => {
    if (final()) return 0
    if (estimatedOutputTokens() <= 0) return 0
    if (generationDuration() <= 0) return 0
    return estimatedOutputTokens() / (generationDuration() / 1000)
  })

  const liveTokensPerSecond = createMemo(() => {
    if (final()) return 0
    const serverRate = live()?.outputTokensPerSecond
    if (serverRate !== undefined) return serverRate
    const outputTokens = live()?.outputTokens ?? 0
    if (outputTokens > 0 && generationDuration() > 0) return outputTokens / (generationDuration() / 1000)
    const windowed = liveWindowTokensPerSecond()
    if (windowed > 0) return windowed
    return averageLiveTokensPerSecond()
  })

  createEffect(() => {
    setLatestLiveTokensPerSecond(liveTokensPerSecond())
  })

  createEffect(() => {
    if (final()) return
    if (!props.last) return
    if (!live()) return
    const timer = setInterval(() => {
      const next = latestLiveTokensPerSecond()
      const prev = smoothedLiveTokensPerSecond()
      if (next <= 0) {
        setSmoothedLiveTokensPerSecond(prev * (1 - STREAM_RATE_SMOOTHING))
        return
      }
      if (prev <= 0) {
        setSmoothedLiveTokensPerSecond(next)
        return
      }
      setSmoothedLiveTokensPerSecond(prev + (next - prev) * STREAM_RATE_SMOOTHING)
    }, STREAM_RATE_UPDATE_INTERVAL)
    onCleanup(() => clearInterval(timer))
  })

  const finalTokensPerSecond = createMemo(() => {
    const serverRate = derived().outputTokensPerSecond
    if (serverRate !== undefined) return serverRate
    if (!final()) return 0
    if (generationDuration() <= 0) return 0
    const outputTokens = props.message.tokens.output > 0 ? props.message.tokens.output : estimatedOutputTokens()
    if (outputTokens <= 0) return 0
    return outputTokens / (generationDuration() / 1000)
  })

  const displayLiveTokensPerSecond = createMemo(() => {
    const serverRate = live()?.outputTokensPerSecond
    if (serverRate !== undefined) return serverRate
    const smoothed = smoothedLiveTokensPerSecond()
    if (smoothed > 0) return smoothed
    return liveTokensPerSecond()
  })

  const metrics = createMemo(() => {
    if (final()) {
      const outputRate = finalTokensPerSecond()
      return [
        outputRate > 0 ? `↑ ${formatTokensPerSecond(outputRate)}` : "",
        duration() > 0 ? Locale.duration(duration()) : "",
      ].filter(Boolean)
    }

    if (!live()?.firstTokenAt && (live()?.outputTokens ?? 0) <= 0) {
      return [
        `↓ ${formatTokensPerSecond(promptTokensPerSecond())}`,
        duration() > 0 ? Locale.duration(duration()) : "",
      ].filter(Boolean)
    }

    return [
      `↑ ${formatTokensPerSecond(displayLiveTokensPerSecond())}`,
      duration() > 0 ? Locale.duration(duration()) : "",
    ].filter(Boolean)
  })

  const codeStats = createMemo(() => {
    if (!final()) return emptyCodeStats()
    return props.metrics?.codeStats ?? messageCodeStats(props.parts)
  })

  const keybind = useKeybind()

  return (
    <>
      <For each={props.parts}>
        {(part, index) => <MessagePart part={part} message={props.message} last={index() === props.parts.length - 1} />}
      </For>
      <Show when={props.parts.some((x) => x.type === "tool" && x.tool === "subagent")}>
        <box paddingTop={1} paddingLeft={3}>
          <text fg={theme.text}>
            {keybind.print("session_child_first")}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
          </text>
        </box>
      </Show>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box paddingLeft={3} flexShrink={0}>
          <CompactErrorBlock
            title={String(props.message.error?.name ?? "Message error")}
            error={String(props.message.error?.data.message ?? "")}
          />
        </box>
      </Show>
      <Switch>
        <Match when={props.last || final() || props.message.error?.name === "MessageAbortedError"}>
          <box paddingLeft={3}>
            <text marginTop={1}>
              <span
                style={{
                  fg:
                    props.message.error?.name === "MessageAbortedError"
                      ? theme.textMuted
                      : local.agent.color(props.message.agent),
                }}
              >
                ▣{" "}
              </span>{" "}
              <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
              <span style={{ fg: theme.textMuted }}> · {model()}</span>
              <Show when={metrics().length > 0}>
                <span style={{ fg: theme.textMuted }}> · {metrics().join(" · ")}</span>
              </Show>
              <Show when={codeStats().additions > 0 || codeStats().deletions > 0}>
                <span style={{ fg: theme.textMuted }}> · </span>
                <Show when={codeStats().additions > 0}>
                  <span style={{ fg: theme.diffAdded }}>+{formatCompactTokens(codeStats().additions)}</span>
                </Show>
                <Show when={codeStats().additions > 0 && codeStats().deletions > 0}>
                  <span style={{ fg: theme.textMuted }}> </span>
                </Show>
                <Show when={codeStats().deletions > 0}>
                  <span style={{ fg: theme.diffRemoved }}>-{formatCompactTokens(codeStats().deletions)}</span>
                </Show>
              </Show>
              <Show when={props.message.error?.name === "MessageAbortedError"}>
                <span style={{ fg: theme.textMuted }}> · interrupted</span>
              </Show>
            </text>
          </box>
        </Match>
      </Switch>
    </>
  )
}

function reasoningContent(text: string) {
  return ThinkTags.strip(text).replace("[REDACTED]", "").trim()
}

function assistantPartVisible(part: Part, showThinking: boolean, showDetails: boolean) {
  if (part.type === "text") return part.text.trim().length > 0
  if (part.type === "reasoning") return showThinking && reasoningContent(part.text).length > 0
  if (part.type !== "tool") return false
  if (showDetails) return true
  return part.state.status !== "completed"
}

function formatTokensPerSecond(value: number) {
  if (value >= 100) return `${value.toFixed(1)} t/s`
  return `${value.toFixed(2)} t/s`
}

function estimateStreamTokens(delta: string) {
  if (!delta) return 0
  return Math.max(1, Token.estimate(delta))
}

function assistantDerivedMetrics(parts: Part[]): AssistantDerivedMetrics {
  let responseStartedAt: number | undefined
  let generationStartedAt: number | undefined
  let promptTokensPerSecond: number | undefined
  let outputTokensPerSecond: number | undefined
  let estimatedOutputTokens = 0

  for (const part of parts) {
    if (part.type === "text") {
      estimatedOutputTokens += Token.estimate(part.text)
      generationStartedAt = generationStartedAt ?? part.time?.start
      responseStartedAt = responseStartedAt ?? part.time?.start
      continue
    }
    if (part.type === "reasoning") {
      responseStartedAt = responseStartedAt ?? part.time.start
      continue
    }
    if (part.type === "step-finish") {
      const timings = llamaCppTimings("metadata" in part ? part.metadata : undefined)
      promptTokensPerSecond = timings.promptTokensPerSecond ?? promptTokensPerSecond
      outputTokensPerSecond = timings.outputTokensPerSecond ?? outputTokensPerSecond
    }
  }

  return {
    estimatedOutputTokens,
    responseStartedAt,
    generationStartedAt,
    promptTokensPerSecond,
    outputTokensPerSecond,
  }
}

function llamaCppTimings(metadata: unknown) {
  const root = recordValue(metadata)
  if (!root) return {}
  for (const value of Object.values(root)) {
    const provider = recordValue(value)
    const timings = recordValue(provider?.timings)
    if (!timings) continue
    return {
      promptTokensPerSecond: positiveNumber(timings.prompt_per_second),
      outputTokensPerSecond: positiveNumber(timings.predicted_per_second),
    }
  }
  return {}
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function positiveNumber(value: unknown) {
  if (typeof value !== "number") return
  if (!Number.isFinite(value) || value <= 0) return
  return value
}

function shortBtwActionLabel(name: string) {
  if (["bash", "shell", "execute", "command"].includes(name)) return "execute"
  if (["read", "view"].includes(name)) return "read"
  if (["write", "edit"].includes(name)) return "write"
  if (["apply_patch"].includes(name)) return "patching"
  if (["glob"].includes(name)) return "glob"
  if (["grep", "search"].includes(name)) return "search"
  if (["todowrite", "plan"].includes(name)) return "plan"
  if (["webfetch", "fetch"].includes(name)) return "fetch"
  if (["question", "ask"].includes(name)) return "asking"
  if (["skill", "load"].includes(name)) return "loading"
  return name.length > 12 ? name.slice(0, 12) : name
}

function btwTitleActionLabel(title: string, tool: string) {
  const value = title.trim().toLowerCase()
  if (!value) return shortBtwActionLabel(tool)
  if (value.startsWith("read")) return "read"
  if (value.startsWith("write")) return "write"
  if (value.startsWith("edit")) return "write"
  if (value.startsWith("patch")) return "patching"
  if (value.startsWith("search")) return "search"
  if (value.startsWith("grep")) return "search"
  if (value.startsWith("glob")) return "glob"
  if (value.startsWith("find")) return "glob"
  if (value.startsWith("fetch")) return "fetch"
  if (value.startsWith("ask")) return "asking"
  if (value.startsWith("load")) return "loading"
  if (value.startsWith("updat")) return "plan"
  if (value.startsWith("think")) return "reasoning"
  return shortBtwActionLabel(tool)
}

function btwToolActionLabel(part: ToolPart) {
  if (part.state.status === "running" || part.state.status === "completed") {
    if (part.state.title) return btwTitleActionLabel(part.state.title, part.tool)
  }
  return shortBtwActionLabel(part.tool)
}

function btwActionLabel(parts: Part[]) {
  const runningTool = parts.findLast(
    (part): part is ToolPart => part.type === "tool" && part.state.status === "running",
  )
  if (runningTool) return btwToolActionLabel(runningTool)

  const pendingTool = parts.findLast(
    (part): part is ToolPart => part.type === "tool" && part.state.status === "pending",
  )
  if (pendingTool) return btwToolActionLabel(pendingTool)

  const lastPart = parts.at(-1)
  if (lastPart?.type === "reasoning") return "reasoning"
  if (lastPart?.type === "text") return "reply"
  if (parts.some((part) => part.type === "reasoning")) return "reasoning"
  if (parts.some((part) => part.type === "text")) return "reply"
  return "processing"
}

function messageCodeStats(parts: Part[]) {
  return parts.reduce((sum, part) => {
    if (part.type !== "tool") return sum
    if (part.state.status !== "completed") return sum

    const countedMetadata = addCodeStats(sum, part.state.metadata)
    const countedFilediff = countedMetadata ? false : addCodeStats(sum, part.state.metadata?.filediff)
    const files = part.state.metadata?.files
    const countedFiles =
      countedMetadata || countedFilediff
        ? false
        : Array.isArray(files)
          ? files.reduce((counted, file) => addCodeStats(sum, file) || counted, false)
          : false
    const countedDiff =
      countedMetadata || countedFilediff || countedFiles ? false : addDiffStats(sum, part.state.metadata?.diff)
    const input = isRecord(part.state.input) ? part.state.input : undefined
    if (
      !countedMetadata &&
      !countedFilediff &&
      !countedFiles &&
      !countedDiff &&
      part.tool === "write" &&
      part.state.metadata?.exists !== true
    ) {
      sum.additions += countLines(stringValue(input?.content) ?? "")
    }

    return sum
  }, emptyCodeStats())
}

function emptyCodeStats() {
  return { additions: 0, deletions: 0 }
}

function mergeCodeStats(left: CodeStats, right: CodeStats) {
  return {
    additions: left.additions + right.additions,
    deletions: left.deletions + right.deletions,
  }
}

function maxCodeStats(left: CodeStats, right: CodeStats) {
  return {
    additions: Math.max(left.additions, right.additions),
    deletions: Math.max(left.deletions, right.deletions),
  }
}

function addCodeStats(sum: { additions: number; deletions: number }, value: unknown) {
  if (!isRecord(value)) return false
  const additions = numberValue(value.additions) ?? 0
  const deletions = numberValue(value.deletions) ?? 0
  sum.additions += additions
  sum.deletions += deletions
  return typeof value.additions === "number" || typeof value.deletions === "number"
}

function addDiffStats(sum: { additions: number; deletions: number }, value: unknown) {
  if (typeof value !== "string") return false
  const stats = value.split("\n").reduce(
    (acc, line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return acc
      if (line.startsWith("+")) return { additions: acc.additions + 1, deletions: acc.deletions }
      if (line.startsWith("-")) return { additions: acc.additions, deletions: acc.deletions + 1 }
      return acc
    },
    { additions: 0, deletions: 0 },
  )
  sum.additions += stats.additions
  sum.deletions += stats.deletions
  return value.length > 0
}

function countLines(value: string) {
  if (!value) return 0
  const lines = value.split("\n")
  return value.endsWith("\n") ? lines.length - 1 : lines.length
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function estimatePromptPartTokens(part: Part) {
  if (part.type === "text") return part.synthetic ? 0 : Token.estimate(part.text)
  if (part.type === "reasoning") return Token.estimate(part.text)
  if (part.type === "file") return Token.estimate(part.filename ?? part.mime ?? "file")
  if (part.type === "agent") return Token.estimate(part.name)
  if (part.type === "subtask") {
    return Token.estimate([part.prompt, part.description, part.command].filter(Boolean).join("\n"))
  }
  if (part.type === "tool") {
    const input = part.state.input ? Token.estimate(JSON.stringify(part.state.input)) : 0
    if (part.state.status === "completed") return input + Token.estimate(part.state.output)
    if (part.state.status === "error") return input + Token.estimate(part.state.error)
    return input
  }
  if (part.type === "retry") return Token.estimate(JSON.stringify(part.error))
  return 0
}

function MessagePart(props: { last: boolean; part: Part; message: AssistantMessage }) {
  if (props.part.type === "text") return <TextPart last={props.last} part={props.part} message={props.message} />
  if (props.part.type === "tool") return <ToolPart last={props.last} part={props.part} message={props.message} />
  if (props.part.type === "reasoning")
    return <ReasoningPart last={props.last} part={props.part} message={props.message} />
  return <></>
}

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme, subtleSyntax } = useTheme()
  const ctx = use()
  const streaming = createMemo(() => !props.message.time.completed)
  const content = createMemo(() => {
    // Filter out redacted reasoning chunks from OpenRouter
    // OpenRouter sends encrypted reasoning data that appears as [REDACTED]
    return reasoningContent(props.part.text)
  })
  return (
    <Show when={content() && ctx.showThinking()}>
      <box
        id={"text-" + props.part.id}
        paddingLeft={2}
        marginTop={1}
        flexDirection="column"
        border={["left"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.backgroundElement}
      >
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={streaming()}
          syntaxStyle={subtleSyntax()}
          content={"_Thinking:_ " + content()}
          conceal={ctx.conceal()}
          fg={theme.textMuted}
        />
      </box>
    </Show>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const streaming = createMemo(() => !props.message.time.completed)
  return (
    <Show when={props.part.text.trim()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
        <Switch>
          <Match when={Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
            <markdown
              syntaxStyle={syntax()}
              streaming={streaming()}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.markdownText}
              bg={theme.background}
            />
          </Match>
          <Match when={!Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={streaming()}
              syntaxStyle={syntax()}
              content={props.part.text.trim()}
              conceal={ctx.conceal()}
              fg={theme.text}
            />
          </Match>
        </Switch>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const sync = useSync()

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={props.part.tool === ShellID.ToolID}>
          <Shell {...toolprops} />
        </Match>
        <Match when={props.part.tool === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={props.part.tool === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={props.part.tool === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={props.part.tool === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={props.part.tool === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={props.part.tool === "subagent"}>
          <Task {...toolprops} />
        </Match>
        <Match when={props.part.tool === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={props.part.tool === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={props.part.tool === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={props.part.tool === "invalid"}>
          <InvalidToolCall {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps<T> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolPart
}

function invalidToolError(value: string) {
  const compact = value.replace(/\\n/g, " ").replace(/\s+/g, " ").trim()
  const json = compact.match(/JSON Parse error:[^\]]+/i)?.[0]
  if (json) return json
  const message = compact.split("Error message:").at(-1)?.replace(/\]+$/, "").trim()
  return Locale.truncate(message || compact || "Invalid arguments", 140)
}

function toolErrorSummary(value: string) {
  const compact = value.replace(/\\n/g, " ").replace(/\s+/g, " ").trim()
  const patch = compact.match(/^(apply_patch verification failed: Error: Failed to find expected lines in [^:]+):/)
  if (patch) return Locale.truncate(patch[1], 180)
  const json = compact.match(/JSON Parse error:[^\]]+/i)?.[0]
  if (json) return json
  return Locale.truncate(compact || "Tool error", 180)
}

function toolErrorTitle(value: string, fallback = "Tool error", tool?: string) {
  const compact = value.replace(/\\n/g, " ").replace(/\s+/g, " ").trim()
  if (/QuestionRejectedError|rejected permission|specified a rule|user dismissed/i.test(compact)) return "Permission rejected"
  if (/apply_patch verification failed|patch rejected/i.test(compact)) return "Patch failed"
  if (/too many redirects/i.test(compact)) return "Too many redirects"
  if (/timed?\s*out|timeout/i.test(compact) && ["webfetch", "fetch"].includes(tool ?? "")) return "Request timed out"
  if (/timed?\s*out|timeout/i.test(compact)) return "Command timed out"
  if (/aborted|abort/i.test(compact)) return "Command aborted"
  if (/JSON Parse error|Invalid arguments/i.test(compact)) return "Invalid tool call"
  return fallback
}

function CompactErrorBlock(props: {
  error: string
  title?: string
  tool?: string
  icon?: string
  marginTop?: number
  marginBottom?: number
  variant?: "error" | "warning"
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => props.error.trim())
  const title = createMemo(() => props.title ?? toolErrorTitle(error(), "Tool error", props.tool))
  const summary = createMemo(() => toolErrorSummary(error()))
  const color = createMemo(() => (props.variant === "warning" ? theme.warning : theme.error))
  return (
    <box
      border={["left"]}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      marginTop={props.marginTop ?? 1}
      marginBottom={props.marginBottom ?? 0}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      borderColor={color()}
      customBorderChars={SplitBorder.customBorderChars}
      onMouseUp={(evt) => {
        evt.stopPropagation()
        if (renderer.getSelection()?.getSelectedText()) return
        setExpanded((prev) => !prev)
      }}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      flexShrink={0}
    >
      <text fg={color()} wrapMode="none" overflow="hidden">
        {props.icon ?? "!"} {title()} <span style={{ fg: theme.textMuted }}>· {summary()}</span>
      </text>
      <Show when={expanded()}>
        <text fg={theme.textMuted} wrapMode="word">
          {error() || summary()}
        </text>
      </Show>
    </box>
  )
}

function InvalidToolCall(props: ToolProps<any>) {
  const input = props.input as Record<string, unknown>
  const tool = stringValue(input.tool) ?? "tool"
  const error = createMemo(() => stringValue(input.error) ?? props.output ?? "")
  return (
    <box paddingLeft={3} flexShrink={0}>
      <CompactErrorBlock title={`Invalid ${tool} call`} error={error() || invalidToolError(error())} variant="warning" />
    </box>
  )
}

function GenericTool(props: ToolProps<any>) {
  const { theme } = useTheme()
  const ctx = use()
  const active = createMemo(() => longRunningToolActive(props.part))
  const output = createMemo(() => props.output?.trim() ?? "")
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const maxLines = 3
  const overflow = createMemo(() => lines().length > maxLines)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, maxLines), "…"].join("\n")
  })

  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool
          icon="⚙"
          pending="Running tool..."
          complete={props.part.state.status === "completed"}
          spinner={active()}
          subtleSpinner={true}
          part={props.part}
        >
          {props.tool} {input(props.input)}
        </InlineTool>
      }
    >
      <BlockTool
        title={`# ${props.tool} ${input(props.input)}`}
        part={props.part}
        onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={overflow()}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  spinner?: boolean
  subtleSpinner?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
}) {
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const complete = createMemo(() => props.part.state.status === "error" || !!props.complete)

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (hover() && props.onClick) return theme.text
    if (complete()) return theme.textMuted
    return theme.text
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))
  const subtleSpinnerColor = createMemo(() => tint(theme.textMuted, theme.text, 0.18))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  return (
    <box
      marginTop={margin()}
      flexDirection="column"
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) return
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.id.startsWith("msg_") || previous.id.startsWith("text-") || previous.id.startsWith("tool-block-")) {
          setMargin(1)
          return
        }
        setMargin(0)
      }}
    >
      <box paddingLeft={3}>
        <Switch>
          <Match when={props.spinner}>
            <Spinner
              color={props.subtleSpinner ? subtleSpinnerColor() : fg()}
              frames={props.subtleSpinner ? inlineToolSpinnerFrames : undefined}
              interval={props.subtleSpinner ? 120 : undefined}
              children={props.children}
            />
          </Match>
          <Match when={true}>
            <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
              <Show fallback={<>~ {props.pending}</>} when={complete()}>
                <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
              </Show>
            </text>
          </Match>
        </Switch>
      </box>
      <Show when={error()}>
        {(message) => <CompactErrorBlock error={message()} tool={props.part.tool} marginBottom={1} />}
      </Show>
    </box>
  )
}

const inlineToolSpinnerFrames = ["◜", "◠", "◝", "◞", "◡", "◟"]

function longRunningToolActive(part: ToolPart) {
  return part.state.status === "pending" || part.state.status === "running"
}

function blockToolTitle(title: string) {
  return title.replace(/^#\s*/, "")
}

function shellOutput(raw: string) {
  const metadata = raw.match(/\n*<shell_metadata>\n([\s\S]*?)\n<\/shell_metadata>\s*$/)
  const notes = metadata?.[1]?.split("\n").filter(Boolean) ?? []
  const output = (metadata ? raw.slice(0, metadata.index).trim() : raw).trim()
  return {
    output: output === "(no output)" ? "" : output,
    notes,
  }
}

function shellNoteIsError(note: string) {
  return /aborted|abort|timed?\s*out|timeout|error/i.test(note)
}

function shellNoteTitle(note: string) {
  return toolErrorTitle(note, "Shell error")
}

function BlockTool(props: {
  title: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
  spinnerInterval?: number
  marker?: boolean
  markerColor?: RGBA
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  const hasError = createMemo(() => !!error())
  return (
    <box
      id={`tool-block-${props.part?.id ?? blockToolTitle(props.title)}`}
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      marginTop={1}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={hasError() ? theme.error : theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show
        when={props.spinner}
        fallback={
          <box flexDirection="row" gap={1}>
            <Show when={props.marker}>
              <text fg={props.markerColor ?? theme.textMuted}>#</text>
            </Show>
            <text fg={hasError() ? theme.error : theme.textMuted}>{blockToolTitle(props.title)}</text>
          </box>
        }
      >
        <Spinner color={theme.textMuted} interval={props.spinnerInterval}>
          {blockToolTitle(props.title)}
        </Spinner>
      </Show>
      {props.children}
      <Show when={error()}>
        {(message) => <CompactErrorBlock error={message()} tool={props.part?.tool} marginBottom={1} />}
      </Show>
    </box>
  )
}

function Shell(props: ToolProps<typeof ShellTool>) {
  const { theme, syntax } = useTheme()
  const ctx = use()
  const sync = useSync()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const parsed = createMemo(() => shellOutput(stripAnsi((props.output ?? props.metadata.output ?? "").trim())))
  const output = createMemo(() => parsed().output)
  const notes = createMemo(() => parsed().notes)
  const exit = createMemo(() => (typeof props.metadata.exit === "number" || props.metadata.exit === null ? props.metadata.exit : undefined))
  const markerColor = createMemo(() => (exit() === 0 ? theme.success : exit() !== undefined ? theme.error : theme.textMuted))
  const previewWidth = createMemo(() => Math.max(20, ctx.width - 28))
  const clip = (line: string) => (line.length > previewWidth() ? line.slice(0, previewWidth() - 1) + "…" : line)
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const overflow = createMemo(() => lines().length > 10)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return lines().slice(0, 10).join("\n")
  })
  const runningPreview = createMemo(() => {
    const visible = (output() ? lines().slice(-3) : ["waiting for command output..."]).map(clip)
    return visible.join("\n")
  })

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined

    const base = sync.path.directory
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Global.Path.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })

  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  return (
    <Switch>
      <Match when={isRunning()}>
        <BlockTool title={title()} part={props.part} spinner={true} spinnerInterval={180}>
          <box gap={0}>
            <text fg={theme.text} wrapMode="char" width="100%">
              $ {props.input.command ?? ""}
            </text>
            <code
              conceal={false}
              fg={output() ? theme.text : theme.textMuted}
              filetype="text"
              syntaxStyle={syntax()}
              wrapMode="none"
              truncate={true}
              content={runningPreview()}
            />
          </box>
        </BlockTool>
      </Match>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          marker
          markerColor={markerColor()}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={0}>
            <text fg={theme.text} wrapMode="char" width="100%">
              $ {props.input.command}
            </text>
            <Show when={output()}>
              <text fg={theme.text}>{limited()}</text>
            </Show>
            <For each={notes()}>
              {(note) => (
                <Show when={shellNoteIsError(note)} fallback={<text fg={theme.warning}>{note}</text>}>
                  <CompactErrorBlock title={shellNoteTitle(note)} error={note} marginTop={0} />
                </Show>
              )}
            </For>
            <Show when={overflow()}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function PendingToolPreview(props: { content: string; filePath?: string; title: string; filetype?: string; part: ToolPart }) {
  const { theme, syntax } = useTheme()
  const normalized = createMemo(() => props.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"))
  const display = createMemo(() => normalized() || "waiting for streamed tool input...")
  const lines = createMemo(() => display().split("\n"))
  const visibleLines = createMemo(() => lines().slice(-3))
  const firstLine = createMemo(() => Math.max(1, lines().length - visibleLines().length + 1))
  const currentLine = createMemo(() => Math.max(1, lines().length))
  const lineNumberWidth = createMemo(() => Math.max(3, String(currentLine()).length))
  const preview = createMemo(() =>
    [...visibleLines(), ...Array(Math.max(0, 3 - visibleLines().length)).fill("")].join("\n"),
  )

  return (
    <BlockTool title={`${props.title} · line ${currentLine()}`} part={props.part} spinner={true}>
      <line_number fg={theme.textMuted} minWidth={lineNumberWidth()} paddingRight={1} lineNumberOffset={firstLine() - 1}>
        <code
          conceal={false}
          fg={normalized() ? theme.text : theme.textMuted}
          filetype={props.filetype === "diff" ? "none" : (props.filetype ?? filetype(props.filePath))}
          syntaxStyle={syntax()}
          streaming={true}
          wrapMode="none"
          truncate={true}
          content={preview()}
        />
      </line_number>
    </BlockTool>
  )
}

function CollapsibleCodeBlock(props: { content: string; filePath?: string }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(ctx.codeBlockExpansion() === "extend")
  const lines = createMemo(() => props.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"))
  const limit = createMemo(() => Math.max(1, ctx.tui.code_block?.collapse_lines ?? 10))
  const overflow = createMemo(() => lines().length > limit())
  const visibleLines = createMemo(() => (expanded() || !overflow() ? lines() : lines().slice(0, limit())))
  const visibleContent = createMemo(() => visibleLines().join("\n"))
  const lineNumberWidth = createMemo(() => Math.max(3, String(lines().length).length))
  const hidden = createMemo(() => Math.max(0, lines().length - limit()))

  createEffect(on(ctx.codeBlockExpansion, (mode) => setExpanded(mode === "extend")))

  return (
    <box
      onMouseUp={() => {
        if (!overflow()) return
        if (renderer.getSelection()?.getSelectedText()) return
        setExpanded((prev) => !prev)
      }}
    >
      <line_number fg={theme.textMuted} minWidth={lineNumberWidth()} paddingRight={1}>
        <code
          conceal={false}
          fg={theme.text}
          filetype={filetype(props.filePath)}
          syntaxStyle={syntax()}
          wrapMode="none"
          truncate={true}
          content={visibleContent()}
        />
      </line_number>
      <Show when={overflow()}>
        <text paddingLeft={lineNumberWidth() + 4} fg={theme.textMuted}>
          {expanded() ? "Click to collapse" : `${hidden()} more lines · Click to extend`}
        </text>
      </Show>
    </box>
  )
}

function CollapsibleDiffBlock(props: { diff: string; filePath?: string; view: "split" | "unified" }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(ctx.codeBlockExpansion() === "extend")
  const lines = createMemo(() => props.diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"))
  const limit = createMemo(() => Math.max(1, ctx.tui.code_block?.collapse_lines ?? 10))
  const overflow = createMemo(() => lines().length > limit())
  const preview = createMemo(() => diffPreview(props.diff, limit()))
  const visibleDiff = createMemo(() => toRenderableDiff(expanded() || !overflow() ? props.diff : preview()))
  const hidden = createMemo(() => Math.max(0, lines().length - limit()))

  createEffect(on(ctx.codeBlockExpansion, (mode) => setExpanded(mode === "extend")))

  return (
    <box
      paddingLeft={1}
      onMouseUp={() => {
        if (!overflow()) return
        if (renderer.getSelection()?.getSelectedText()) return
        setExpanded((prev) => !prev)
      }}
    >
      <DiffView
        diff={visibleDiff()}
        filePath={props.filePath}
        view={props.view}
        wrapMode={expanded() || !overflow() ? undefined : "none"}
      />
      <Show when={overflow()}>
        <text paddingLeft={4} fg={theme.textMuted}>
          {expanded() ? "Click to collapse" : `${hidden()} more lines · Click to extend`}
        </text>
      </Show>
    </box>
  )

  function DiffView(input: { diff: string; filePath?: string; view: "split" | "unified"; wrapMode?: "word" | "none" }) {
    return (
      <>
        <diff
          diff={input.diff}
          view={input.view}
          filetype={filetype(input.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={input.wrapMode ?? ctx.diffWrapMode()}
          fg={theme.text}
          addedBg={theme.diffAddedBg}
          removedBg={theme.diffRemovedBg}
          contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded}
          removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber}
          lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg}
          removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
      </>
    )
  }
}

function toRenderableDiff(diff: string) {
  const normalized = diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (isRenderableDiff(normalized)) return normalized
  const preview = diffPreview(normalized, Number.MAX_SAFE_INTEGER)
  if (isRenderableDiff(preview)) return preview
  return diffHeaders(normalized).join("\n")
}

function isRenderableDiff(diff: string) {
  if (!diff.trim()) return false
  try {
    return parsePatch(diff).length > 0
  } catch {
    return false
  }
}

function diffPreview(diff: string, limit: number) {
  const lines = diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  const [oldHeader, newHeader] = diffHeaders(diff)
  const hunkIndex = lines.findIndex((line) => line.startsWith("@@ "))
  if (hunkIndex === -1) return [oldHeader, newHeader].join("\n")

  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[hunkIndex])
  if (!match) return [oldHeader, newHeader, ...lines.slice(hunkIndex, hunkIndex + limit + 1)].join("\n")

  const nextHunkIndex = lines.findIndex((line, index) => index > hunkIndex && line.startsWith("@@ "))
  const content = lines.slice(hunkIndex + 1, nextHunkIndex === -1 ? undefined : nextHunkIndex).filter(isDiffBodyLine)
  const firstChange = content.findIndex((line) => isDiffChangeLine(line))
  const start = Math.max(0, (firstChange === -1 ? 0 : firstChange) - 4)
  const selected = content.slice(start, start + limit)
  const oldStart = Number(match[1]) + countDiffLines(content.slice(0, start), "old")
  const newStart = Number(match[3]) + countDiffLines(content.slice(0, start), "new")
  const oldCount = countDiffLines(selected, "old")
  const newCount = countDiffLines(selected, "new")
  return [oldHeader, newHeader, `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${match[5] ?? ""}`, ...selected].join(
    "\n",
  )
}

function diffHeaders(diff: string) {
  const lines = diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  return [
    lines.find((line) => line.startsWith("--- ")) ?? "--- a/file",
    lines.find((line) => line.startsWith("+++ ")) ?? "+++ b/file",
  ]
}

function isDiffChangeLine(line: string) {
  return (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))
}

function isDiffBodyLine(line: string) {
  return line.startsWith(" ") || line.startsWith("\\") || isDiffChangeLine(line)
}

function countDiffLines(lines: string[], side: "old" | "new") {
  return lines.reduce((count, line) => {
    if (line.startsWith("\\")) return count
    if (line.startsWith("+") && !line.startsWith("+++")) return side === "new" ? count + 1 : count
    if (line.startsWith("-") && !line.startsWith("---")) return side === "old" ? count + 1 : count
    if (line.startsWith(" ")) return count + 1
    return count
  }, 0)
}

function pendingToolRaw(part: ToolPart) {
  if (part.state.status !== "pending") return ""
  return part.state.raw
}

function toolInputString(part: ToolPart, metadata: unknown, value: string | undefined, key: string) {
  if (value) return value
  const interruptedRaw = isRecord(metadata) && typeof metadata.interruptedRaw === "string" ? metadata.interruptedRaw : ""
  return jsonStringPrefix(pendingToolRaw(part) || interruptedRaw, key) ?? ""
}

function jsonStringPrefix(raw: string, key: string) {
  const keyIndex = raw.indexOf(`"${key}"`)
  if (keyIndex === -1) return undefined
  const colonIndex = raw.indexOf(":", keyIndex + key.length + 2)
  if (colonIndex === -1) return undefined
  const quoteIndex = raw.indexOf('"', colonIndex + 1)
  if (quoteIndex === -1) return undefined

  let result = ""
  for (let index = quoteIndex + 1; index < raw.length; index++) {
    const char = raw[index]
    if (!char) return result
    if (char === '"') return result
    if (char !== "\\") {
      result += char
      continue
    }

    index++
    const escaped = raw[index]
    if (!escaped) return result
    if (escaped === "n") result += "\n"
    else if (escaped === "r") result += "\r"
    else if (escaped === "t") result += "\t"
    else if (escaped === "b") result += "\b"
    else if (escaped === "f") result += "\f"
    else if (escaped === "u") {
      const hex = raw.slice(index + 1, index + 5)
      const code = /^[0-9a-fA-F]{4}$/.test(hex) ? Number.parseInt(hex, 16) : Number.NaN
      if (Number.isNaN(code)) continue
      result += String.fromCharCode(code)
      index += 4
    } else result += escaped
  }
  return result
}

function patchPreviewTitle(patchText: string) {
  const files = patchText
    .split("\n")
    .flatMap((line) => {
      const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim())
      return match?.[1] ? [normalizePath(match[1])] : []
    })
    .filter((value, index, items) => items.indexOf(value) === index)
  if (!files[0]) return "# Patch"
  if (files.length === 1) return `# Patch ${files[0]}`
  return `# Patch ${files[0]} +${files.length - 1}`
}

function Write(props: ToolProps<typeof WriteTool>) {
  const raw = createMemo(() => pendingToolRaw(props.part))
  const filePathValue = createMemo(() => props.input.filePath ?? jsonStringPrefix(raw(), "filePath") ?? "")
  const code = createMemo(() => {
    return props.input.content ?? jsonStringPrefix(raw(), "content") ?? raw()
  })
  const showStreamingPreview = createMemo(() => props.part.state.status === "pending" || props.part.state.status === "running")

  return (
    <Switch>
      <Match when={props.part.state.status === "completed" && code()}>
        <BlockTool title={"# Wrote " + normalizePath(filePathValue())} part={props.part}>
          <CollapsibleCodeBlock content={code()} filePath={filePathValue()} />
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePathValue()} />
        </BlockTool>
      </Match>
      <Match when={showStreamingPreview()}>
        <PendingToolPreview
          content={code()}
          filePath={filePathValue()}
          title={"# Write" + (filePathValue() ? " " + normalizePath(filePathValue()) : "")}
          part={props.part}
        />
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write..." complete={filePathValue()} part={props.part}>
          Write {normalizePath(filePathValue())}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  const active = createMemo(() => longRunningToolActive(props.part))
  const pattern = createMemo(() => toolInputString(props.part, props.metadata, props.input.pattern, "pattern"))
  const path = createMemo(() => toolInputString(props.part, props.metadata, props.input.path, "path"))
  return (
    <InlineTool
      icon="✱"
      pending="Finding files..."
      complete={props.part.state.status === "completed" && pattern()}
      spinner={active()}
      subtleSpinner={true}
      part={props.part}
    >
      <Show when={pattern()} fallback={<>Glob input unavailable</>}>
        {(value) => (
          <>
            Glob "{value()}" <Show when={path()}>in {normalizePath(path())} </Show>
          </>
        )}
      </Show>
      <Show when={props.metadata.count}>
        ({props.metadata.count} {props.metadata.count === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps<typeof ReadTool>) {
  const { theme } = useTheme()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file..."
        complete={props.input.filePath}
        spinner={isRunning()}
        part={props.part}
      >
        Read {normalizePath(props.input.filePath!)} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {normalizePath(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps<typeof GrepTool>) {
  const active = createMemo(() => longRunningToolActive(props.part))
  const pattern = createMemo(() => toolInputString(props.part, props.metadata, props.input.pattern, "pattern"))
  const path = createMemo(() => toolInputString(props.part, props.metadata, props.input.path, "path"))
  return (
    <InlineTool
      icon="✱"
      pending="Searching content..."
      complete={props.part.state.status === "completed" && pattern()}
      spinner={active()}
      subtleSpinner={true}
      part={props.part}
    >
      <Show when={pattern()} fallback={<>Grep input unavailable</>}>
        {(value) => (
          <>
            Grep "{value()}" <Show when={path()}>in {normalizePath(path())} </Show>
          </>
        )}
      </Show>
      <Show when={props.metadata.matches}>
        ({props.metadata.matches} {props.metadata.matches === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  const active = createMemo(() => longRunningToolActive(props.part))
  return (
    <InlineTool
      icon="%"
      pending="Fetching from the web..."
      complete={props.part.state.status === "completed" && props.input.url}
      spinner={active()}
      subtleSpinner={true}
      part={props.part}
    >
      WebFetch {props.input.url}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<typeof WebSearchTool>) {
  const metadata = props.metadata as { numResults?: number }
  const active = createMemo(() => longRunningToolActive(props.part))
  return (
    <InlineTool
      icon="◈"
      pending="Searching web..."
      complete={props.part.state.status === "completed" && props.input.query}
      spinner={active()}
      subtleSpinner={true}
      part={props.part}
    >
      Exa Web Search "{props.input.query}" <Show when={metadata.numResults}>({metadata.numResults} results)</Show>
    </InlineTool>
  )
}

function Task(props: ToolProps<typeof SubagentTool>) {
  const { navigate } = useRoute()
  const sync = useSync()

  onMount(() => {
    if (props.metadata.sessionId && !sync.data.message[props.metadata.sessionId]?.length)
      void sync.session.sync(props.metadata.sessionId)
  })

  const messages = createMemo(() => sync.data.message[props.metadata.sessionId ?? ""] ?? [])

  const tools = createMemo(() => {
    return messages().flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = createMemo(() =>
    tools().findLast((x) => (x.state.status === "running" || x.state.status === "completed") && x.state.title),
  )

  const active = createMemo(() => longRunningToolActive(props.part))

  const duration = createMemo(() => {
    const first = messages().find((x) => x.role === "user")?.time.created
    const assistant = messages().findLast((x) => x.role === "assistant")?.time.completed
    if (!first || !assistant) return 0
    return assistant - first
  })

  const content = createMemo(() => {
    const title = `${Locale.titlecase(props.input.agent_type ?? "General")} Task — ${
      props.input.description || "Preparing task..."
    }`
    const content = [title]

    if (active() && tools().length > 0) {
      // content[0] += ` · ${tools().length} toolcalls`
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? state.title : undefined
        content.push(`↳ ${Locale.titlecase(shortBtwActionLabel(current()!.tool))} ${title}`)
      } else content.push(`↳ ${tools().length} toolcalls`)
    }

    if (props.part.state.status === "completed") {
      content.push(`└ ${tools().length} toolcalls · ${Locale.duration(duration())}`)
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      icon="│"
      spinner={active()}
      subtleSpinner={true}
      complete={props.part.state.status === "completed"}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        if (props.metadata.sessionId) {
          navigate({ type: "session", sessionID: props.metadata.sessionId })
        }
      }}
    >
      {content()}
    </InlineTool>
  )
}

function Edit(props: ToolProps<typeof EditTool>) {
  const ctx = use()
  const raw = createMemo(() => pendingToolRaw(props.part))
  const filePathValue = createMemo(() => props.input.filePath ?? jsonStringPrefix(raw(), "filePath") ?? "")
  const newString = createMemo(() => props.input.newString ?? jsonStringPrefix(raw(), "newString") ?? "")
  const oldString = createMemo(() => props.input.oldString ?? jsonStringPrefix(raw(), "oldString") ?? "")
  const preview = createMemo(() => newString() || oldString() || raw())
  const showStreamingPreview = createMemo(() => props.part.state.status === "pending" || props.part.state.status === "running")

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const diffContent = createMemo(() => props.metadata.diff)

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool title={"← Edit " + normalizePath(filePathValue())} part={props.part}>
          <CollapsibleDiffBlock diff={diffContent() ?? ""} filePath={filePathValue()} view={view()} />
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePathValue()} />
        </BlockTool>
      </Match>
      <Match when={showStreamingPreview()}>
        <PendingToolPreview
          content={preview()}
          filePath={filePathValue()}
          title={"# Edit" + (filePathValue() ? " " + normalizePath(filePathValue()) : "")}
          part={props.part}
        />
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={filePathValue()} part={props.part}>
          Edit {normalizePath(filePathValue())} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps<typeof ApplyPatchTool>) {
  const ctx = use()
  const { theme } = useTheme()
  const raw = createMemo(() => pendingToolRaw(props.part))
  const patchText = createMemo(() => props.input.patchText ?? jsonStringPrefix(raw(), "patchText") ?? raw())
  const showStreamingPreview = createMemo(() => props.part.state.status === "pending" || props.part.state.status === "running")

  const files = createMemo(() => props.metadata.files ?? [])

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + normalizePath(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <CollapsibleDiffBlock diff={file.patch} filePath={file.filePath} view={view()} />
                <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={showStreamingPreview()}>
        <PendingToolPreview content={patchText()} title={patchPreviewTitle(patchText())} filetype="diff" part={props.part} />
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing patch..." complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps<typeof TodoWriteTool>) {
  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status} content={todo.content} />}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Updating todos..." complete={false} part={props.part}>
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<typeof QuestionTool>) {
  const { theme } = useTheme()
  const count = createMemo(() => props.input.questions?.length ?? 0)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps<typeof SkillTool>) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={props.input.name} part={props.part}>
      Skill "{props.input.name}"
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics?: Record<string, Record<string, any>[]>; filePath: string }) {
  const errors = createMemo(() => {
    const normalized = Filesystem.normalizePath(props.filePath)
    const arr = props.diagnostics?.[normalized] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
  })
  const message = createMemo(() =>
    errors()
      .map((diagnostic) => `Error [${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}] ${diagnostic.message}`)
      .join("\n"),
  )

  return (
    <Show when={errors().length}>
      <CompactErrorBlock title="LSP" error={message()} />
    </Show>
  )
}

function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  // outside cwd - use absolute
  return absolute
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
