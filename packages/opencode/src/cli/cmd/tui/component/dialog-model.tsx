import type { Model as ProviderModel, Provider as ProviderInfo } from "@opencode-ai/sdk/v2"
import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
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
import * as Model from "../util/model"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"

export function DialogModel(props: {
  providerID?: string
  initial?: { providerID: string; modelID: string }
  initialID?: string
  initialQuery?: string
}) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const [query, setQuery] = createSignal(props.initialQuery ?? "")

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
        if (!Model.selectable(model)) return []
        return [
          {
            id: `${category}:${provider.id}:${model.id}`,
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost.input === 0 && provider.id === "opencode" ? "Free" : undefined,
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
          filter(([_, info]) => Model.selectable(info)),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            id: `provider:${provider.id}:${model}`,
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? "(Favorite)"
              : undefined,
            category: connected() ? provider.name : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: info.cost.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            keywords: [info.api.id, info.family ?? ""].filter((item) => item.length > 0),
            onSelect() {
              onSelect(provider.id, model)
            },
          })),
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
        ...fuzzysort.go(needle, providerOptions, { keys: ["title", "category", "footer"] }).map((x) => x.obj),
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

  function openDetails(input: { providerID: string; modelID: string }, initialID?: string) {
    dialog.replace(() => (
      <DialogModelDetails
        providerID={input.providerID}
        modelID={input.modelID}
        parentProviderID={props.providerID}
        initialID={initialID}
        initialQuery={query()}
      />
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
            openDetails(option.value as { providerID: string; modelID: string }, option.id)
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
      initialFilter={props.initialQuery}
      initial={props.initial}
      initialID={props.initialID}
      current={local.model.current()}
    />
  )
}

function DialogModelDetails(props: {
  providerID: string
  modelID: string
  parentProviderID?: string
  initialID?: string
  initialQuery?: string
}) {
  const dialog = useDialog()
  const sync = useSync()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined

  const provider = createMemo(() => sync.data.provider.find((item) => item.id === props.providerID))
  const model = createMemo(() => provider()?.models[props.modelID])
  const height = createMemo(() => Math.max(12, dimensions().height - 12))
  const scrollStep = createMemo(() => Math.max(3, Math.floor(height() / 3)))
  const width = createMemo(() => {
    const currentProvider = provider()
    const currentModel = model()
    if (!currentProvider || !currentModel) return 68
    return modelDetailsWidth(currentProvider, currentModel)
  })

  function back() {
    dialog.replace(() => (
      <DialogModel
        providerID={props.parentProviderID}
        initial={{ providerID: props.providerID, modelID: props.modelID }}
        initialID={props.initialID}
        initialQuery={props.initialQuery}
      />
    ))
  }

  useKeyboard((evt) => {
    if (!scroll) return
    if (evt.name === "up") {
      scroll.scrollBy(-1)
      evt.preventDefault()
      evt.stopPropagation()
    }
    if (evt.name === "down") {
      scroll.scrollBy(1)
      evt.preventDefault()
      evt.stopPropagation()
    }
    if (evt.name === "pageup") {
      scroll.scrollBy(-scrollStep())
      evt.preventDefault()
      evt.stopPropagation()
    }
    if (evt.name === "pagedown") {
      scroll.scrollBy(scrollStep())
      evt.preventDefault()
      evt.stopPropagation()
    }
    if (evt.name === "home") {
      scroll.scrollTo(0)
      evt.preventDefault()
      evt.stopPropagation()
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    dialog.setWidth(width())
    dialog.setBeforeClose(() => {
      back()
      return false
    })
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={0}>
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
        <box paddingTop={1}>
          <scrollbox
            paddingRight={1}
            paddingBottom={1}
            maxHeight={height()}
            ref={(value: ScrollBoxRenderable) => {
              scroll = value
            }}
          >
            <ModelDetailsContent provider={provider()!} model={model()!} />
          </scrollbox>
        </box>
      </Show>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.text }}>↑↓</span> scroll <span style={{ fg: theme.text }}>esc</span> back
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
    <box gap={0}>
      <box gap={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.model.name}
        </text>
        <text fg={theme.textMuted}>
          {props.provider.name} <span style={{ fg: theme.accent }}>{props.provider.id}</span> / {props.model.id}
        </text>
        <box flexDirection="row" flexWrap="wrap" gap={1} paddingTop={1} paddingBottom={1}>
          <DetailBadge label={props.model.status} color={statusColor(theme, props.model.status)} />
          <DetailBadge
            label={props.model.capabilities.reasoning ? "Reasoning" : "No reasoning"}
            color={theme.primary}
          />
          <DetailBadge label={props.model.capabilities.toolcall ? "Tool calling" : "No tools"} color={theme.success} />
          <DetailBadge
            label={props.model.capabilities.attachment ? "Attachments" : "Text only"}
            color={theme.warning}
          />
        </box>
      </box>

      <DetailSection title="Limits">
        <DetailRow label="Context window" value={formatNumber(props.model.limit.context)} />
        <DetailRow
          label="Max input"
          value={props.model.limit.input ? formatNumber(props.model.limit.input) : "Uses context window"}
        />
        <DetailRow label="Max output" value={formatNumber(props.model.limit.output)} />
      </DetailSection>

      <DetailSection title="Capabilities">
        <DetailRow label="Temperature" value={yesNo(props.model.capabilities.temperature)} />
        <DetailRow label="Reasoning" value={yesNo(props.model.capabilities.reasoning)} />
        <DetailRow label="Tool calling" value={yesNo(props.model.capabilities.toolcall)} />
        <DetailRow label="Attachments" value={yesNo(props.model.capabilities.attachment)} />
        <DetailRow label="Interleaved" value={formatInterleaved(props.model.capabilities.interleaved)} />
        <DetailRow label="Input modalities" value={inputModalities().join(", ")} />
        <DetailRow label="Output modalities" value={outputModalities().join(", ")} />
      </DetailSection>

      <DetailSection title="Pricing">
        <DetailRow label="Input" value={formatCost(props.model.cost.input, "input")} />
        <DetailRow label="Output" value={formatCost(props.model.cost.output, "output")} />
        <DetailRow label="Cache read" value={formatCost(props.model.cost.cache.read, "cache read")} />
        <DetailRow label="Cache write" value={formatCost(props.model.cost.cache.write, "cache write")} />
        <Show when={props.model.cost.experimentalOver200K}>
          <DetailRow label="200k+ input" value={formatCost(props.model.cost.experimentalOver200K!.input, "input")} />
          <DetailRow label="200k+ output" value={formatCost(props.model.cost.experimentalOver200K!.output, "output")} />
          <DetailRow
            label="200k+ cache read"
            value={formatCost(props.model.cost.experimentalOver200K!.cache.read, "cache read")}
          />
          <DetailRow
            label="200k+ cache write"
            value={formatCost(props.model.cost.experimentalOver200K!.cache.write, "cache write")}
          />
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
        <DetailRow
          label="Variant keys"
          value={reasoningEfforts().length > 0 ? reasoningEfforts().join(", ") : "None"}
        />
        <DetailRow label="Headers" value={formatObjectEntries(props.model.headers)} />
        <DetailRow label="Options" value={formatObjectEntries(props.model.options)} />
      </DetailSection>
    </box>
  )
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

function enabledModalities(
  modalities: ProviderModel["capabilities"]["input"] | ProviderModel["capabilities"]["output"],
) {
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

function formatCost(value: number, unit: string) {
  if (value === 0) return "Free"
  return `$${trimNumber(value)} / 1M ${unit} tokens`
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

function modelDetailsWidth(provider: ProviderInfo, model: ProviderModel) {
  const lengths = [
    `Model details`.length,
    model.name.length,
    `${provider.name} ${provider.id} / ${model.id}`.length,
    `Context window: ${formatNumber(model.limit.context)}`.length,
    `Max input: ${model.limit.input ? formatNumber(model.limit.input) : "Uses context window"}`.length,
    `Max output: ${formatNumber(model.limit.output)}`.length,
    `Temperature: ${yesNo(model.capabilities.temperature)}`.length,
    `Reasoning: ${yesNo(model.capabilities.reasoning)}`.length,
    `Tool calling: ${yesNo(model.capabilities.toolcall)}`.length,
    `Attachments: ${yesNo(model.capabilities.attachment)}`.length,
    `Interleaved: ${formatInterleaved(model.capabilities.interleaved)}`.length,
    `Input modalities: ${enabledModalities(model.capabilities.input).join(", ")}`.length,
    `Output modalities: ${enabledModalities(model.capabilities.output).join(", ")}`.length,
    `Input: ${formatCost(model.cost.input, "input")}`.length,
    `Output: ${formatCost(model.cost.output, "output")}`.length,
    `Cache read: ${formatCost(model.cost.cache.read, "cache read")}`.length,
    `Cache write: ${formatCost(model.cost.cache.write, "cache write")}`.length,
    `SDK package: ${model.api.npm}`.length,
    `Upstream model ID: ${model.api.id}`.length,
    `Base URL: ${model.api.url || "Not set"}`.length,
    `Provider source: ${provider.source}`.length,
    `Family: ${model.family ?? "Unknown"}`.length,
    `Release date: ${model.release_date || "Unknown"}`.length,
    `Variant keys: ${sortBy(Object.keys(model.variants ?? {}), (item) => item).join(", ") || "None"}`.length,
    `Headers: ${formatObjectEntries(model.headers)}`.length,
    `Options: ${formatObjectEntries(model.options)}`.length,
  ].sort((a, b) => a - b)
  const target = lengths[Math.max(0, Math.floor(lengths.length * 0.8) - 1)] ?? 68
  return Math.max(60, Math.min(108, target + 10))
}
