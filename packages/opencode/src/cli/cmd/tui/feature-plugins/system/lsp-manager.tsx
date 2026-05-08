import { TextAttributes } from "@opentui/core"
import { Keybind } from "@/util/keybind"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { isRecord } from "@/util/record"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { LSPCatalog } from "@/lsp/catalog"
import { LSPOverride } from "@/lsp/override"

const id = "internal:lsp-manager"
const toggle = Keybind.parse("space").at(0)
const details = Keybind.parse("tab").at(0)
const globalID = "global:lsp"

type ListedServer = {
  kind: "server"
  id: string
  title: string
  description?: string
  enabled: boolean
  installed: boolean
  active: boolean
  spec: LSPCatalog.Spec
}

type ListedGlobal = {
  kind: "global"
  id: typeof globalID
  title: string
  enabled: boolean
  inherited: boolean
}

type ListedItem = ListedServer | ListedGlobal
type ServerStatus = "enabled" | "disabled" | "not-installed"

function footer(api: TuiPluginApi, label: string, color: keyof TuiPluginApi["theme"]["current"]): JSX.Element {
  return <span style={{ fg: api.theme.current[color] }}>{label}</span>
}

function category(item: ListedItem) {
  if (item.kind === "global") return "Settings"
  if (item.installed) return "Installed"
  return "Not Installed"
}

function nextConfig(config: TuiPluginApi["state"]["config"], id: string, enable: boolean) {
  if (enable) {
    if (!isRecord(config.lsp)) return true
    const result = Object.fromEntries(Object.entries(config.lsp).filter(([key]) => key !== id))
    return Object.keys(result).length ? result : true
  }

  const result = isRecord(config.lsp) ? { ...config.lsp } : {}
  result[id] = isRecord(result[id]) ? { ...result[id], disabled: true } : { disabled: true }
  return result
}

function serverStatus(item: ListedServer, globalEnabled: boolean): ServerStatus {
  if (!item.installed) return "not-installed"
  if (!item.enabled || !globalEnabled) return "disabled"
  return "enabled"
}

function serverFooter(api: TuiPluginApi, item: ListedServer, globalEnabled: boolean) {
  const status = serverStatus(item, globalEnabled)
  if (status === "not-installed") return footer(api, status, "textMuted")
  if (status === "disabled") return footer(api, status, "error")
  return footer(api, status, "success")
}

function globalFooter(api: TuiPluginApi, item: ListedGlobal) {
  return item.enabled ? footer(api, "enabled", "success") : footer(api, "disabled", "error")
}

