import type { Agent } from "@opencode-ai/sdk/v2"
import { TextAttributes, TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import matter from "gray-matter"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { useLocal } from "@tui/context/local"
import { useProject } from "@tui/context/project"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import PROMPT_PLAN from "@/session/prompt/plan.txt"
import { SystemPrompt } from "@/session/system"
import { Filesystem } from "@/util/filesystem"
import { Keybind } from "@/util/keybind"
import { errorMessage } from "@/util/error"
import { useTextareaKeybindings } from "./textarea-keybindings"

const createKey = Keybind.parse("ctrl+a").at(0)
const editKey = Keybind.parse("ctrl+e").at(0)
const favoriteKey = Keybind.parse("ctrl+f").at(0)
const deleteKey = Keybind.parse("ctrl+d").at(0)
const saveKey = Keybind.parse("ctrl+s,super+s").at(0)
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/
const GENERATED_AGENT_COLORS = ["success", "warning", "primary", "error", "info"] as const

type AgentStorageScope = "local" | "global"
type AgentSource = "native" | AgentStorageScope

function buildAgentFrontmatter(input: { item?: Agent; color?: string }) {
  return {
    ...(input.item?.description ? { description: input.item.description } : {}),
    ...(input.item?.model ? { model: `${input.item.model.providerID}/${input.item.model.modelID}` } : {}),
    ...(input.item?.variant ? { variant: input.item.variant } : {}),
    ...(input.item?.temperature !== undefined ? { temperature: input.item.temperature } : {}),
    ...(input.item?.topP !== undefined ? { top_p: input.item.topP } : {}),
    ...(input.item?.color ? { color: input.item.color } : input.color ? { color: input.color } : {}),
    ...(input.item?.steps !== undefined ? { steps: input.item.steps } : {}),
    mode: "primary" as const,
  }
}

function projectRoot(project: ReturnType<typeof useProject>) {
  const paths = project.instance.path()
  if (paths.directory) return paths.directory
  if (paths.worktree && paths.worktree !== "/") return paths.worktree
  return process.cwd()
}

function globalAgentDir() {
  return path.join(Global.Path.config, "agents")
}

function localAgentDir(project: ReturnType<typeof useProject>) {
  return path.join(projectRoot(project), ".opencode", "agents")
}

function agentPath(input: { project: ReturnType<typeof useProject>; name: string; scope: AgentStorageScope }) {
  const dir = input.scope === "local" ? localAgentDir(input.project) : globalAgentDir()
  return path.join(dir, `${input.name}.md`)
}

function legacyConfigPath(project: ReturnType<typeof useProject>) {
  return path.join(projectRoot(project), "config.json")
}

function globalLegacyAgentDirs() {
  return [path.join(Global.Path.config, "agent")]
}

function localLegacyAgentDirs(project: ReturnType<typeof useProject>) {
  const root = projectRoot(project)
  return [path.join(root, ".opencode", "agent"), path.join(root, ".opencode", "agents")]
}

function scopedAgentPaths(input: { project: ReturnType<typeof useProject>; name: string; scope: AgentStorageScope }) {
  const paths = [agentPath(input)]
  if (input.scope === "local") {
    return [...paths, ...localLegacyAgentDirs(input.project).map((dir) => path.join(dir, `${input.name}.md`))]
  }
  return [...paths, ...globalLegacyAgentDirs().map((dir) => path.join(dir, `${input.name}.md`))]
}

function sameAgentName(left: string, right: string) {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()
}

function isValidAgentName(name: string) {
  if (!AGENT_NAME.test(name)) return false
  if (name === "." || name === "..") return false
  if (name.endsWith(".") || name.endsWith(" ")) return false
  return true
}

function serializeAgentFile(input: {
  item?: Agent
  prompt: string
  config?: Record<string, unknown>
  color?: string
}) {
  const prompt = input.prompt.trimEnd()
  const frontmatter = input.config
    ? {
        ...(typeof input.config.description === "string" ? { description: input.config.description } : {}),
        ...(typeof input.config.model === "string" ? { model: input.config.model } : {}),
        ...(typeof input.config.variant === "string" ? { variant: input.config.variant } : {}),
        ...(typeof input.config.temperature === "number" ? { temperature: input.config.temperature } : {}),
        ...(typeof input.config.top_p === "number" ? { top_p: input.config.top_p } : {}),
        ...(typeof input.config.color === "string"
          ? { color: input.config.color }
          : input.color
            ? { color: input.color }
            : {}),
        ...(typeof input.config.steps === "number" ? { steps: input.config.steps } : {}),
        ...(typeof input.config.hidden === "boolean" ? { hidden: input.config.hidden } : {}),
        ...(input.config.options && typeof input.config.options === "object" ? { options: input.config.options } : {}),
        ...(input.config.permission && typeof input.config.permission === "object"
          ? { permission: input.config.permission }
          : {}),
        mode: input.config.mode === "subagent" ? "subagent" : "primary",
      }
    : buildAgentFrontmatter({ item: input.item, color: input.color })
  return matter.stringify(prompt ? `${prompt}\n` : "", frontmatter)
}

function nextAgentColor(input: {
  sync: ReturnType<typeof useSync>
  used?: Set<string>
  exclude?: string
}) {
  const used = input.used ?? new Set<string>()
  for (const item of input.sync.data.agent) {
    if (item.mode === "subagent") continue
    if (item.name === input.exclude) continue
    if (!item.color) continue
    used.add(item.color)
  }
  const available = GENERATED_AGENT_COLORS.find((color) => !used.has(color))
  if (available) {
    used.add(available)
    return available
  }
  const fallback = GENERATED_AGENT_COLORS[used.size % GENERATED_AGENT_COLORS.length] ?? GENERATED_AGENT_COLORS[0]
  used.add(fallback)
  return fallback
}

async function reloadAgents(input: { sdk: ReturnType<typeof useSDK>; sync: ReturnType<typeof useSync> }) {
  await input.sdk.client.instance.dispose()
  await input.sync.bootstrap({ fatal: false })
}

async function removeLegacyConfigAgents(input: {
  project: ReturnType<typeof useProject>
  names: string[]
}) {
  const file = legacyConfigPath(input.project)
  const config = await Filesystem.readJson<{ [key: string]: unknown; agent?: Record<string, Record<string, unknown>> }>(
    file,
  ).catch(() => undefined)
  if (!config?.agent) return false

  const next = { ...config.agent }
  let changed = false
  for (const item of Object.keys(next)) {
    if (!input.names.some((name) => sameAgentName(name, item))) continue
    delete next[item]
    changed = true
  }
  if (!changed) return false

  const payload = {
    ...config,
    ...(Object.keys(next).length > 0 ? { agent: next } : { agent: undefined }),
  }
  await Filesystem.writeJson(file, payload)
  return true
}

async function existingAgentScope(input: {
  project: ReturnType<typeof useProject>
  name: string
}): Promise<AgentStorageScope | undefined> {
  if (
    await Filesystem.exists(
      agentPath({
        project: input.project,
        name: input.name,
        scope: "local",
      }),
    )
  ) {
    return "local"
  }
  if (
    await Filesystem.exists(
      agentPath({
        project: input.project,
        name: input.name,
        scope: "global",
      }),
    )
  ) {
    return "global"
  }
  return undefined
}

async function agentSource(input: {
  project: ReturnType<typeof useProject>
  item: Agent
}): Promise<AgentSource> {
  const scope = await existingAgentScope({
    project: input.project,
    name: input.item.name,
  })
  if (scope) return scope
  return input.item.native ? "native" : "global"
}

async function migrateLegacyAgents(input: {
  project: ReturnType<typeof useProject>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
}) {
  const file = legacyConfigPath(input.project)
  const config = await Filesystem.readJson<{ agent?: Record<string, Record<string, unknown>> }>(file).catch(() => undefined)
  const usedColors = new Set<string>()
  const migratedNames = new Set<string>()
  let changed = false

  for (const [name, value] of Object.entries(config?.agent ?? {})) {
    if (!isValidAgentName(name) || value.disable === true || typeof value.prompt !== "string") continue
    await Filesystem.write(
      agentPath({
        project: input.project,
        name,
        scope: "local",
      }),
      serializeAgentFile({
        prompt: value.prompt,
        config: value,
        color: typeof value.color === "string" ? value.color : nextAgentColor({ sync: input.sync, used: usedColors }),
      }),
    )
    migratedNames.add(name)
    changed = true
  }

  for (const scope of ["local", "global"] as const) {
    const directories = scope === "local" ? localLegacyAgentDirs(input.project) : globalLegacyAgentDirs()
    for (const dir of directories) {
      if (!(await Filesystem.isDir(dir))) continue
      for await (const file of new Bun.Glob("*.md").scan({ cwd: dir, absolute: true })) {
        const name = path.basename(file, ".md")
        if (!isValidAgentName(name)) continue
        await Filesystem.write(
          agentPath({
            project: input.project,
            name,
            scope,
          }),
          await Filesystem.readText(file),
        )
        if (path.dirname(file) !== path.dirname(agentPath({ project: input.project, name, scope }))) {
          await Bun.file(file).delete()
        }
        migratedNames.add(name)
        changed = true
      }
    }
  }

  if (migratedNames.size > 0) {
    changed = (await removeLegacyConfigAgents({ project: input.project, names: [...migratedNames] })) || changed
  }
  if (!changed) return
  await reloadAgents({ sdk: input.sdk, sync: input.sync })
}

function agentPrompt(input: {
  item?: Agent
  local: ReturnType<typeof useLocal>
  sync: ReturnType<typeof useSync>
}) {
  if (!input.item) return ""
  if (input.item.prompt) return input.item.prompt
  if (input.item.name === "plan") return PROMPT_PLAN
  if (input.item.name !== "build") return ""

  const current = input.local.model.current()
  const configured = input.item.model
  const fallback = input.sync.data.config.model
  const selected =
    configured ??
    current ??
    (fallback
      ? {
          providerID: fallback.split("/")[0] ?? "",
          modelID: fallback.split("/").slice(1).join("/"),
        }
      : undefined)

  const provider = selected
    ? input.sync.data.provider.find((item) => item.id === selected.providerID)
    : input.sync.data.provider[0]
  if (!provider) return ""
  const modelID = selected?.modelID || input.sync.data.provider_default[provider.id] || Object.values(provider.models)[0]?.id
  if (!modelID) return ""
  const model = provider.models[modelID]
  if (!model) return ""
  return SystemPrompt.provider(model as Parameters<typeof SystemPrompt.provider>[0]).join("\n")
}

function DialogAgentScope(props: {
  item?: Agent
  selected?: string
  draft: { name: string; prompt: string; color?: string }
  onSelect: (scope: AgentStorageScope) => void
}) {
  const dialog = useDialog()
  const project = useProject()
  const { theme } = useTheme()

  function back() {
    dialog.replace(() => <DialogAgentEditor item={props.item} selected={props.selected} draft={props.draft} />)
  }

  onMount(() => {
    dialog.setSize("medium")
    dialog.setWidth(72)
    dialog.setBeforeClose(() => {
      back()
      return false
    })
  })

  return (
    <DialogSelect
      title="Save Agent"
      placeholder="Choose save location"
      current="local"
      flat
      renderFilter={false}
      skipFilter
      options={[
        {
          value: "local",
          title: "Workspace",
          description: localAgentDir(project),
          footer: "local",
        },
        {
          value: "global",
          title: "Global",
          description: globalAgentDir(),
          footer: "global",
        },
      ]}
      footerLeft={
        <>
          <span style={{ fg: theme.text }}>{"↑↓"}</span> choose
        </>
      }
      onSelect={(option) => {
        props.onSelect(option.value as AgentStorageScope)
      }}
    />
  )
}

function DialogAgentEditor(props: {
  item?: Agent
  selected?: string
  draft?: { name: string; prompt: string; color?: string }
  scope?: AgentStorageScope
}) {
  const dialog = useDialog()
  const local = useLocal()
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const toast = useToast()
  const textareaKeybindings = useTextareaKeybindings()
  const [active, setActive] = createSignal<"name" | "prompt">("name")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()

  let nameInput: TextareaRenderable | undefined
  let promptInput: TextareaRenderable | undefined

  const title = createMemo(() => (props.item ? "Edit agent" : "New agent"))
  const saveText = createMemo(() => Keybind.toString(saveKey))
  const nameBindings = createMemo(() => textareaKeybindings().filter((item) => item.action !== "submit"))
  const promptBindings = createMemo(() => {
    const bindings = textareaKeybindings().filter((item) => !(item.name === "return" && item.action === "submit"))
    return [{ name: "return", action: "newline" } as const, ...bindings]
  })

  function back(selected = props.selected ?? props.item?.name) {
    dialog.replace(() => <DialogAgent selected={selected} />)
  }

  function validatedDraft() {
    const name = nameInput?.plainText.trim() ?? ""
    const prompt = promptInput?.plainText ?? ""
    const color = props.item?.color ?? props.draft?.color ?? nextAgentColor({ sync, exclude: props.item?.name })

    if (!name) {
      setError("Agent name is required")
      setActive("name")
      nameInput?.focus()
      return
    }
    if (!isValidAgentName(name)) {
      setError("Use letters, numbers, spaces, dots, dashes, or underscores")
      setActive("name")
      nameInput?.focus()
      return
    }
    if (
      sync.data.agent.some(
        (item) =>
          item.mode !== "subagent" &&
          sameAgentName(item.name, name) &&
          !sameAgentName(item.name, props.item?.name ?? ""),
      )
    ) {
      setError(`Agent already exists: ${name}`)
      setActive("name")
      nameInput?.focus()
      return
    }
    if (!prompt.trim()) {
      setError("Prompt is required")
      setActive("prompt")
      promptInput?.focus()
      return
    }
    return { name, prompt, color }
  }

  async function saveDraft(draft: { name: string; prompt: string; color?: string }, targetScope: AgentStorageScope) {
    const target = agentPath({
      project,
      name: draft.name,
      scope: targetScope,
    })
    const currentScope = props.item
      ? await existingAgentScope({
          project,
          name: props.item.name,
        })
      : undefined
    const currentPath =
      props.item && currentScope
        ? agentPath({
            project,
            name: props.item.name,
            scope: currentScope,
          })
        : undefined

    if (
      currentPath &&
      currentPath !== target &&
      currentPath.toLocaleLowerCase() === target.toLocaleLowerCase() &&
      (await Filesystem.exists(currentPath))
    ) {
      await Bun.file(currentPath).delete()
    }

    if (!sameAgentName(props.item?.name ?? "", draft.name) && (await Filesystem.exists(target))) {
      setError(`Agent file already exists: ${draft.name}.md`)
      setActive("name")
      nameInput?.focus()
      return
    }

    setSaving(true)
    setError(undefined)
    try {
      await Filesystem.write(
        target,
        serializeAgentFile({
          item: props.item,
          prompt: draft.prompt,
          color: draft.color,
        }),
      )
      if (currentPath && currentPath !== target && (await Filesystem.exists(currentPath))) {
        await Bun.file(currentPath).delete()
      }
      if (props.item?.name && !sameAgentName(props.item.name, draft.name)) {
        for (const legacyScope of ["local", "global"] as const) {
          for (const item of scopedAgentPaths({
            project,
            name: props.item.name,
            scope: legacyScope,
          })) {
            if (!(await Filesystem.exists(item))) continue
            if (item === target) continue
            await Bun.file(item).delete()
          }
        }
        await removeLegacyConfigAgents({ project, names: [props.item.name] })
      }
      if (props.item?.name && props.item.name !== draft.name) local.agent.renameFavorite(props.item.name, draft.name)
      await reloadAgents({ sdk, sync })
      back(draft.name)
    } catch (err) {
      const message = errorMessage(err)
      setError(message)
      toast.show({
        variant: "error",
        title: "Failed to save agent",
        message,
      })
    } finally {
      setSaving(false)
    }
  }

  async function submit() {
    if (saving()) return
    const draft = validatedDraft()
    if (!draft) return

    const targetScope =
      props.scope ??
      (props.item
        ? ((await existingAgentScope({
            project,
            name: props.item.name,
          })) ?? "global")
        : undefined)

    if (!targetScope) {
      dialog.replace(() => (
        <DialogAgentScope
          item={props.item}
          selected={props.selected}
          draft={draft}
          onSelect={(selectedScope) => {
            void saveDraft(draft, selectedScope)
          }}
        />
      ))
      return
    }

    await saveDraft(draft, targetScope)
  }

  useKeyboard((evt) => {
    if (saving()) {
      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    if (evt.name === "tab") {
      evt.preventDefault()
      const next = active() === "name" ? "prompt" : "name"
      setActive(next)
      queueMicrotask(() => {
        if (next === "name") nameInput?.focus()
        if (next === "prompt") promptInput?.focus()
      })
      return
    }

    if (active() === "name" && evt.name === "return") {
      evt.preventDefault()
      setActive("prompt")
      queueMicrotask(() => promptInput?.focus())
      return
    }

    if ((evt.ctrl || evt.super) && evt.name === "s") {
      evt.preventDefault()
      evt.stopPropagation()
      void submit()
    }
  })

  onMount(() => {
    dialog.setSize("xlarge")
    dialog.setWidth(88)
    dialog.setBeforeClose(() => {
      back()
      return false
    })
    queueMicrotask(() => {
      nameInput?.focus()
      nameInput?.gotoLineEnd()
    })
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {title()}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => back()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <text fg={theme.textMuted}>Name</text>
        <box
          backgroundColor={active() === "name" ? theme.backgroundElement : undefined}
          paddingLeft={1}
          onMouseUp={() => {
            setActive("name")
            nameInput?.focus()
          }}
        >
          <textarea
            ref={(value: TextareaRenderable) => {
              nameInput = value
              value.traits = { status: "AGENT_NAME" }
            }}
            initialValue={props.draft?.name ?? props.item?.name ?? ""}
            minHeight={1}
            maxHeight={1}
            placeholder="Review Agent"
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.primary}
            keyBindings={nameBindings()}
          />
        </box>
        <text fg={theme.textMuted}>Prompt</text>
        <box
          backgroundColor={active() === "prompt" ? theme.backgroundElement : undefined}
          paddingLeft={1}
          onMouseUp={() => {
            setActive("prompt")
            promptInput?.focus()
          }}
        >
          <textarea
            ref={(value: TextareaRenderable) => {
              promptInput = value
              value.traits = { status: "AGENT_PROMPT" }
            }}
            initialValue={props.draft?.prompt ?? agentPrompt({ item: props.item, local, sync })}
            minHeight={10}
            maxHeight={16}
            placeholder="Describe how this agent should behave"
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.primary}
            keyBindings={promptBindings()}
          />
        </box>
        <Show when={error()}>
          <text fg={theme.error} wrapMode="word">
            {error()}
          </text>
        </Show>
      </box>
      <box paddingBottom={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.text }}>tab</span> switch field
        </text>
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.text }}>{saveText()}</span> save
        </text>
      </box>
    </box>
  )
}

