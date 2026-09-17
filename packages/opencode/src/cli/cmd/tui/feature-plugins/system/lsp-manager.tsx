import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { Keybind } from "@/util/keybind"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
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

function DetailsDialog(props: { item: ListedServer; status: ServerStatus; roots: string[]; onBack: () => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const size = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined

  const resolved = createMemo(() => LSPCatalog.resolvedBinaries(props.item.spec))
  const maxContentHeight = createMemo(() => Math.max(10, size().height - 18))
  const scrollStep = createMemo(() => Math.max(3, Math.floor(maxContentHeight() / 3)))
  const manager = createMemo(() => LSPCatalog.manager(props.item.spec.id) ?? props.item.spec.id)
  const width = createMemo(() =>
    Math.min(size().width - 4, lspDetailsWidth(props.item, props.status, props.roots, resolved(), manager())),
  )
  const contentLines = createMemo(
    () =>
      9 +
      6 +
      3 +
      Math.max(1, resolved().length) +
      (props.item.spec.kind === "custom" && props.item.spec.command.length ? 1 : 0),
  )
  const shouldScroll = createMemo(() => contentLines() > maxContentHeight())

  useKeyboard((evt) => {
    if (evt.name === "up" && scroll) {
      scroll.scrollBy(-1)
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "down" && scroll) {
      scroll.scrollBy(1)
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "pageup" && scroll) {
      scroll.scrollBy(-scrollStep())
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
    if (evt.name === "pagedown" && scroll) {
      scroll.scrollBy(scrollStep())
      evt.preventDefault()
      evt.stopPropagation()
      return
    }
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

  createEffect(() => {
    dialog.setSize("medium")
    dialog.setWidth(width())
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={0}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.item.spec.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={props.onBack}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>
        {props.item.spec.id} <span style={{ fg: theme.accent }}>• {manager()}</span>
      </text>
      <box flexDirection="row" flexWrap="wrap" gap={1} paddingTop={1} paddingBottom={1}>
        <DetailBadge label={props.status} color={statusColor(theme, props.status)} />
        <DetailBadge
          label={props.item.installed ? "installed" : "not installed"}
          color={props.item.installed ? theme.success : theme.textMuted}
        />
        <DetailBadge
          label={props.item.managed ? "managed" : "system"}
          color={props.item.managed ? theme.primary : theme.textMuted}
        />
        <Show when={props.item.active}>
          <DetailBadge label="connected" color={theme.accent} />
        </Show>
      </box>
      <Show
        when={shouldScroll()}
        fallback={<DetailsContent item={props.item} status={props.status} roots={props.roots} resolved={resolved()} />}
      >
        <scrollbox
          paddingRight={1}
          maxHeight={maxContentHeight()}
          scrollX={false}
          scrollY={true}
          verticalScrollbarOptions={{ visible: true }}
          horizontalScrollbarOptions={{ visible: false }}
          ref={(value: ScrollBoxRenderable) => {
            scroll = value
          }}
        >
          <DetailsContent item={props.item} status={props.status} roots={props.roots} resolved={resolved()} />
        </scrollbox>
      </Show>
    </box>
  )
}

function DetailsContent(props: {
  item: ListedServer
  status: ServerStatus
  roots: string[]
  resolved: ReturnType<typeof LSPCatalog.resolvedBinaries>
}) {
  const { theme } = useTheme()
  const manager = createMemo(() => LSPCatalog.manager(props.item.spec.id) ?? props.item.spec.id)

  return (
    <box gap={0}>
      <DetailSection title="Server">
        <DetailRow label="ID">{props.item.spec.id}</DetailRow>
        <DetailRow label="Manager" valueColor={theme.accent}>
          {manager()}
        </DetailRow>
        <DetailRow label="Source">{props.item.spec.kind}</DetailRow>
        <DetailRow label="Status" valueColor={statusColor(theme, props.status)}>
          {props.status}
        </DetailRow>
        <DetailRow label="Installed" valueColor={props.item.installed ? theme.success : theme.error}>
          {props.item.installed ? "yes" : "no"}
        </DetailRow>
        <DetailRow label="Managed install" valueColor={props.item.managed ? theme.primary : theme.textMuted}>
          {props.item.managed ? "yes" : "no"}
        </DetailRow>
      </DetailSection>

      <DetailSection title="Files">
        <DetailRow label="Extensions">{props.item.spec.extensions.join(", ") || "(all files)"}</DetailRow>
        <DetailRow label="Connected roots">{props.roots.join(", ") || "none"}</DetailRow>
      </DetailSection>

      <DetailSection title="Launch">
        <DetailRow label="Declared binaries">{props.item.spec.binaries.join(", ") || "none declared"}</DetailRow>
        <Show when={props.resolved.length > 0} fallback={<DetailRow label="Resolved binaries">not found</DetailRow>}>
          <DetailRows
            label="Resolved binaries"
            lines={props.resolved.map(
              (item) => `${item.candidate}: ${item.path}${item.source === "managed" ? " (managed)" : ""}`,
            )}
          />
        </Show>
        <Show when={props.item.spec.kind === "custom" && props.item.spec.command.length}>
          <DetailRow label="Command">
            {props.item.spec.kind === "custom" ? props.item.spec.command.join(" ") : ""}
          </DetailRow>
        </Show>
      </DetailSection>
    </box>
  )
}

function statusColor(theme: TuiPluginApi["theme"]["current"], status: ServerStatus) {
  if (status === "enabled") return theme.success
  if (status === "disabled") return theme.error
  if (status === "installing") return theme.primary
  if (status === "deleting") return theme.warning
  return theme.textMuted
}

function DetailSection(props: { title: string; children: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <box gap={0} paddingBottom={1}>
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      <box paddingLeft={1}>{props.children}</box>
    </box>
  )
}

function DetailRow(props: {
  label: string
  children: JSX.Element
  valueColor?: TuiPluginApi["theme"]["current"]["text"]
}) {
  const { theme } = useTheme()
  return (
    <text fg={theme.textMuted} wrapMode="char" width="100%">
      <span style={{ fg: theme.text, bold: true }}>{props.label}</span>:{" "}
      <span style={{ fg: props.valueColor ?? theme.textMuted }}>{props.children}</span>
    </text>
  )
}

function DetailRows(props: { label: string; lines: string[] }) {
  return (
    <>
      <DetailRow label={props.label}>{props.lines.at(0) ?? ""}</DetailRow>
      <For each={props.lines.slice(1)}>
        {(line) => (
          <text fg={useTheme().theme.textMuted} wrapMode="char" width="100%">
            <span style={{ fg: useTheme().theme.textMuted }}>{line}</span>
          </text>
        )}
      </For>
    </>
  )
}

function DetailBadge(props: { label: string; color: TuiPluginApi["theme"]["current"]["text"] }) {
  return (
    <text>
      <span style={{ fg: props.color, bold: true }}>[{props.label}]</span>
    </text>
  )
}

function lspDetailsWidth(
  item: ListedServer,
  status: ServerStatus,
  roots: string[],
  resolved: ReturnType<typeof LSPCatalog.resolvedBinaries>,
  manager: string,
) {
  const lengths = [
    item.spec.title.length,
    `${item.spec.id} • ${manager}`.length,
    `[${status}] [${item.installed ? "installed" : "not installed"}] [${item.managed ? "managed" : "system"}]`.length,
    `ID: ${item.spec.id}`.length,
    `Manager: ${manager}`.length,
    `Source: ${item.spec.kind}`.length,
    `Status: ${status}`.length,
    `Installed: ${item.installed ? "yes" : "no"}`.length,
    `Managed install: ${item.managed ? "yes" : "no"}`.length,
    `Extensions: ${item.spec.extensions.join(", ") || "(all files)"}`.length,
    `Connected roots: ${roots.join(", ") || "none"}`.length,
    `Declared binaries: ${item.spec.binaries.join(", ") || "none declared"}`.length,
    ...(resolved.length
      ? resolved.map(
          (entry) =>
            `Resolved binaries: ${entry.candidate}: ${entry.path}${entry.source === "managed" ? " (managed)" : ""}`
              .length,
        )
      : [`Resolved binaries: not found`.length]),
    ...(item.spec.kind === "custom" && item.spec.command.length
      ? [`Command: ${item.spec.command.join(" ")}`.length]
      : []),
  ].sort((a, b) => a - b)
  const target = lengths[Math.max(0, Math.floor(lengths.length * 0.8) - 1)] ?? 60
  return Math.max(56, Math.min(72, target + 8))
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
          title: spec.title,
          description: undefined,
          enabled,
          installed:
            currentPending === "installing"
              ? true
              : currentPending === "deleting"
                ? false
                : LSPCatalog.detectInstalled(spec, active),
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
      .toSorted(
        (left, right) => Number(right.installed) - Number(left.installed) || left.title.localeCompare(right.title),
      ),
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
    const roots = props.api.state
      .lsp()
      .filter((entry) => entry.id === item.id && entry.status === "connected")
      .map((entry) => entry.root)
    const status = serverStatus(item, globalEnabled())
    props.api.ui.dialog.replace(() => (
      <DetailsDialog item={item} status={status} roots={roots} onBack={() => show(props.api, item.id)} />
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

  const syncServerState = async (item: ListedServer) => {
    await sync.bootstrap({ fatal: false }).catch(() => {})
    return {
      installed: LSPCatalog.detectInstalled(item.spec),
      managed: LSPServer.managedInstallExists(item.id),
    }
  }

  const resultMessage = (result: { data?: { message?: string }; error?: unknown } | undefined) => {
    if (result?.data?.message) return result.data.message
    if (result?.error instanceof Error) return result.error.message
    if (typeof result?.error === "string") return result.error
  }

  const installToast = (
    item: ListedServer,
    state: { installed: boolean; managed: boolean },
    failed: boolean,
    message?: string,
  ) => {
    if (state.installed) {
      props.api.ui.toast({
        variant: "success",
        message: state.managed
          ? `Successfully installed ${item.title}`
          : `Successfully installed ${item.title} and detected it from your system`,
      })
      return
    }

    props.api.ui.toast({
      variant: failed ? "error" : "warning",
      message: failed
        ? (message ?? `Failed to install ${item.id} LSP`)
        : `Finished installing ${item.title}, but it is still not detected in system`,
    })
  }

  const deleteToast = (
    item: ListedServer,
    state: { installed: boolean; managed: boolean },
    failed: boolean,
    message?: string,
  ) => {
    if (!state.managed) {
      props.api.ui.toast({
        variant: state.installed ? "warning" : "success",
        message: state.installed
          ? `Deleted managed ${item.title}, but another version was found on your system`
          : `Successfully deleted ${item.title}`,
      })
      return
    }

    props.api.ui.toast({
      variant: "error",
      message: failed
        ? (message ?? `Failed to delete ${item.id} LSP`)
        : `Failed to fully delete ${item.title}. Managed files are still present.`,
    })
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
        const state = await syncServerState(item)
        const failed = result?.data?.ok === false || Boolean(result?.error)
        installToast(item, state, failed, resultMessage(result))
      })
      .catch(async (error: unknown) => {
        const state = await syncServerState(item)
        installToast(
          item,
          state,
          true,
          error instanceof Error ? `Installation error: ${error.message}` : `Failed to install ${item.id} LSP`,
        )
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
        const state = await syncServerState(item)
        const failed = result?.data?.ok === false || Boolean(result?.error)
        deleteToast(item, state, failed, resultMessage(result))
      })
      .catch(async (error: unknown) => {
        const state = await syncServerState(item)
        deleteToast(
          item,
          state,
          true,
          error instanceof Error ? `Deletion error: ${error.message}` : `Failed to delete ${item.id} LSP`,
        )
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
