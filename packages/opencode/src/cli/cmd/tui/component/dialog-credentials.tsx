import path from "path"
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useSync } from "@tui/context/sync"
import { useTheme } from "../context/theme"
import { Global } from "@opencode-ai/core/global"
import { createMemo, createResource, createSignal, Match, Show, Switch } from "solid-js"
import { pipe, sortBy } from "remeda"
import type { Auth } from "@/auth"
import type { McpAuth } from "@/mcp/auth"
import { getScrollAcceleration } from "../util/scroll"
import { useTuiConfig } from "../context/tui-config"
import type { ScrollAcceleration } from "@opentui/core"

type ProviderCredential = {
  section: string
  title: string
  subtitle: string
  providerID: string
  providerName: string
  kind: "stored" | "env"
  auth?: Auth.Info
  envVars?: string[]
  connected: boolean
}

type McpCredential = {
  section: string
  title: string
  subtitle: string
  name: string
  entry: McpAuth.Entry
  status?: string
}

type CredentialItem =
  | { type: "provider"; value: ProviderCredential }
  | { type: "mcp"; value: McpCredential }

function titleCase(input: string) {
  return input
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function sectionName(providerID: string, providerName?: string) {
  const lower = providerID.toLowerCase()
  if (lower.includes("openai")) return "OpenAI"
  if (lower.includes("google")) return "Google"
  if (lower.includes("anthropic")) return "Anthropic"
  if (lower.includes("copilot") || lower.includes("github")) return "GitHub"
  if (lower.includes("opencode")) return "OpenCode"
  return providerName ?? titleCase(providerID)
}

function maskSecret(value: string) {
  if (value.length <= 8) return "*".repeat(Math.max(4, value.length))
  return `${value.slice(0, 4)}${"*".repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`
}

function formatDate(value?: number) {
  if (!value) return "Never"
  return new Date(value).toLocaleString()
}

function summarizeProvider(auth?: Auth.Info, envVars?: string[]) {
  if (auth?.type === "api") return "Stored API key"
  if (auth?.type === "oauth") return "Stored OAuth session"
  if (auth?.type === "wellknown") return "Stored external token"
  if (envVars?.length) return `Environment: ${envVars.join(", ")}`
  return "Credential"
}

async function readJson<T>(filepath: string, fallback: T): Promise<T> {
  try {
    return (await Bun.file(filepath).json()) as T
  } catch {
    return fallback
  }
}

async function loadCredentialItems(sync: ReturnType<typeof useSync>["data"]) {
  const auth = await readJson<Record<string, Auth.Info>>(path.join(Global.Path.data, "auth.json"), {})
  const mcp = await readJson<Record<string, McpAuth.Entry>>(path.join(Global.Path.data, "mcp-auth.json"), {})
  const providers = sync.provider_next.all
  const connected = new Set(sync.provider_next.connected)
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]))

  const envItems = providers.flatMap((provider) => {
    const envVars = provider.env.filter((name) => Boolean(process.env[name]))
    if (envVars.length === 0 || auth[provider.id]) return []
    return [{
      type: "provider" as const,
      value: {
        section: sectionName(provider.id, provider.name),
        title: provider.name,
        subtitle: summarizeProvider(undefined, envVars),
        providerID: provider.id,
        providerName: provider.name,
        kind: "env" as const,
        envVars,
        connected: connected.has(provider.id),
      },
    }]
  })

  const providerItems = Object.entries(auth).map(([providerID, entry]) => {
    const provider = providerMap.get(providerID)
    return {
      type: "provider" as const,
      value: {
        section: sectionName(providerID, provider?.name),
        title: provider?.name ?? titleCase(providerID),
        subtitle: summarizeProvider(entry),
        providerID,
        providerName: provider?.name ?? titleCase(providerID),
        kind: "stored" as const,
        auth: entry,
        envVars: provider?.env.filter((name) => Boolean(process.env[name])) ?? [],
        connected: connected.has(providerID),
      },
    }
  })

  const mcpItems = Object.entries(mcp).map(([name, entry]) => ({
    type: "mcp" as const,
    value: {
      section: "MCP",
      title: name,
      subtitle: entry.tokens ? "OAuth tokens" : entry.clientInfo ? "Client registration" : "OAuth state",
      name,
      entry,
      status: sync.mcp[name]?.status,
    },
  }))

  return pipe(
    [...providerItems, ...envItems, ...mcpItems],
    sortBy(
      (item) => item.value.section,
      (item) => (item.type === "provider" ? item.value.providerName : item.value.name),
      (item) => (item.type === "provider" ? item.value.providerID : item.value.name),
    ),
  )
}

function rowStatus(item: CredentialItem) {
  if (item.type === "mcp") {
    if (item.value.status === "connected") return "Connected"
    if (item.value.status === "needs_auth") return "Needs auth"
    if (item.value.status === "failed") return "Failed"
    return item.value.status ? titleCase(item.value.status) : "Stored"
  }
  if (item.value.connected) return item.value.kind === "env" ? "Env active" : "Connected"
  return item.value.kind === "env" ? "Env configured" : "Stored"
}