export function DialogAgent(props: { selected?: string }) {
  const dialog = useDialog()
  const local = useLocal()
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const toast = useToast()
  const [toDelete, setToDelete] = createSignal<string>()
  const [anchor, setAnchor] = createSignal(props.selected ?? local.agent.current()?.name)
  const [selected, setSelected] = createSignal(props.selected ?? local.agent.current()?.name)
  const [sources, setSources] = createSignal<Record<string, AgentSource>>({})
  const [touched, setTouched] = createSignal(false)

  const options = createMemo(() => {
    const items = local.agent.list()
    const favorites = local
      .agent
      .favoriteNames()
      .map((name) => items.find((item) => item.name === name))
      .filter((item) => item !== undefined)
    const others = items.filter((item) => !local.agent.isFavorite(item.name))
    const option = (item: (typeof items)[number], category: "Favorites" | "Agents") => {
      const isDeleting = toDelete() === item.name
      return {
        value: item.name,
        title: isDeleting ? `Press ${Keybind.toString(deleteKey)} again to confirm` : item.name,
        description: undefined,
        footer: item.native ? "builtin" : sources()[item.name] ?? "global",
        category,
        bg: isDeleting ? theme.error : undefined,
      }
    }
    return [
      ...favorites.map((item) => option(item, "Favorites")),
      ...others.map((item) => option(item, "Agents")),
    ]
  })

  async function refresh(selection?: string) {
    await sync.bootstrap({ fatal: false })
    const current = selection ?? local.agent.current()?.name
    setSources(
      Object.fromEntries(
        await Promise.all(
          local.agent.list().map(async (item) => [
            item.name,
            await agentSource({
              project,
              item,
            }),
          ]),
        ),
      ),
    )
    if (!touched()) {
      setAnchor(current)
      setSelected(current)
    }
  }

  onMount(() => {
    void (async () => {
      await migrateLegacyAgents({ project, sdk, sync })
      await refresh(selected())
      const current = props.selected ?? local.agent.current()?.name
      if (!touched()) {
        setAnchor(current)
        setSelected(current)
      }
    })()
  })

  async function remove(name: string) {
    const agent = local.agent.list().find((item) => item.name === name)
    if (!agent) return
    const visible = options()
    const index = visible.findIndex((item) => item.value === name)
    const fallback =
      visible[index + 1]?.value ??
      visible[index - 1]?.value ??
      local.agent.current()?.name
    if (local.agent.list().length <= 1) {
      toast.show({
        variant: "warning",
        message: "At least one primary agent must remain enabled",
      })
      return
    }
    try {
      let changed = false
      for (const scope of ["local", "global"] as const) {
        for (const item of scopedAgentPaths({ project, name, scope })) {
          if (!(await Filesystem.exists(item))) continue
          await Bun.file(item).delete()
          changed = true
        }
      }
      changed = (await removeLegacyConfigAgents({ project, names: [name] })) || changed
      if (changed) {
        if (!agent.native) local.agent.removeFavorite(name)
        await reloadAgents({ sdk, sync })
        await refresh(fallback)
        setAnchor(fallback)
        setSelected(fallback)
        setToDelete(undefined)
        return
      }
      if (agent.native) {
        toast.show({
          variant: "info",
          message: "Built-in agents cannot be deleted",
        })
        setToDelete(undefined)
        return
      }
      toast.show({
        variant: "warning",
        message: "Only file-based agents can be deleted from the manager",
      })
      setToDelete(undefined)
    } catch (err) {
      toast.show({
        variant: "error",
        title: "Failed to delete agent",
        message: errorMessage(err),
      })
    }
  }

  return (
    <DialogSelect
      title="Agents Manager"
      placeholder="Search agents"
      options={options()}
      flat
      current={anchor()}
      footerLeft={
        <>
          <span style={{ fg: theme.text }}>{"↑↓"}</span> navigate
        </>
      }
      onMove={(option) => {
        setTouched(true)
        setSelected(option.value)
        setToDelete(undefined)
      }}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
      keybind={[
        {
          title: "new",
          keybind: createKey,
          onTrigger: () => {
            dialog.replace(() => <DialogAgentEditor selected={selected()} />)
          },
        },
        {
          title: "edit",
          keybind: editKey,
          onTrigger: (option) => {
            const item = local.agent.list().find((entry) => entry.name === option.value)
            if (!item) return
            dialog.replace(() => <DialogAgentEditor item={item} selected={option.value} />)
          },
        },
        {
          title: "favorite",
          keybind: favoriteKey,
          onTrigger: (option) => {
            local.agent.toggleFavorite(option.value)
            setSelected(option.value)
          },
        },
        {
          title: "delete",
          keybind: deleteKey,
          onTrigger: (option) => {
            if (toDelete() === option.value) {
              void remove(option.value)
              return
            }
            setToDelete(option.value)
            setSelected(option.value)
          },
        },
      ]}
    />
  )
}
