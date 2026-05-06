import type { Model as ProviderModel, Provider as ProviderInfo } from "@opencode-ai/sdk/v2"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onMount, Show, type JSX } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { Keybind } from "@/util/keybind"
import { createDialogProviderOptions } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import { useKeybind } from "../context/keybind"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()
  const tab = Keybind.parse("tab").at(0)

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((x) => x.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect: () => {
              onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? "(Favorite)"
              : undefined,
            category: connected() ? provider.name : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect() {
              onSelect(provider.id, model)
            },
          })),
          filter((x) => {
            if (!showSections) return true
            if (favorites.some((item) => item.providerID === x.value.providerID && item.modelID === x.value.modelID))
              return false
            if (recents.some((item) => item.providerID === x.value.providerID && item.modelID === x.value.modelID))
              return false
            return true
          }),
          sortBy(
            (x) => x.footer !== "Free",
            (x) => x.title,
          ),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((x) => x.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  function openDetails(input: { providerID: string; modelID: string }) {
    dialog.replace(() => (
      <DialogModelDetails providerID={input.providerID} modelID={input.modelID} parentProviderID={props.providerID} />
    ))
  }

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      keybind={[
        {
          keybind: tab,
          title: "Details",
          onTrigger: (option) => {
            openDetails(option.value as { providerID: string; modelID: string })
          },
        },
        {
          keybind: keybind.all.model_favorite_toggle?.[0],
          title: "Favorite",
          disabled: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

function DialogModelDetails(props: { providerID: string; modelID: string; parentProviderID?: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const provider = createMemo(() => sync.data.provider.find((item) => item.id === props.providerID))
  const model = createMemo(() => provider()?.models[props.modelID])
  const height = createMemo(() => Math.max(12, dimensions().height - 12))

  function back() {
    dialog.replace(() => <DialogModel providerID={props.parentProviderID} />)
  }

  onMount(() => {
    dialog.setSize("xlarge")
    dialog.setBeforeClose(() => {
      back()
      return false
    })
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Model details
        </text>
        <text fg={theme.textMuted} onMouseUp={back}>
          esc
        </text>
      </box>
      <Show
        when={provider() && model()}
        fallback={<text fg={theme.error}>This model is no longer available in the current provider list.</text>}
      >
        <scrollbox paddingRight={1} scrollbarOptions={{ visible: false }} maxHeight={height()}>
          <ModelDetailsContent provider={provider()!} model={model()!} />
        </scrollbox>
      </Show>
      <text fg={theme.textMuted}>
        Press <span style={{ fg: theme.text }}>esc</span> to return to the model list.
      </text>
    </box>
  )
}

function ModelDetailsContent(props: { provider: ProviderInfo; model: ProviderModel }) {
  const { theme } = useTheme()
  const reasoningEfforts = createMemo(() => sortBy(Object.keys(props.model.variants ?? {}), (item) => item))
  const inputModalities = createMemo(() => enabledModalities(props.model.capabilities.input))
  const outputModalities = createMemo(() => enabledModalities(props.model.capabilities.output))

  return (
    <box gap={1}>
      <box gap={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.model.name}
        </text>
        <text fg={theme.textMuted}>
          {props.provider.name} <span style={{ fg: theme.accent }}>{props.provider.id}</span> / {props.model.id}
        </text>
        <box flexDirection="row" flexWrap="wrap" gap={1}>
          <DetailBadge label={props.model.status} color={statusColor(theme, props.model.status)} />
          <DetailBadge label={props.model.capabilities.reasoning ? "Reasoning" : "No reasoning"} color={theme.primary} />
          <DetailBadge label={props.model.capabilities.toolcall ? "Tool calling" : "No tools"} color={theme.success} />
          <DetailBadge label={props.model.capabilities.attachment ? "Attachments" : "Text only"} color={theme.warning} />
        </box>
      </box>

      <DetailSection title="Limits">
        <DetailRow label="Context window" value={formatNumber(props.model.limit.context)} />
        <DetailRow label="Max input" value={props.model.limit.input ? formatNumber(props.model.limit.input) : "Uses context window"} />
        <DetailRow label="Max output" value={formatNumber(props.model.limit.output)} />
        <DetailRow label="Reasoning efforts" value={reasoningEfforts().length > 0 ? reasoningEfforts().join(", ") : "Not exposed"} />
      </DetailSection>

      <DetailSection title="Capabilities">
        <DetailRow label="Temperature" value={yesNo(props.model.capabilities.temperature)} />
        <DetailRow label="Reasoning" value={yesNo(props.model.capabilities.reasoning)} />
        <DetailRow label="Tool calling" value={yesNo(props.model.capabilities.toolcall)} />
        <DetailRow label="Attachments" value={yesNo(props.model.capabilities.attachment)} />
        <DetailRow label="Interleaved output" value={formatInterleaved(props.model.capabilities.interleaved)} />
        <DetailRow label="Input modalities" value={inputModalities().join(", ")} />
        <DetailRow label="Output modalities" value={outputModalities().join(", ")} />
      </DetailSection>

      <DetailSection title="Pricing">
        <DetailRow label="Input" value={formatCost(props.model.cost.input)} />
        <DetailRow label="Output" value={formatCost(props.model.cost.output)} />
        <DetailRow label="Cache read" value={formatCost(props.model.cost.cache.read)} />
        <DetailRow label="Cache write" value={formatCost(props.model.cost.cache.write)} />
        <Show when={props.model.cost.experimentalOver200K}>
          <DetailRow label="200k+ input" value={formatCost(props.model.cost.experimentalOver200K!.input)} />
          <DetailRow label="200k+ output" value={formatCost(props.model.cost.experimentalOver200K!.output)} />
          <DetailRow label="200k+ cache read" value={formatCost(props.model.cost.experimentalOver200K!.cache.read)} />
          <DetailRow label="200k+ cache write" value={formatCost(props.model.cost.experimentalOver200K!.cache.write)} />
        </Show>
      </DetailSection>

      <DetailSection title="API">
        <DetailRow label="SDK package" value={props.model.api.npm} />
        <DetailRow label="Upstream model ID" value={props.model.api.id} />
        <DetailRow label="Base URL" value={props.model.api.url || "Not set"} />
        <DetailRow label="Provider source" value={props.provider.source} />
      </DetailSection>

      <DetailSection title="Extra metadata">
        <DetailRow label="Family" value={props.model.family ?? "Unknown"} />
        <DetailRow label="Release date" value={props.model.release_date || "Unknown"} />
        <DetailRow label="Variant keys" value={reasoningEfforts().length > 0 ? reasoningEfforts().join(", ") : "None"} />
        <DetailRow label="Headers" value={formatObjectEntries(props.model.headers)} />
        <DetailRow label="Options" value={formatObjectEntries(props.model.options)} />
      </DetailSection>
    </box>
  )
}

function DetailSection(props: { title: string; children: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <box gap={1}>
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      <box paddingLeft={1} gap={0}>
        {props.children}
      </box>
    </box>
  )
}

function DetailRow(props: { label: string; value: string }) {
  const { theme } = useTheme()
  return (
    <text fg={theme.textMuted} wrapMode="word">
      {props.label}: <span style={{ fg: theme.text }}>{props.value}</span>
    </text>
  )
}

function DetailBadge(props: { label: string; color: ReturnType<typeof useTheme>["theme"]["text"] }) {
  return (
    <text>
      <span style={{ fg: props.color, bold: true }}>[{props.label.toLowerCase()}]</span>
    </text>
  )
}

function enabledModalities(modalities: ProviderModel["capabilities"]["input"] | ProviderModel["capabilities"]["output"]) {
  const result = Object.entries(modalities)
    .filter((item) => item[1])
    .map((item) => item[0])
  return result.length > 0 ? result : ["none"]
}

function formatInterleaved(value: ProviderModel["capabilities"]["interleaved"]) {
  if (value === false) return "No"
  if (value === true) return "Yes"
  return `Yes (${value.field})`
}

function formatObjectEntries(value: Record<string, unknown> | Record<string, string>) {
  const entries = Object.entries(value)
  if (entries.length === 0) return "None"
  return entries.map(([key, item]) => `${key}=${formatUnknown(item)}`).join(", ")
}

function formatUnknown(value: unknown) {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value)
}

function formatCost(value: number) {
  if (value === 0) return "Free"
  return `$${trimNumber(value)} / 1M tokens`
}

function trimNumber(value: number) {
  return value.toFixed(value >= 10 ? 2 : value >= 1 ? 3 : 4).replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/g, "")
}

function yesNo(value: boolean) {
  return value ? "Yes" : "No"
}

function statusColor(theme: ReturnType<typeof useTheme>["theme"], status: ProviderModel["status"]) {
  if (status === "active") return theme.success
  if (status === "beta") return theme.warning
  if (status === "alpha") return theme.primary
  return theme.error
}