function rowColor(item: CredentialItem, theme: ReturnType<typeof useTheme>["theme"]) {
  const status = rowStatus(item)
  if (status === "Connected" || status === "Env active") return theme.success
  if (status === "Needs auth") return theme.warning
  if (status === "Failed") return theme.error
  return theme.textMuted
}

export function DialogCredentials() {
  const dialog = useDialog()
  const sync = useSync()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const [selected, setSelected] = createSignal<CredentialItem>()

  const [items] = createResource(() => loadCredentialItems(sync.data))

  const itemList = createMemo(() => items() ?? [])
  const selectedItem = createMemo(() => selected() ?? itemList()[0])
  const options = createMemo<DialogSelectOption<CredentialItem>[]>(() =>
    itemList().map((item) => ({
      title: item.value.title,
      value: item,
      description: item.value.subtitle,
      category: item.value.section,
      footer: rowStatus(item),
      gutter: () => <text fg={rowColor(item, theme)}>●</text>,
    })),
  )

  const currentIndex = createMemo(() => {
    const current = selectedItem()
    if (!current) return -1
    return itemList().findIndex((item) => JSON.stringify(item) === JSON.stringify(current))
  })

  const moveSelected = (direction: number) => {
    const list = itemList()
    if (list.length === 0) return
    const start = currentIndex() === -1 ? 0 : currentIndex()
    setSelected(list[(start + direction + list.length) % list.length])
  }

  useKeyboard((evt) => {
    if (!selectedItem()) return
    if (evt.name === "left") {
      evt.preventDefault()
      evt.stopPropagation()
      moveSelected(-1)
      return
    }
    if (evt.name === "right") {
      evt.preventDefault()
      evt.stopPropagation()
      moveSelected(1)
    }
  })

  return (
    <Show
      when={options().length > 0}
      fallback={
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1} flexDirection="column">
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Credentials
            </text>
            <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
              esc
            </text>
          </box>
          <text fg={theme.textMuted}>No stored or environment-backed credentials found.</text>
        </box>
      }
    >
      <box gap={2} paddingBottom={1} paddingLeft={1} paddingRight={1}>
        <box width={Math.max(42, Math.floor(dimensions().width * 0.4))}>
          <DialogSelect
            title="Credentials"
            options={options()}
            current={selectedItem()}
            onMove={(option) => setSelected(option.value)}
            onSelect={(option) => {
              setSelected(option.value)
              dialog.replace(() => <DialogCredentialInspect items={itemList()} initial={option.value} />)
            }}
            footerLeft={<text>Enter inspect  Left/Right next</text>}
          />
        </box>
        <CredentialDetail item={selectedItem()} scrollAcceleration={getScrollAcceleration(tuiConfig)} />
      </box>
    </Show>
  )
}

function DetailRow(props: { label: string; value: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" justifyContent="space-between" gap={2}>
      <text fg={theme.textMuted}>{props.label}</text>
      <text fg={theme.text} wrapMode="word">
        {props.value}
      </text>
    </box>
  )
}

function CredentialDetail(props: { item?: CredentialItem; scrollAcceleration: ScrollAcceleration }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  let _scroll: ScrollBoxRenderable | undefined

  return (
    <box flexGrow={1} minWidth={Math.max(48, Math.floor(dimensions().width * 0.35))} flexDirection="column">
      <box paddingLeft={2} paddingRight={2}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Details
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
      </box>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => (_scroll = value)}
        maxHeight={Math.floor(dimensions().height / 2) + 2}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        scrollbarOptions={{ visible: false }}
        scrollAcceleration={props.scrollAcceleration}
      >
        <Show when={props.item} fallback={<text fg={theme.textMuted}>Select a credential to inspect.</text>}>
          {(item) => (
            <box flexDirection="column" gap={1}>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                {item().value.title}
              </text>
              <text fg={theme.textMuted}>{item().value.section}</text>
              <DetailRow label="Status" value={rowStatus(item())} />
              <Switch>
                <Match when={item().type === "provider"}>
                  <ProviderDetail item={item() as Extract<CredentialItem, { type: "provider" }>} />
                </Match>
                <Match when={item().type === "mcp"}>
                  <McpDetail item={item() as Extract<CredentialItem, { type: "mcp" }>} />
                </Match>
              </Switch>
            </box>
          )}
        </Show>
      </scrollbox>
    </box>
  )
}

