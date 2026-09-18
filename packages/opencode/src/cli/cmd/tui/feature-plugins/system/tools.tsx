import { Keybind } from "@/util/keybind"
import { Wildcard } from "@/util/wildcard"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type {
  Agent,
  McpToolDefinition,
  PermissionRuleset,
  Session,
  ToolListItem,
} from "@opencode-ai/sdk/v2"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"

const id = "internal:tools-manager"
const cycleKey = Keybind.parse("space").at(0)
const scopeKey = Keybind.parse("tab").at(0)

type ToolAction = "allow" | "deny"
type ToolStatus = "enabled" | "disabled"
type ToolCategory = "Builtin" | "Custom" | "MCP"

interface BuiltinMeta {
  title: string
  ids: string[]
  keys: string[]
  blurb: string
}

const BUILTINS: BuiltinMeta[] = [
  { title: "read", ids: ["read"], keys: ["read"], blurb: "Read files" },
  {
    title: "edit",
    ids: ["edit", "write", "apply_patch"],
    keys: ["edit"],
    blurb: "File writes (write / edit / patch)",
  },
  { title: "glob", ids: ["glob"], keys: ["glob"], blurb: "Find files by pattern" },
  { title: "grep", ids: ["grep"], keys: ["grep"], blurb: "Search file contents" },
  {
    title: "shell",
    ids: ["shell", "shell_thread"],
    keys: ["shell", "shell_thread"],
    blurb: "Shell commands + background threads",
  },
  { title: "subagent", ids: ["subagent"], keys: ["subagent"], blurb: "Delegate work (task)" },
  {
    title: "subagent_models",
    ids: ["subagent_models"],
    keys: ["subagent_models"],
    blurb: "List runtimes for subagents",
  },
  { title: "todowrite", ids: ["todowrite"], keys: ["todowrite"], blurb: "Manage the todo list" },
  { title: "question", ids: ["question"], keys: ["question"], blurb: "Ask the user questions" },
  { title: "skill", ids: ["skill"], keys: ["skill"], blurb: "Skill catalog (drives system prompt size)" },
  { title: "webfetch", ids: ["webfetch"], keys: ["webfetch"], blurb: "Fetch URLs" },
  { title: "websearch", ids: ["websearch"], keys: ["websearch"], blurb: "Search the web" },
  { title: "lsp", ids: ["lsp"], keys: ["lsp"], blurb: "Language server protocol" },
  { title: "plan_exit", ids: ["plan_exit"], keys: ["plan_exit"], blurb: "Exit plan mode" },
]

const BUILTIN_IDS = new Set(BUILTINS.flatMap((item) => item.ids).concat(["invalid", "plan_enter"]))

interface ListedTool {
  title: string
  value: string
  category: ToolCategory
  keys: string[]
  description?: string
}

function normalize(permission: string) {
  return permission === "bash" ? "shell" : permission
}

function evaluateAction(permission: string, rulesets: PermissionRuleset[]): ToolAction | undefined {
  const target = normalize(permission)
  const match = rulesets
    .flat()
    .findLast(
      (rule) => rule.pattern === "*" && Wildcard.match(target, normalize(rule.permission)),
    )
  if (match?.action === "deny") return "deny"
  if (match?.action === "allow" || match?.action === "ask") return "allow"
  return
}

function combineActions(actions: (ToolAction | undefined)[]): ToolAction {
  if (actions.some((action) => action === "deny")) return "deny"
  return "allow"
}

function nextAction(action: ToolAction): ToolAction {
  return action === "allow" ? "deny" : "allow"
}

function oneLine(text: string, width: number) {
  const line = text.split("\n")[0].trim()
  const limit = width >= 120 ? 120 : 64
  if (line.length <= limit) return line
  return `${line.slice(0, limit - 1)}…`
}

function statusOf(action: ToolAction): ToolStatus {
  return action === "deny" ? "disabled" : "enabled"
}

function pill(api: TuiPluginApi, action: ToolAction) {
  const color = action === "deny" ? api.theme.current.error : api.theme.current.success
  return <span style={{ fg: color }}>{statusOf(action)}</span>
}

function currentSession(api: TuiPluginApi, sessions: readonly Session[]) {
  const current = api.route.current
  if (current.name !== "session") return
  const sessionID = (current.params as { sessionID?: unknown } | undefined)?.sessionID
  if (typeof sessionID !== "string") return
  return sessions.find((item) => item.id === sessionID)
}

