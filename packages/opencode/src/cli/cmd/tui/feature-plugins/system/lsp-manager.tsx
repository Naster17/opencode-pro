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
import * as LSPServer from "@/lsp/server"

const id = "internal:lsp-manager"
const toggle = Keybind.parse("space").at(0)
const installKey = Keybind.parse("shift+i").at(0)
const deleteKey = Keybind.parse("shift+d").at(0)
const details = Keybind.parse("tab").at(0)
const globalID = "global:lsp"
type PendingAction = "installing" | "deleting"

type ListedServer = {
  kind: "server"
  id: string
  title: string
  description?: string
  enabled: boolean
  installed: boolean
  managed: boolean
  active: boolean
  pending?: PendingAction
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
type ServerStatus = "enabled" | "disabled" | "not-installed" | PendingAction

function footer(api: TuiPluginApi, label: string, color: keyof TuiPluginApi["theme"]["current"]): JSX.Element {
  return <span style={{ fg: api.theme.current[color] }}>{label}</span>
}

function category(item: ListedItem) {
  if (item.kind === "global") return "Settings"
  if (item.pending === "installing") return "Installed"
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
  if (item.pending) return item.pending
  if (!item.installed) return "not-installed"
  if (!item.enabled || !globalEnabled) return "disabled"
  return "enabled"
}

function serverFooter(api: TuiPluginApi, item: ListedServer, globalEnabled: boolean) {
  const status = serverStatus(item, globalEnabled)
  if (status === "installing") return footer(api, "installing...", "primary")
  if (status === "deleting") return footer(api, "deleting...", "error")
  if (status === "not-installed") return footer(api, status, "textMuted")
  if (status === "disabled") return footer(api, status, "error")
  return footer(api, status, "success")
}

function globalFooter(api: TuiPluginApi, item: ListedGlobal) {
  return item.enabled ? footer(api, "enabled", "success") : footer(api, "disabled", "error")
}

function binaryDetails(item: ListedServer) {
  const resolved = LSPCatalog.resolvedBinaries(item.spec)
  if (resolved.length) {
    return [
      "Resolved binaries:",
      ...resolved.map((item) => `  ${item.candidate}: ${item.path}${item.source === "managed" ? " (managed)" : ""}`),
    ]
  }
  if (!item.spec.binaries.length) return ["Resolved binaries: none declared"]
  return ["Resolved binaries:", ...item.spec.binaries.map((candidate) => `  ${candidate}: not found`)]
}

function noteDetails(item: ListedServer) {
  if (item.id === "ruby-lsp") {
    return [
      "Launch note: this entry is backed by rubocop --lsp.",
      "That means opencode may find Ruby/rubocop even if you do not have a separate ruby-lsp binary installed.",
    ]
  }
  return []
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
        : item.description,
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
  const [pending, setPending] = createSignal<Record<string, PendingAction>>({})

  const globalEnabled = createMemo(() => LSPOverride.resolveEnabled(props.api.state.config.lsp, override()))

  createEffect(() => {
    props.api.state.config.lsp
    void LSPOverride.readGlobalOverride().then(setOverride)
  })

  const lspEntries = createMemo(() =>
    LSPCatalog.list(props.api.state.config.lsp)
      .map<ListedServer>((spec) => {
        const currentPending = pending()[spec.id]
        const userConfig = isRecord(props.api.state.config.lsp) ? props.api.state.config.lsp[spec.id] : undefined
        const enabled = !(isRecord(userConfig) && userConfig.disabled === true)
        const active = props.api.state.lsp().some((item) => item.id === spec.id && item.status === "connected")
        return {
          kind: "server",
          id: spec.id,
          title: LSPCatalog.displayTitle(spec),
          description: undefined,
          enabled,
          installed:
            currentPending === "installing" ? true : currentPending === "deleting" ? false : LSPCatalog.detectInstalled(spec, active),
          managed:
            currentPending === "installing"
              ? true
              : currentPending === "deleting"
                ? false
                : LSPServer.managedInstallExists(spec.id),
          active,
          pending: currentPending,
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
  const selected = createMemo(() => items().find((item) => item.id === current()))
  const currentServer = createMemo<ListedServer | undefined>(() => {
    const item = selected()
    return item?.kind === "server" ? item : undefined
  })
  const canToggleCurrent = createMemo(() => {
    const item = currentServer()
    return item?.pending === undefined && item?.installed !== false
  })
  const canInstallCurrent = createMemo(() => {
    const item = currentServer()
    return item?.pending === undefined && item?.installed === false
  })
  const canDeleteCurrent = createMemo(() => {
    const item = currentServer()
    return item?.pending === undefined && item?.managed === true
  })

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
      `Manager: ${LSPCatalog.manager(item.spec.id) ?? item.spec.id}`,
      `Source: ${item.spec.kind}`,
      `Status: ${status}`,
      `Installed: ${item.installed ? "yes" : "no"}`,
      `Managed install: ${item.managed ? "yes" : "no"}`,
      `Extensions: ${item.spec.extensions.join(", ") || "(all files)"}`,
      `Binaries: ${item.spec.binaries.join(", ") || "none declared"}`,
      ...binaryDetails(item),
      ...(item.spec.kind === "custom" && item.spec.command.length
        ? [`Command: ${item.spec.command.join(" ")}`]
        : []),
      ...noteDetails(item),
      `Connected roots: ${roots.join(", ") || "none"}`,
    ].join("\n")
    props.api.ui.dialog.replace(() => (
      <DetailsDialog title={LSPCatalog.displayTitle(item.spec)} message={message} onBack={() => show(props.api, item.id)} />
    ))
  }

  const setPendingState = (itemID: string, action?: PendingAction) =>
    setPending((prev) => {
      if (prev[itemID] === action) return prev
      if (!action) {
        if (!(itemID in prev)) return prev
        const next = { ...prev }
        delete next[itemID]
        return next
      }
      return { ...prev, [itemID]: action }
    })

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
    if (!item.installed) return
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

  const install = (itemID: string) => {
    if (busy()) return
    const item = lspEntries().find((entry) => entry.id === itemID)
    if (!item || item.installed) return
    setPendingState(item.id, "installing")
    setBusy(true)
    void props.api.client.lsp
      .install({ id: item.id })
      .then(async (result) => {
        if (!result.data) {
          props.api.ui.toast({
            variant: "error",
            message: `Failed to install ${item.id} LSP`,
          })
          return
        }
        if (!result.data.ok) {
          props.api.ui.toast({
            variant: "warning",
            message: result.data.message,
          })
          return
        }
        await sync.bootstrap({ fatal: false })
        const installed = LSPCatalog.detectInstalled(item.spec)
        props.api.ui.toast({
          variant: installed ? "success" : "warning",
          message: installed
            ? `Installed ${item.title}`
            : `Finished installing ${item.title}, but it is still not detected`,
        })
      })
      .catch((error: unknown) => {
        props.api.ui.toast({
          variant: "error",
          message: error instanceof Error ? error.message : `Failed to install ${item.id} LSP`,
        })
      })
      .finally(() => {
        setPendingState(item.id)
        setBusy(false)
      })
  }

  const remove = (itemID: string) => {
    if (busy()) return
    const item = lspEntries().find((entry) => entry.id === itemID)
    if (!item || !item.managed) return
    setPendingState(item.id, "deleting")
    setBusy(true)
    void props.api.client.lsp
      .uninstall({ id: item.id })
      .then(async (result) => {
        if (!result.data) {
          props.api.ui.toast({
            variant: "error",
            message: `Failed to delete ${item.id} LSP`,
          })
          return
        }
        if (!result.data.ok) {
          props.api.ui.toast({
            variant: "warning",
            message: result.data.message,
          })
          return
        }
        await sync.bootstrap({ fatal: false })
        const installed = LSPCatalog.detectInstalled(item.spec)
        props.api.ui.toast({
          variant: installed ? "warning" : "success",
          message: installed
            ? `Deleted managed ${item.title}, but another binary is still available`
            : `Deleted ${item.title}`,
        })
      })
      .catch((error: unknown) => {
        props.api.ui.toast({
          variant: "error",
          message: error instanceof Error ? error.message : `Failed to delete ${item.id} LSP`,
        })
      })
      .finally(() => {
        setPendingState(item.id)
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
          disabled: busy() || !canToggleCurrent(),
          onTrigger: (item) => {
            setCurrent(item.value)
            flip(item.value)
          },
        },
        {
          title: "install",
          keybind: installKey,
          disabled: busy() || !canInstallCurrent(),
          onTrigger: (item) => {
            setCurrent(item.value)
            install(item.value)
          },
        },
        {
          title: "delete",
          keybind: deleteKey,
          disabled: busy() || !canDeleteCurrent(),
          onTrigger: (item) => {
            setCurrent(item.value)
            remove(item.value)
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
        if (item.value !== globalID) {
          const selected = lspEntries().find((entry) => entry.id === item.value)
          if (selected && (!selected.installed || selected.pending)) return
        }
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