function DialogCredentialInspect(props: { items: CredentialItem[]; initial: CredentialItem }) {
  const tuiConfig = useTuiConfig()
  const [selected, setSelected] = createSignal(props.initial)
  const index = createMemo(() => props.items.findIndex((item) => JSON.stringify(item) === JSON.stringify(selected())))

  useKeyboard((evt) => {
    if (evt.name !== "left" && evt.name !== "right") return
    evt.preventDefault()
    evt.stopPropagation()
    const current = index()
    if (current === -1 || props.items.length === 0) return
    const direction = evt.name === "left" ? -1 : 1
    setSelected(props.items[(current + direction + props.items.length) % props.items.length])
  })

  return <CredentialDetail item={selected()} scrollAcceleration={getScrollAcceleration(tuiConfig)} />
}

function ProviderDetail(props: { item: Extract<CredentialItem, { type: "provider" }> }) {
  const value = props.item.value
  const auth = value.auth
  return (
    <box flexDirection="column" gap={1}>
      <DetailRow label="Provider ID" value={value.providerID} />
      <DetailRow label="Source" value={value.kind === "env" ? "Environment variables" : "Stored credential"} />
      <Show when={value.envVars?.length}>
        <DetailRow label="Env vars" value={(value.envVars ?? []).join(", ")} />
      </Show>
      <Switch>
        <Match when={auth?.type === "api"}>
          <DetailRow label="Auth type" value="API key" />
          <DetailRow label="Secret" value={maskSecret((auth as Extract<Auth.Info, { type: "api" }>).key)} />
          <Show when={auth?.type === "api" && auth.metadata && Object.keys(auth.metadata).length > 0}>
            <DetailRow label="Metadata" value={Object.entries((auth as Extract<Auth.Info, { type: "api" }>).metadata ?? {}).map(([key, val]) => `${key}: ${val}`).join(" | ")} />
          </Show>
        </Match>
        <Match when={auth?.type === "oauth"}>
          <DetailRow label="Auth type" value="OAuth" />
          <DetailRow label="Access token" value={maskSecret((auth as Extract<Auth.Info, { type: "oauth" }>).access)} />
          <DetailRow label="Refresh token" value={maskSecret((auth as Extract<Auth.Info, { type: "oauth" }>).refresh)} />
          <DetailRow label="Expires" value={formatDate((auth as Extract<Auth.Info, { type: "oauth" }>).expires)} />
          <Show when={auth?.type === "oauth" && auth.accountId}>
            <DetailRow label="Account" value={(auth as Extract<Auth.Info, { type: "oauth" }>).accountId!} />
          </Show>
          <Show when={auth?.type === "oauth" && auth.enterpriseUrl}>
            <DetailRow label="Enterprise URL" value={(auth as Extract<Auth.Info, { type: "oauth" }>).enterpriseUrl!} />
          </Show>
        </Match>
        <Match when={auth?.type === "wellknown"}>
          <DetailRow label="Auth type" value="External provider" />
          <DetailRow label="Env key" value={(auth as Extract<Auth.Info, { type: "wellknown" }>).key} />
          <DetailRow label="Token" value={maskSecret((auth as Extract<Auth.Info, { type: "wellknown" }>).token)} />
        </Match>
      </Switch>
    </box>
  )
}

function McpDetail(props: { item: Extract<CredentialItem, { type: "mcp" }> }) {
  const value = props.item.value
  const expires = value.entry.tokens?.expiresAt ? new Date(value.entry.tokens.expiresAt * 1000).toLocaleString() : undefined
  return (
    <box flexDirection="column" gap={1}>
      <DetailRow label="Server" value={value.name} />
      <Show when={value.status}>
        <DetailRow label="Runtime" value={titleCase(value.status ?? "stored")} />
      </Show>
      <Show when={value.entry.serverUrl}>
        <DetailRow label="Server URL" value={value.entry.serverUrl!} />
      </Show>
      <Show when={value.entry.tokens}>
        <DetailRow label="Access token" value={maskSecret(value.entry.tokens!.accessToken)} />
        <Show when={value.entry.tokens?.refreshToken}>
          <DetailRow label="Refresh token" value={maskSecret(value.entry.tokens!.refreshToken!)} />
        </Show>
        <Show when={expires}>
          <DetailRow label="Expires" value={expires!} />
        </Show>
        <Show when={value.entry.tokens?.scope}>
          <DetailRow label="Scope" value={value.entry.tokens!.scope!} />
        </Show>
      </Show>
      <Show when={value.entry.clientInfo}>
        <DetailRow label="Client ID" value={value.entry.clientInfo!.clientId} />
        <Show when={value.entry.clientInfo?.clientSecret}>
          <DetailRow label="Client secret" value={maskSecret(value.entry.clientInfo!.clientSecret!)} />
        </Show>
      </Show>
      <Show when={value.entry.codeVerifier}>
        <DetailRow label="PKCE verifier" value={maskSecret(value.entry.codeVerifier!)} />
      </Show>
      <Show when={value.entry.oauthState}>
        <DetailRow label="OAuth state" value={maskSecret(value.entry.oauthState!)} />
      </Show>
    </box>
  )
}