function currentAgent(session: Session | undefined, agents: Agent[]) {
  const agent = agents.find((item) => item.name === session?.agent) ?? agents.find((item) => item.name === "build")
  return agent ?? agents[0]
}

function resolveModel(
  session: Session | undefined,
  config: TuiPluginApi["state"]["config"],
  providerDefault: Record<string, string>,
  providers: TuiPluginApi["state"]["provider"],
) {
  if (session?.model) return { provider: session.model.providerID, model: session.model.id }
  const configured = config.model
  if (typeof configured === "string") {
    const slash = configured.indexOf("/")
    if (slash > 0) return { provider: configured.slice(0, slash), model: configured.slice(slash + 1) }
  }
  for (const [provider, model] of Object.entries(providerDefault)) {
    return { provider, model }
  }
  const first = providers[0]
  if (first) {
    const model = providerDefault[first.id] ?? Object.keys(first.models)[0]
    if (model) return { provider: first.id, model }
  }
  return
}

function waitForDisposal(api: TuiPluginApi, timeoutMs = 5000) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve()
    }, timeoutMs)
    const off = api.event.on("server.instance.disposed", () => {
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}

function configSource(api: TuiPluginApi, keys: string[], action: ToolAction) {
  const permission = api.state.config.permission
  if (!permission) return
  for (const key of keys) {
    const value = (permission as Record<string, unknown>)[normalize(key)]
    if (typeof value === "string" && (value === action || (action === "allow" && value === "ask")))
      return "config"
    if (value && typeof value === "object" && (value as Record<string, unknown>)["*"] === action) return "config"
  }
  return
}

function View(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()
  const sync = useSync()
  const [cur, setCur] = createSignal<string | undefined>()
  const [lock, setLock] = createSignal(false)
  const [global, setGlobal] = createSignal(false)
  const [items, setItems] = createSignal<ToolListItem[] | undefined>()
  const [mcpTools, setMcpTools] = createSignal<McpToolDefinition[] | undefined>()

  createEffect(() => {
    const width = size().width
    if (width >= 128) {
      props.api.ui.dialog.setSize("xlarge")
      return
    }
    if (width >= 96) {
      props.api.ui.dialog.setSize("large")
      return
    }
    props.api.ui.dialog.setSize("medium")
  })

  useKeyboard((evt) => {
    if (evt.name !== "tab") return
    evt.preventDefault()
    evt.stopPropagation()
    if (lock()) return
    setGlobal((x) => !x)
  })

  onMount(() => {
    const session = currentSession(props.api, props.api.state.session.all())
    const model = resolveModel(session, sync.data.config, sync.data.provider_default, sync.data.provider)
    if (model) {
      void props.api.client.tool
        .list({ provider: model.provider, model: model.model })
        .then((result) => {
          if (result.data) setItems(result.data)
        })
        .catch(() => {})
    }
    void props.api.client.mcp
      .tools()
      .then((result) => {
        if (result.data) setMcpTools(result.data)
      })
      .catch(() => {
        setMcpTools([])
      })
  })

  const rows = createMemo(() => {
    const width = size().width
    const listed = items()
    const ids = listed ? new Set(listed.map((item) => item.id)) : undefined
    const byID = new Map((listed ?? []).map((item) => [item.id, item]))
    const out: ListedTool[] = []

    for (const meta of BUILTINS) {
      const present = meta.ids.filter((toolID) => !ids || ids.has(toolID))
      if (present.length === 0) continue
      const description = byID.get(present[0])?.description || meta.blurb
      out.push({
        title: meta.title,
        value: `builtin:${meta.title}`,
        category: "Builtin",
        keys: meta.keys,
        description: oneLine(description, width),
      })
    }

    if (listed) {
      for (const item of listed) {
        if (BUILTIN_IDS.has(item.id)) continue
        out.push({
          title: item.id,
          value: `custom:${item.id}`,
          category: "Custom",
          keys: [item.id],
          description: item.description ? oneLine(item.description, width) : undefined,
        })
      }
    }

    for (const tool of mcpTools() ?? []) {
      out.push({
        title: tool.id,
        value: `mcp:${tool.id}`,
        category: "MCP",
        keys: [tool.id],
        description: tool.description ? oneLine(tool.description, width) : tool.client,
      })
    }

    const seen = new Set<string>()
    return out.filter((tool) => {
      if (seen.has(tool.value)) return false
      seen.add(tool.value)
      return true
    })
  })

  const actionOf = (tool: ListedTool) => {
    const session = currentSession(props.api, props.api.state.session.all())
    const agent = currentAgent(session, sync.data.agent)
    const rulesets = [agent?.permission ?? [], session?.permission ?? []]
    return combineActions(tool.keys.map((key) => evaluateAction(key, rulesets)))
  }

  const sourceOf = (tool: ListedTool, action: ToolAction) => {
    const session = currentSession(props.api, props.api.state.session.all())
    const sessionRules = session?.permission ?? []
    if (tool.keys.some((key) => evaluateAction(key, [sessionRules]) !== undefined)) return "session"
    return configSource(props.api, tool.keys, action) ?? "default"
  }

  const flip = async (value: string) => {
    if (lock()) return
    const tool = rows().find((item) => item.value === value)
    if (!tool) return
    const action = nextAction(actionOf(tool))
    setLock(true)
    try {
      // Config-first write: the server disposes the instance on persist, so the
      // next prompt in every session boots with fresh agent permissions.
      // Session rules are only appended to heal a detected conflict, never
      // speculatively: they merge last and would shadow later config flips.
      const disposed = waitForDisposal(props.api)
      const persisted = await props.api.client.config.permission.update({
        scope: global() ? "global" : "local",
        permission: Object.fromEntries(tool.keys.map((key) => [key, action])),
      })
      if (persisted.error) throw persisted.error
      await disposed
      setCur(tool.value)
      await sync.bootstrap({ fatal: false })
      const session = currentSession(props.api, props.api.state.session.all())
      const shadowed =
        session !== undefined &&
        tool.keys.some((key) => {
          const resolved = evaluateAction(key, [session.permission ?? []])
          return resolved !== undefined && resolved !== action
        })
      if (shadowed && session) {
        const healed = await props.api.client.session.update({
          sessionID: session.id,
          permission: tool.keys.map((key) => ({ permission: key, pattern: "*", action })),
        })
        if (healed.error) throw healed.error
        await sync.bootstrap({ fatal: false })
      }
      const actual = actionOf(tool)
      const status = statusOf(action)
      if (actual === action) {
        props.api.ui.toast({
          variant: "success",
          message:
            status === "disabled"
              ? `${tool.title} disabled (${global() ? "global" : "local"})${shadowed ? ", session override healed" : ""}, removed from context in new prompts`
              : `${tool.title} enabled (${global() ? "global" : "local"})${shadowed ? ", session override healed" : ""}, live in new prompts`,
        })
      } else {
        props.api.ui.toast({
          variant: "warning",
          message: `${tool.title} saved as ${status} (${global() ? "global" : "local"}), but this session still resolves ${statusOf(actual)} (session override)`,
        })
      }
    } catch (error) {
      props.api.ui.toast({
        variant: "error",
        message: error instanceof Error ? error.message : `Failed to update tool ${tool.title}`,
      })
    } finally {
      setLock(false)
    }
  }

  const options = createMemo<DialogSelectOption<string>[]>(() =>
    rows().map((tool) => {
      const action = actionOf(tool)
      return {
        title: tool.title,
        value: tool.value,
        category: tool.category,
        description: tool.description,
        footer: (
          <>
            {pill(props.api, action)}
            <span style={{ fg: props.api.theme.current.textMuted }}> · {sourceOf(tool, action)}</span>
          </>
        ),
      }
    }),
  )

  return (
    <DialogSelect
      title="Tools"
      options={options()}
      footerLeft={
        <>
          <span style={{ fg: props.api.theme.current.text }}>{"↑↓"}</span> navigate
    <span style={{ fg: props.api.theme.current.textMuted }}>
      {" "}
      · scope: {global() ? "global" : "local"} ({Keybind.toString(scopeKey)} toggle) · disabled = removed from
      LLM context
    </span>
        </>
      }
      current={cur()}
      keybind={[
        {
          title: "cycle",
          keybind: cycleKey,
          disabled: lock(),
          onTrigger: (item) => {
            void flip(item.value)
          },
        },
      ]}
      onSelect={(item) => {
        void flip(item.value)
      }}
    />
  )
}

function show(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <View api={api} />)
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: "Tools Manager",
      value: "tools.list",
      keybind: "tools_manager",
      category: "System",
      slash: {
        name: "tools",
        aliases: ["tool"],
      },
      onSelect() {
        show(api)
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
