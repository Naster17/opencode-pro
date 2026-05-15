import { Keybind } from "@/util/keybind"
import { ConfigPlugin } from "@/config/plugin"
import { parsePluginSpecifier } from "@/plugin/shared"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiPluginStatus } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useSync } from "@tui/context/sync"
import { fileURLToPath } from "url"
import path from "path"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { Show, createEffect, createMemo, createSignal, type JSX } from "solid-js"

const id = "internal:plugin-manager"
const key = Keybind.parse("space").at(0)
const add = Keybind.parse("shift+i").at(0)
const tab = Keybind.parse("tab").at(0)

interface BackendPluginInfo {
  id: string
  name: string
  description: string
  provider: string
}

type PluginSpec = NonNullable<TuiPluginApi["state"]["config"]["plugin"]>[number]

type ListedPlugin = {
  title: string
  value: string
  category: string
  spec?: string
  enabled?: boolean
  description?: string
  footer: JSX.Element | string
}

const PLUGIN_ENABLED_KEY = "plugin_enabled"

const BACKEND_PLUGINS: BackendPluginInfo[] = [
  {
    id: "codex",
    name: "OpenAI Codex",
    description: "ChatGPT Pro/Plus OAuth authentication for GPT models",
    provider: "openai",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    description: "GitHub Copilot authentication for GPT models",
    provider: "github-copilot",
  },
  { id: "gitlab", name: "GitLab Duo", description: "GitLab Duo authentication", provider: "gitlab" },
  { id: "poe", name: "Poe", description: "Poe platform authentication", provider: "poe" },
  {
    id: "cloudflare-workers",
    name: "Cloudflare Workers AI",
    description: "Cloudflare Workers AI gateway",
    provider: "cloudflare-workers",
  },
  {
    id: "cloudflare-aigateway",
    name: "Cloudflare AI Gateway",
    description: "Cloudflare AI Gateway authentication",
    provider: "cloudflare-aigateway",
  },
  { id: "azure", name: "Azure OpenAI", description: "Azure OpenAI Service authentication", provider: "azure" },
]

function state(api: TuiPluginApi, item: TuiPluginStatus) {
  if (!item.enabled) {
    return <span style={{ fg: api.theme.current.error }}>disabled</span>
  }

  return <span style={{ fg: api.theme.current.success }}>enabled</span>
}

function source(spec: string) {
  if (!spec.startsWith("file://")) return
  return fileURLToPath(spec)
}

function meta(item: TuiPluginStatus, width: number) {
  if (item.source === "internal") return "built-in plugin"
  const next = source(item.spec)
  if (next) return width >= 120 ? next : path.basename(next)
  if (item.source === "npm") return parsePluginSpecifier(item.spec).pkg
  return width >= 120 ? item.spec : pluginName(item.spec)
}

function pluginName(spec: string) {
  if (spec.startsWith("file://")) {
    const file = fileURLToPath(spec)
    const part = path.basename(file)
    const base = part.includes(".") ? part.slice(0, part.lastIndexOf(".")) : part
    if (base === "index") {
      const dir = path.basename(path.dirname(file))
      return dir || base
    }
    return base
  }

  return parsePluginSpecifier(spec).pkg
}

function pluginIdentity(spec: string) {
  if (spec.startsWith("file://")) return spec
  return parsePluginSpecifier(spec).pkg
}

function configuredPluginStateKey(spec: string) {
  return `spec:${pluginIdentity(spec)}`
}

function readPluginEnabledMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((item): item is [string, boolean] => typeof item[1] === "boolean"),
  )
}

function configuredPluginEnabled(api: TuiPluginApi, spec: string) {
  const key = configuredPluginStateKey(spec)
  const config = readPluginEnabledMap(api.tuiConfig.plugin_enabled)
  const kv = readPluginEnabledMap(api.kv.get(PLUGIN_ENABLED_KEY, {}))
  return kv[key] ?? config[key] ?? true
}

function pluginDescription(spec: string, width: number, label: string) {
  if (spec.startsWith("file://")) {
    const file = fileURLToPath(spec)
    if (width >= 120) return `${label}: ${path.basename(file)}`
    return label.toLowerCase()
  }

  if (width >= 100) return `${label}: ${parsePluginSpecifier(spec).pkg}`
  return label.toLowerCase()
}

function backendEnabled(api: TuiPluginApi, id: string) {
  const disabled = new Set(api.state.config.disabled_providers ?? [])
  if (disabled.has(id)) return false
  const enabled = api.state.config.enabled_providers
  if (!enabled) return true
  return enabled.includes(id)
}

export function backendPluginProvider(id: string) {
  return BACKEND_PLUGINS.find((plugin) => plugin.id === id)?.provider ?? id
}

