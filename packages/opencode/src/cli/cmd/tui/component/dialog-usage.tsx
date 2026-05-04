import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { selectedForeground, useTheme } from "../context/theme"
import { formatAlignedRow, formatCompactTokens, formatUsageDuration, money, summarizeUsage } from "../util/usage"
import { Locale } from "@/util/locale"

const ranges = [
  { label: "Today", start: () => new Date().setHours(0, 0, 0, 0) },
  { label: "7d", start: () => Date.now() - 7 * 24 * 60 * 60 * 1000 },
  { label: "30d", start: () => Date.now() - 30 * 24 * 60 * 60 * 1000 },
  { label: "All", start: () => undefined },
] as const

const sections = ["Overview", "Sessions", "Models"] as const

function visibleWindow<T>(items: readonly T[], selected: number, limit: number) {
  if (items.length <= limit) return { start: 0, items: items.slice() }
  const start = Math.max(0, Math.min(selected - Math.floor(limit / 2), items.length - limit))
  return {
    start,
    items: items.slice(start, start + limit),
  }
}

export function DialogUsage() {
  const sync = useSync()
  const dialog = useDialog()
  const { theme } = useTheme()
  const term = useTerminalDimensions()
  const [loading, setLoading] = createSignal(true)
  const [section, setSection] = createSignal(0)
  const [mode, setMode] = createSignal<"sections" | "content">("sections")
  const [range, setRange] = createSignal(0)
  const [sessionIndex, setSessionIndex] = createSignal(0)
  const [modelIndex, setModelIndex] = createSignal(0)

  onMount(() => {
    dialog.setSize("large")
    dialog.setBeforeClose((evt) => {
      if (evt.name !== "escape") return true
      if (mode() === "sections") return true
      setMode("sections")
      return false
    })
    void Promise.allSettled(sync.data.session.map((item) => sync.session.sync(item.id, { fullHistory: true }))).finally(
      () => setLoading(false),
    )
  })

  onCleanup(() => {
    dialog.setBeforeClose(undefined)
  })

  const usage = createMemo(() =>
    summarizeUsage(
      sync.data.session.map((session) => ({
        session,
        messages: sync.data.message[session.id] ?? [],
        getParts: (messageID: string) => sync.data.part[messageID] ?? [],
        additions: sync.data.session_diff[session.id]?.reduce((sum, item) => sum + item.additions, 0),
        deletions: sync.data.session_diff[session.id]?.reduce((sum, item) => sum + item.deletions, 0),
      })),
      sync.data.provider,
      { start: ranges[range()].start() },
    ),
  )

  const rows = createMemo(() => {
    const left = {
      total: `total ${formatCompactTokens(usage().tokens)}`,
      input: `in ${formatCompactTokens(usage().input)}`,
    }
    const width = Math.max(left.total.length, left.input.length) + 1
    return {
      first: formatAlignedRow(left.input, `out ${formatCompactTokens(usage().output)}`, width),
      second: formatAlignedRow(left.total, `cached ${formatCompactTokens(usage().cached)}`, width),
      third: formatAlignedRow(`tools ${usage().tools}`, `compact ${usage().compact}`, width),
    }
  })

  const spentRow = createMemo(() => {
    const left = `spent ${money.format(usage().cost)}`
    const right = `avg/session ${money.format(usage().avg_spent_per_session)}`
    return formatAlignedRow(left, right, Math.max(left.length, 18) + 1)
  })

  const listHeight = createMemo(() => Math.max(5, Math.min(10, Math.floor(term().height / 4))))
  const contentWidth = 58
  const sessions = createMemo(() => usage().session_usage)
  const models = createMemo(() => usage().model_usage)
  const sessionSpentWidth = createMemo(() =>
    Math.max("spent".length, ...sessions().map((item) => money.format(item.cost).length)),
  )
  const sessionTokensWidth = createMemo(() =>
    Math.max("tokens".length, ...sessions().map((item) => formatCompactTokens(item.tokens).length)),
  )
  const sessionTitleWidth = createMemo(() =>
    Math.max(12, contentWidth - 1 - sessionSpentWidth() - 2 - sessionTokensWidth()),
  )
  const modelRightWidth = createMemo(
    () =>
      Math.max(
        16,
        ...models().map((item) => `x${item.count}  ${formatCompactTokens(item.tokens)}  ${money.format(item.cost)}`.length),
      ),
  )
  const modelTitleWidth = createMemo(() => Math.max(12, contentWidth - 1 - modelRightWidth()))
  const visibleSessions = createMemo(() => visibleWindow(sessions(), sessionIndex(), listHeight()))
  const visibleModels = createMemo(() => visibleWindow(models(), modelIndex(), listHeight()))

  useKeyboard((evt) => {
    if (evt.name === "tab") {
      evt.preventDefault()
      evt.stopPropagation()
      const direction = evt.shift ? -1 : 1
      if (mode() === "sections") {
        setSection((value) => (value + direction + sections.length) % sections.length)
        return
      }
      if (sections[section()] === "Overview") {
        setRange((value) => (value + direction + ranges.length) % ranges.length)
        return
      }
      if (sections[section()] === "Sessions") {
        if (sessions().length === 0) return
        setSessionIndex((value) => (value + direction + sessions().length) % sessions().length)
        return
      }
      if (models().length === 0) return
      setModelIndex((value) => (value + direction + models().length) % models().length)
    }

    if (evt.name === "return" && mode() === "sections") {
      evt.preventDefault()
      evt.stopPropagation()
      setMode("content")
    }

    if (evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      if (mode() === "content") {
        setMode("sections")
        return
      }
      dialog.clear()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Usage
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box flexDirection="row" gap={1} paddingTop={1} paddingBottom={1}>
        {sections.map((item, index) => {
          const active = section() === index
          const engaged = active && mode() === "content"
          const bg = active ? (engaged ? theme.primary : theme.accent) : theme.backgroundElement
          return (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={bg}
              onMouseUp={() => {
                setSection(index)
                setMode("sections")
              }}
            >
              <text fg={active ? selectedForeground(theme, bg) : theme.text}>{item}</text>
            </box>
          )
        })}
      </box>
      <Show when={loading()}>
        <text fg={theme.textMuted}>Loading sessions...</text>
      </Show>
      <Show when={!loading() && sync.data.session.length === 0}>
        <text fg={theme.text}>No Sessions</text>
      </Show>
      <Show when={sync.data.session.length > 0}>
        <Show when={sections[section()] === "Overview"}>
          <box flexDirection="row" gap={1} paddingBottom={1}>
            {ranges.map((item, index) => {
              const active = range() === index
              const engaged = active && mode() === "content"
              const bg = active ? (engaged ? theme.primary : theme.accent) : theme.backgroundElement
              return (
                <box paddingLeft={1} paddingRight={1} backgroundColor={bg}>
                  <text fg={active ? selectedForeground(theme, bg) : theme.text}>{item.label}</text>
                </box>
              )
            })}
          </box>
          <text fg={theme.textMuted}>{`active ${formatUsageDuration(usage().duration)}`}</text>
          <text fg={theme.textMuted}>{`sessions ${usage().sessions}`}</text>
          <text wrapMode="none">
            <span style={{ fg: theme.textMuted }}>code </span>
            <span style={{ fg: theme.diffAdded }}>+{formatCompactTokens(usage().additions)}</span>
            <span style={{ fg: theme.textMuted }}> </span>
            <span style={{ fg: theme.diffRemoved }}>-{formatCompactTokens(usage().deletions)}</span>
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {rows().first}
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {rows().second}
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {rows().third}
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            {spentRow()}
          </text>
          <Show when={usage().popular_models.length > 0}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Top Models
            </text>
            {usage().popular_models.map((item, index) => (
              <box width="100%" flexDirection="row" justifyContent="space-between">
                <text wrapMode="none" fg={index === 0 ? theme.warning : index === 1 ? theme.info : theme.success}>
                  {`${index + 1}. ${item.name}`}
                </text>
                <text fg={theme.textMuted} flexShrink={0}>
                  {`x${item.count}`}
                </text>
              </box>
            ))}
          </Show>
        </Show>
        <Show when={sections[section()] === "Sessions"}>
          <text fg={theme.textMuted}>Top sessions by spend and tokens.</text>
          <box width="100%" flexDirection="row">
            <box width={sessionTitleWidth()}>
              <text fg={theme.textMuted} wrapMode="none">
                session
              </text>
            </box>
            <box flexGrow={1} />
            <box width={sessionSpentWidth()}>
              <text fg={theme.textMuted} wrapMode="none">
                {"spent".padStart(sessionSpentWidth(), " ")}
              </text>
            </box>
            <box width={2}>
              <text fg={theme.textMuted} wrapMode="none">
                {"  "}
              </text>
            </box>
            <box width={sessionTokensWidth()}>
              <text fg={theme.textMuted} wrapMode="none">
                {"tokens".padStart(sessionTokensWidth(), " ")}
              </text>
            </box>
          </box>
          <Show when={sessions().length === 0}>
            <text fg={theme.textMuted}>No sessions in this range.</text>
          </Show>
          {visibleSessions().items.map((item, index) => {
            const absolute = visibleSessions().start + index
            const active = sessionIndex() === absolute
            const bg = active && mode() === "content" ? theme.primary : undefined
            const left = Locale.truncate(`${absolute + 1}. ${item.title}`, sessionTitleWidth())
            return (
              <box backgroundColor={bg} width="100%" flexDirection="row">
                <box width={sessionTitleWidth()}>
                  <text fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted} wrapMode="none">
                    {left}
                  </text>
                </box>
                <box flexGrow={1} />
                <box width={sessionSpentWidth()}>
                  <text fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted} wrapMode="none">
                    {money.format(item.cost).padStart(sessionSpentWidth(), " ")}
                  </text>
                </box>
                <box width={2}>
                  <text fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted} wrapMode="none">
                    {"  "}
                  </text>
                </box>
                <box width={sessionTokensWidth()}>
                  <text fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted} wrapMode="none">
                    {formatCompactTokens(item.tokens).padStart(sessionTokensWidth(), " ")}
                  </text>
                </box>
              </box>
            )
          })}
          <Show when={sessions().length > 0}>
            <text fg={theme.textMuted}>{`${sessionIndex() + 1}/${sessions().length} · ${Locale.datetime(sessions()[sessionIndex()]?.updated ?? 0)}`}</text>
          </Show>
        </Show>
        <Show when={sections[section()] === "Models"}>
          <text fg={theme.textMuted}>Models ranked by usage count, then tokens and cost.</text>
          <box width="100%" flexDirection="row">
            <box width={modelTitleWidth()}>
              <text fg={theme.textMuted} wrapMode="none">
                model
              </text>
            </box>
            <box flexGrow={1} />
            <box width={modelRightWidth()}>
              <text fg={theme.textMuted} wrapMode="none">
                {"calls  tokens  spent".padStart(modelRightWidth(), " ")}
              </text>
            </box>
          </box>
          <Show when={models().length === 0}>
            <text fg={theme.textMuted}>No models in this range.</text>
          </Show>
          {visibleModels().items.map((item, index) => {
            const absolute = visibleModels().start + index
            const active = modelIndex() === absolute
            const bg = active && mode() === "content" ? theme.primary : undefined
            const left = Locale.truncate(`${absolute + 1}. ${item.name}`, modelTitleWidth())
            const right = `x${item.count}  ${formatCompactTokens(item.tokens)}  ${money.format(item.cost)}`.padStart(
              modelRightWidth(),
              " ",
            )
            return (
              <box backgroundColor={bg} width="100%" flexDirection="row">
                <box width={modelTitleWidth()}>
                  <text fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted} wrapMode="none">
                    {left}
                  </text>
                </box>
                <box flexGrow={1} />
                <box width={modelRightWidth()}>
                  <text fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted} wrapMode="none">
                    {right}
                  </text>
                </box>
              </box>
            )
          })}
          <Show when={models().length > 0}>
            <text fg={theme.textMuted}>{`${modelIndex() + 1}/${models().length} · ${models()[modelIndex()]?.providerID}/${models()[modelIndex()]?.modelID}`}</text>
          </Show>
        </Show>
      </Show>
      <box width="100%" justifyContent="flex-end" paddingTop={1}>
        <text fg={theme.textMuted}>
          {mode() === "sections" ? (
            <>
              <span style={{ fg: theme.text }}>tab</span> section <span style={{ fg: theme.text }}>enter</span> open
            </>
          ) : (
            <>
              <span style={{ fg: theme.text }}>tab</span> navigate <span style={{ fg: theme.text }}>esc</span> back
            </>
          )}
        </text>
      </box>
    </box>
  )
}