function DetailsDialog(props: {
  title: string
  message: string
  onBack: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()

  useKeyboard((evt) => {
    if (evt.name !== "return") return
    evt.preventDefault()
    evt.stopPropagation()
    props.onBack()
  })

  onMount(() => {
    dialog.setBeforeClose(() => {
      props.onBack()
      return false
    })
  })

  onCleanup(() => {
    dialog.setBeforeClose(undefined)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={props.onBack}>
          esc
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{props.message}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={props.onBack}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

function row(api: TuiPluginApi, item: ListedItem, globalEnabled: boolean): DialogSelectOption<string> {
  return {
    title: item.title,
    value: item.id,
    category: category(item),
    description:
      item.kind === "global"
        ? item.inherited
          ? "Inherited from config until you toggle it here"
          : "Persisted from your last choice"
        : undefined,
    footer: item.kind === "global" ? globalFooter(api, item) : serverFooter(api, item, globalEnabled),
  }
}

function show(api: TuiPluginApi, current?: string) {
  api.ui.dialog.replace(() => <View api={api} initialCurrent={current} />)
}

function View(props: { api: TuiPluginApi; initialCurrent?: string }) {
  const size = useTerminalDimensions()
  const sync = useSync()
  const [current, setCurrent] = createSignal<string | undefined>(props.initialCurrent ?? globalID)
  const [busy, setBusy] = createSignal(false)
  const [override, setOverride] = createSignal<boolean | undefined>()

  const globalEnabled = createMemo(() => LSPOverride.resolveEnabled(props.api.state.config.lsp, override()))

  createEffect(() => {
    props.api.state.config.lsp
    void LSPOverride.readGlobalOverride().then(setOverride)
  })

  const lspEntries = createMemo(() =>
    LSPCatalog.list(props.api.state.config.lsp)
      .map<ListedServer>((spec) => {
        const userConfig = isRecord(props.api.state.config.lsp) ? props.api.state.config.lsp[spec.id] : undefined
        const enabled = !(isRecord(userConfig) && userConfig.disabled === true)
        const active = props.api.state.lsp().some((item) => item.id === spec.id && item.status === "connected")
        return {
        kind: "server",
        id: spec.id,
        title: spec.title === spec.id ? spec.title : `${spec.title} (${spec.id})`,
        description: spec.kind === "custom" ? "Custom" : undefined,
        enabled,
        installed: LSPCatalog.detectInstalled(spec, active),
        active,
        spec,
        }
      })
      .toSorted((left, right) => Number(right.installed) - Number(left.installed) || left.title.localeCompare(right.title)),
  )

  const items = createMemo<ListedItem[]>(() => [
    {
      kind: "global",
      id: globalID,
      title: "LSP globally",
      enabled: globalEnabled(),
      inherited: override() === undefined,
    },
    ...lspEntries(),
  ])

  const rows = createMemo(() => items().map((item) => row(props.api, item, globalEnabled())))

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

  const openDetails = (itemID: string) => {
    const item = lspEntries().find((entry) => entry.id === itemID)
    if (!item) return
    const roots = props.api.state.lsp()
      .filter((entry) => entry.id === item.id && entry.status === "connected")
      .map((entry) => entry.root)
    const status = serverStatus(item, globalEnabled())
    const message = [
      `ID: ${item.spec.id}`,
      `Source: ${item.spec.kind}`,
      `Status: ${status}`,
      `Installed: ${item.installed ? "yes" : "no"}`,
      `Extensions: ${item.spec.extensions.join(", ") || "(all files)"}`,
      `Binaries: ${item.spec.binaries.join(", ") || "none declared"}`,
      ...(item.spec.kind === "custom" && item.spec.command.length
        ? [`Command: ${item.spec.command.join(" ")}`]
        : []),
      `Connected roots: ${roots.join(", ") || "none"}`,
    ].join("\n")
    props.api.ui.dialog.replace(() => (
      <DetailsDialog title={`${item.spec.title} LSP`} message={message} onBack={() => show(props.api, item.id)} />
    ))
  }

  const flipGlobal = () => {
    if (busy()) return
    const enabled = !globalEnabled()
    setBusy(true)
    void LSPOverride.writeGlobalOverride(enabled)
      .then(() => props.api.client.global.dispose())
      .then(async () => {
        setOverride(enabled)
        await sync.bootstrap({ fatal: false })
        props.api.ui.toast({
          variant: "success",
          message: `${enabled ? "Enabled" : "Disabled"} LSP globally`,
        })
      })
      .catch((error) => {
        props.api.ui.toast({
          variant: "error",
          message: error instanceof Error ? error.message : "Failed to update global LSP state",
        })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const flip = (itemID: string) => {
    if (busy()) return
    if (itemID === globalID) {
      flipGlobal()
      return
    }
    const item = lspEntries().find((entry) => entry.id === itemID)
    if (!item) return
    const enable = !item.enabled
    const previous = props.api.state.config.lsp
    const next = nextConfig(props.api.state.config, item.id, enable)
    setBusy(true)
    sync.set("config", "lsp", next)
    void props.api.client.global.config
      .update({
        config: {
          lsp: next,
        },
      })
      .then(async (result) => {
        if (result.error) throw result.error
        await sync.bootstrap({ fatal: false })
        props.api.ui.toast({
          variant: "success",
          message: `${enable ? "Enabled" : "Disabled"} ${item.id} LSP`,
        })
      })
      .catch((error) => {
        sync.set("config", "lsp", previous)
        props.api.ui.toast({
          variant: "error",
          message: error instanceof Error ? error.message : `Failed to update ${item.id} LSP`,
        })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <DialogSelect
      title="LSP Manager"
      placeholder="Search LSP servers"
      options={rows()}
      current={current()}
      flat
      footerLeft={
        <>
          <span style={{ fg: props.api.theme.current.text }}>{"↑↓"}</span> navigate
        </>
      }
      onMove={(item) => setCurrent(item.value)}
      keybind={[
        {
          title: "toggle",
          keybind: toggle,
          disabled: busy(),
          onTrigger: (item) => {
            setCurrent(item.value)
            flip(item.value)
          },
        },
        {
          title: "details",
          keybind: details,
          disabled: busy() || current() === globalID,
          onTrigger: (item) => {
            setCurrent(item.value)
            openDetails(item.value)
          },
        },
      ]}
      onSelect={(item) => {
        setCurrent(item.value)
        flip(item.value)
      }}
    />
  )
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: "LSP Manager",
      value: "lsp.list",
      category: "System",
      slash: {
        name: "lsp",
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