export function configuredPlugins(api: TuiPluginApi, width: number, list: ReadonlyArray<TuiPluginStatus>) {
  const seen = new Set(list.map((item) => pluginIdentity(item.spec)))
  const specs = [...(api.state.config.plugin ?? []), ...(api.tuiConfig.plugin ?? [])]
  const rows: ListedPlugin[] = []

  for (const item of specs) {
    const spec = ConfigPlugin.pluginSpecifier(item as PluginSpec)
    const identity = pluginIdentity(spec)
    if (seen.has(identity)) continue
    seen.add(identity)
    const enabled = configuredPluginEnabled(api, spec)
    rows.push({
      title: pluginName(spec),
      value: `config:${identity}`,
      category: "Configured",
      spec,
      enabled,
      description: pluginDescription(spec, width, "No TUI entry"),
      footer: enabled ? "enabled" : "disabled",
    })
  }

  return rows.sort((a, b) => a.title.localeCompare(b.title))
}

export function backendPlugins(width: number) {
  return BACKEND_PLUGINS.map<ListedPlugin>((plugin) => ({
    title: plugin.name,
    value: `backend:${plugin.id}`,
    category: "Backend/Auth",
    description: width >= 96 ? plugin.provider : undefined,
    footer: "",
  }))
}

function Install(props: { api: TuiPluginApi }) {
  const [global, setGlobal] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  useKeyboard((evt) => {
    if (evt.name !== "tab") return
    evt.preventDefault()
    evt.stopPropagation()
    if (busy()) return
    setGlobal((x) => !x)
  })

  return (
    <props.api.ui.DialogPrompt
      title="Install plugin"
      placeholder="npm package name"
      busy={busy()}
      busyText="Installing plugin..."
      description={() => (
        <box flexDirection="row" gap={1}>
          <text fg={props.api.theme.current.textMuted}>scope:</text>
          <text fg={busy() ? props.api.theme.current.textMuted : props.api.theme.current.text}>
            {global() ? "global" : "local"}
          </text>
          <Show when={!busy()}>
            <text fg={props.api.theme.current.textMuted}>({Keybind.toString(tab)} toggle)</text>
          </Show>
        </box>
      )}
      onConfirm={(raw) => {
        if (busy()) return
        const mod = raw.trim()
        if (!mod) {
          props.api.ui.toast({
            variant: "error",
            message: "Plugin package name is required",
          })
          return
        }

        setBusy(true)
        void props.api.plugins
          .install(mod, { global: global() })
          .then((out) => {
            if (!out.ok) {
              props.api.ui.toast({
                variant: "error",
                message: out.message,
              })
              if (out.missing) {
                props.api.ui.toast({
                  variant: "info",
                  message: "Check npm registry/auth settings and try again.",
                })
              }
              show(props.api)
              return
            }

            props.api.ui.toast({
              variant: "success",
              message: `Installed ${mod} (${global() ? "global" : "local"}: ${out.dir})`,
            })
            if (!out.tui) {
              props.api.ui.toast({
                variant: "info",
                message: "Package has no TUI target to load in this app.",
              })
              show(props.api)
              return
            }

            return props.api.plugins.add(mod).then((ok) => {
              if (!ok) {
                props.api.ui.toast({
                  variant: "warning",
                  message: "Installed plugin, but runtime load failed. See console/logs; restart TUI to retry.",
                })
                show(props.api)
                return
              }

              props.api.ui.toast({
                variant: "success",
                message: `Loaded ${mod} in current session.`,
              })
              show(props.api)
            })
          })
          .finally(() => {
            setBusy(false)
          })
      }}
      onCancel={() => {
        show(props.api)
      }}
    />
  )
}

function row(api: TuiPluginApi, item: TuiPluginStatus, width: number): DialogSelectOption<string> {
  return {
    title: item.id,
    value: item.id,
    category: item.source === "internal" ? "Internal" : "External",
    description: meta(item, width),
    footer: state(api, item),
    disabled: item.id === id,
  }
}

function listedRow(api: TuiPluginApi, item: ListedPlugin): DialogSelectOption<string> {
  return {
    title: item.title,
    value: item.value,
    category: item.category,
    description: item.description,
    footer: item.footer,
  }
}

function showInstall(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <Install api={api} />)
}

function View(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()
  const sync = useSync()
  const [list, setList] = createSignal(props.api.plugins.list())
  const [cur, setCur] = createSignal<string | undefined>()
  const [lock, setLock] = createSignal(false)

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

  const rows = createMemo(() => {
    const width = size().width
    const tuiPlugins = [...list()]
      .sort((a, b) => {
        const x = a.source === "internal" ? 1 : 0
        const y = b.source === "internal" ? 1 : 0
        if (x !== y) return x - y
        return a.id.localeCompare(b.id)
      })
      .map((item) => row(props.api, item, width))

    const backendRows = backendPlugins(width).map((item) => {
      const enabled = backendEnabled(props.api, backendPluginProvider(item.value.replace("backend:", "")))
      return listedRow(props.api, {
        ...item,
        footer: (
          <span style={{ fg: enabled ? props.api.theme.current.success : props.api.theme.current.error }}>
            {enabled ? "enabled" : "disabled"}
          </span>
        ),
      })
    })

    return [
      ...tuiPlugins,
      ...configuredPlugins(props.api, width, list()).map((item) =>
        listedRow(props.api, {
          ...item,
          footer: state(props.api, { enabled: item.enabled ?? true } as TuiPluginStatus),
        }),
      ),
      ...backendRows,
    ]
  })

  const toggleBackend = async (provider: string) => {
    if (lock()) return
    setLock(true)
    const beforeDisabled = sync.data.config.disabled_providers ?? []
    const beforeEnabled = sync.data.config.enabled_providers
    const active = backendEnabled(props.api, provider)
    const nextDisabled = active
      ? [...new Set([...beforeDisabled, provider])]
      : beforeDisabled.filter((item) => item !== provider)
    const nextEnabled =
      beforeEnabled === undefined
        ? undefined
        : active
          ? beforeEnabled.filter((item) => item !== provider)
          : [...new Set([...beforeEnabled, provider])]

    sync.set("config", "disabled_providers", nextDisabled)
    if (nextEnabled !== undefined) sync.set("config", "enabled_providers", nextEnabled)

    await props.api.client.global.config
      .update({
        config: {
          disabled_providers: nextDisabled,
          ...(nextEnabled !== undefined ? { enabled_providers: nextEnabled } : {}),
        },
      })
      .then(async (result) => {
        if (result.error) throw result.error
        await sync.bootstrap({ fatal: false })
      })
      .catch((error) => {
        sync.set("config", "disabled_providers", beforeDisabled)
        if (beforeEnabled !== undefined) sync.set("config", "enabled_providers", beforeEnabled)
        props.api.ui.toast({
          variant: "error",
          message: error instanceof Error ? error.message : `Failed to update provider ${provider}`,
        })
      })
      .finally(() => {
        setLock(false)
      })
  }

  const toggleConfigured = async (value: string) => {
    const item = configuredPlugins(props.api, size().width, list()).find((entry) => entry.value === value)
    if (!item?.spec) return

    setLock(true)
    const key = configuredPluginStateKey(item.spec)
    const before = readPluginEnabledMap(props.api.kv.get(PLUGIN_ENABLED_KEY, {}))
    const enabled = item.enabled ?? true
    const next = {
      ...before,
      [key]: !enabled,
    }
    props.api.kv.set(PLUGIN_ENABLED_KEY, next)

    if (!enabled) {
      const ok = await props.api.plugins.add(item.spec)
      if (!ok) {
        props.api.ui.toast({
          variant: "info",
          message: `Enabled ${item.title}, but it still has no TUI entry or failed to load.`,
        })
      }
    }

    setList(props.api.plugins.list())
    setLock(false)
  }

  const flip = (x: string) => {
    if (x.startsWith("backend:")) {
      void toggleBackend(backendPluginProvider(x.replace("backend:", "")))
      return
    }
    if (x.startsWith("config:")) {
      if (lock()) return
      void toggleConfigured(x)
      return
    }
    if (lock()) return
    const item = list().find((entry) => entry.id === x)
    if (!item) return
    setLock(true)
    const task = item.active ? props.api.plugins.deactivate(x) : props.api.plugins.activate(x)
    void task
      .then((ok) => {
        if (!ok) {
          props.api.ui.toast({
            variant: "error",
            message: `Failed to update plugin ${item.id}`,
          })
        }
        setList(props.api.plugins.list())
      })
      .finally(() => {
        setLock(false)
      })
  }

  return (
    <DialogSelect
      title="Plugins"
      options={rows()}
      footerLeft={
        <>
          <span style={{ fg: props.api.theme.current.text }}>{"↑↓"}</span> navigate
        </>
      }
      current={cur()}
      onMove={(item) => setCur(item.value)}
      keybind={[
        {
          title: "toggle",
          keybind: key,
          disabled: lock(),
          onTrigger: (item) => {
            setCur(item.value)
            flip(item.value)
          },
        },
        {
          title: "install",
          keybind: add,
          disabled: lock(),
          onTrigger: () => {
            showInstall(props.api)
          },
        },
      ]}
      onSelect={(item) => {
        setCur(item.value)
        flip(item.value)
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
      title: "Plugin Manager",
      value: "plugins.list",
      keybind: "plugin_manager",
      category: "System",
      slash: {
        name: "plugins",
        aliases: ["plugin"],
      },
      onSelect() {
        show(api)
      },
    },
    {
      title: "Install plugin",
      value: "plugins.install",
      category: "System",
      onSelect() {
        showInstall(api)
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
