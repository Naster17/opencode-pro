import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
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
  const [overviewRange, setOverviewRange] = createSignal(0)
  const [sessionsRange, setSessionsRange] = createSignal(0)
  const [modelsRange, setModelsRange] = createSignal(0)
  const [sessionIndex, setSessionIndex] = createSignal(0)
  const [modelIndex, setModelIndex] = createSignal(0)
  const sessionData = createMemo(() => {
    const all = sync.data.session
    return all.map((session) => {
      // Find all descendants of this session
      const descendants: string[] = []
      const queue = [session.id]
      const visited = new Set<string>([session.id])
      while (queue.length > 0) {
        const parentID = queue.shift()!
        for (const s of all) {
          if (s.parentID === parentID && !visited.has(s.id)) {
            visited.add(s.id)
            descendants.push(s.id)
            queue.push(s.id)
          }
        }
      }

      const sessions = [
        {
          session,
          messages: sync.data.message[session.id] ?? [],
          getParts: (messageID: string) => sync.data.part[messageID] ?? [],
          additions: sync.data.session_diff[session.id]?.reduce((sum, item) => sum + item.additions, 0),
          deletions: sync.data.session_diff[session.id]?.reduce((sum, item) => sum + item.deletions, 0),
        },
        ...descendants.map((id) => ({
          session: all.find((s) => s.id === id),
          messages: sync.data.message[id] ?? [],
          getParts: (messageID: string) => sync.data.part[messageID] ?? [],
          additions: sync.data.session_diff[id]?.reduce((sum, item) => sum + item.additions, 0),
          deletions: sync.data.session_diff[id]?.reduce((sum, item) => sum + item.deletions, 0),
        })),
      ]

      return {
        session,
        sessions,
      }
    })
  })

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

  const overviewUsage = createMemo(() => {
    const allSessions = sessionData().flatMap((d) => d.sessions)
    return summarizeUsage(allSessions, sync.data.provider, { start: ranges[overviewRange()].start() })
  })
  const sessionsUsage = createMemo(() => {
    // For individual session list, we might want to show the aggregated metrics per root session
    const rootSessions = sessionData()
      .filter((d) => !d.session.parentID)
      .map((d) => summarizeUsage(d.sessions, sync.data.provider, { start: ranges[sessionsRange()].start() }))
    
    // This is tricky because summarizeUsage returns a single object.
    // The DialogUsage expects sessionsUsage().session_usage to be a list.
    // Let's just aggregate all for now to be safe.
    const allSessions = sessionData().flatMap((d) => d.sessions)
    return summarizeUsage(allSessions, sync.data.provider, { start: ranges[sessionsRange()].start() })
  })
  const modelsUsage = createMemo(() => {
    const allSessions = sessionData().flatMap((d) => d.sessions)
    return summarizeUsage(allSessions, sync.data.provider, { start: ranges[modelsRange()].start() })
  })

  const rows = createMemo(() => {
    const left = {
      total: `total ${formatCompactTokens(overviewUsage().tokens)}`,
      input: `in ${formatCompactTokens(overviewUsage().input)}`,
    }
    const width = Math.max(left.total.length, left.input.length) + 1
    return {
      first: formatAlignedRow(left.input, `out ${formatCompactTokens(overviewUsage().output)}`, width),
      second: formatAlignedRow(left.total, `cached ${formatCompactTokens(overviewUsage().cached)}`, width),
      third: formatAlignedRow(`tools ${overviewUsage().tools}`, `compact ${overviewUsage().compact}`, width),
    }
  })

  const spentRow = createMemo(() => {
    const left = `spent ${money.format(overviewUsage().cost)}`
    const right = `avg/session ${money.format(overviewUsage().avg_spent_per_session)}`
    return formatAlignedRow(left, right, Math.max(left.length, 18) + 1)
  })

  const listHeight = createMemo(() => Math.max(5, Math.min(10, Math.floor(term().height / 4))))
  const contentWidth = 58
  const sessions = createMemo(() => sessionsUsage().session_usage)
  const models = createMemo(() => modelsUsage().model_usage)
  const sessionSpentWidth = createMemo(() =>
    Math.max("spent".length, ...sessions().map((item) => money.format(item.cost).length)),
  )
  const sessionTokensWidth = createMemo(() =>
    Math.max("tokens".length, ...sessions().map((item) => formatCompactTokens(item.tokens).length)),
  )
  const sessionTitleWidth = createMemo(() =>
    Math.max(12, contentWidth - 1 - sessionSpentWidth() - 2 - sessionTokensWidth()),
  )
  const modelCallsWidth = createMemo(() => Math.max("calls".length, ...models().map((item) => `x${item.count}`.length)))
  const modelTokensWidth = createMemo(() =>
    Math.max("tokens".length, ...models().map((item) => formatCompactTokens(item.tokens).length)),
  )
  const modelSpentWidth = createMemo(() =>
    Math.max("spent".length, ...models().map((item) => money.format(item.cost).length)),
  )
  const modelTitleWidth = createMemo(() =>
    Math.max(12, contentWidth - 1 - modelCallsWidth() - 2 - modelTokensWidth() - 2 - modelSpentWidth()),
  )
  const visibleSessions = createMemo(() => visibleWindow(sessions(), sessionIndex(), listHeight()))
  const visibleModels = createMemo(() => visibleWindow(models(), modelIndex(), listHeight()))

  createEffect(() => {
    if (sessionIndex() < sessions().length) return
    setSessionIndex(Math.max(0, sessions().length - 1))
  })

  createEffect(() => {
    if (modelIndex() < models().length) return
    setModelIndex(Math.max(0, models().length - 1))
  })

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
        setOverviewRange((value) => (value + direction + ranges.length) % ranges.length)
        return
      }
      if (sections[section()] === "Sessions") {
        setSessionsRange((value) => (value + direction + ranges.length) % ranges.length)
        return
      }
      setModelsRange((value) => (value + direction + ranges.length) % ranges.length)
    }

    if (mode() === "content" && (evt.name === "up" || evt.name === "down")) {
      if (sections[section()] === "Sessions") {
        if (sessions().length === 0) return
        evt.preventDefault()
        evt.stopPropagation()
        setSessionIndex((value) => (value + (evt.name === "up" ? -1 : 1) + sessions().length) % sessions().length)
        return
      }
      if (sections[section()] !== "Models" || models().length === 0) return
      evt.preventDefault()
      evt.stopPropagation()
      setModelIndex((value) => (value + (evt.name === "up" ? -1 : 1) + models().length) % models().length)
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
              const active = overviewRange() === index
              const engaged = active && mode() === "content"
              const bg = active ? (engaged ? theme.primary : theme.accent) : theme.backgroundElement
              return (
                <box paddingLeft={1} paddingRight={1} backgroundColor={bg}>
                  <text fg={active ? selectedForeground(theme, bg) : theme.text}>{item.label}</text>
                </box>
              )
            })}
          </box>
          <text fg={theme.textMuted}>{`active ${formatUsageDuration(overviewUsage().duration)}`}</text>
          <text fg={theme.textMuted}>{`sessions ${overviewUsage().sessions}`}</text>
          <text wrapMode="none">
            <span style={{ fg: theme.textMuted }}>code </span>
            <span style={{ fg: theme.diffAdded }}>+{formatCompactTokens(overviewUsage().additions)}</span>
            <span style={{ fg: theme.textMuted }}> </span>
            <span style={{ fg: theme.diffRemoved }}>-{formatCompactTokens(overviewUsage().deletions)}</span>
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
          <Show when={overviewUsage().popular_models.length > 0}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Top Models
            </text>
            {overviewUsage().popular_models.map((item, index) => (
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
          <box flexDirection="row" gap={1} paddingBottom={1}>
            {ranges.map((item, index) => {
              const active = sessionsRange() === index
              const engaged = active && mode() === "content"
              const bg = active ? (engaged ? theme.primary : theme.accent) : theme.backgroundElement
              return (
                <box paddingLeft={1} paddingRight={1} backgroundColor={bg}>
                  <text fg={active ? selectedForeground(theme, bg) : theme.text}>{item.label}</text>
                </box>
              )
            })}
          </box>
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
                  <text
                    fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted}
                    wrapMode="none"
                  >
                    {left}
                  </text>
                </box>
                <box flexGrow={1} />
                <box width={sessionSpentWidth()}>
                  <text
                    fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted}
                    wrapMode="none"
                  >
                    {money.format(item.cost).padStart(sessionSpentWidth(), " ")}
                  </text>
                </box>
                <box width={2}>
                  <text
                    fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted}
                    wrapMode="none"
                  >
                    {"  "}
                  </text>
                </box>
                <box width={sessionTokensWidth()}>
                  <text
                    fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted}
                    wrapMode="none"
                  >
                    {formatCompactTokens(item.tokens).padStart(sessionTokensWidth(), " ")}
                  </text>
                </box>
              </box>
            )
          })}
          <Show when={sessions().length > 0}>
            <text
              fg={theme.textMuted}
            >{`${sessionIndex() + 1}/${sessions().length} · ${Locale.datetime(sessions()[sessionIndex()]?.updated ?? 0)}`}</text>
          </Show>
        </Show>
        <Show when={sections[section()] === "Models"}>
          <box flexDirection="row" gap={1} paddingBottom={1}>
            {ranges.map((item, index) => {
              const active = modelsRange() === index
              const engaged = active && mode() === "content"
              const bg = active ? (engaged ? theme.primary : theme.accent) : theme.backgroundElement
              return (
                <box paddingLeft={1} paddingRight={1} backgroundColor={bg}>
                  <text fg={active ? selectedForeground(theme, bg) : theme.text}>{item.label}</text>
                </box>
              )
            })}
          </box>
          <text fg={theme.textMuted}>Models ranked by usage count, then tokens and cost.</text>
          <box width="100%" flexDirection="row">
            <box width={modelTitleWidth()}>
              <text fg={theme.textMuted} wrapMode="none">
                model
              </text>
            </box>
            <box flexGrow={1} />
            <box width={modelCallsWidth()}>
              <text fg={theme.textMuted} wrapMode="none">
                {"calls".padStart(modelCallsWidth(), " ")}
              </text>
            </box>
            <box width={2}>
              <text fg={theme.textMuted} wrapMode="none">
                {"  "}
              </text>
            </box>
            <box width={modelTokensWidth()}>
              <text fg={theme.textMuted} wrapMode="none">
                {"tokens".padStart(modelTokensWidth(), " ")}
              </text>
            </box>
            <box width={2}>
              <text fg={theme.textMuted} wrapMode="none">
                {"  "}
              </text>
            </box>
            <box width={modelSpentWidth()}>
              <text fg={theme.textMuted} wrapMode="none">
                {"spent".padStart(modelSpentWidth(), " ")}
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
            return (
              <box backgroundColor={bg} width="100%" flexDirection="row">
                <box width={modelTitleWidth()}>
                  <text
                    fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted}
                    wrapMode="none"
                  >
                    {left}
                  </text>
                </box>
                <box flexGrow={1} />
                <box width={modelCallsWidth()}>
                  <text
                    fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted}
                    wrapMode="none"
                  >
                    {`x${item.count}`.padStart(modelCallsWidth(), " ")}
                  </text>
                </box>
                <box width={2}>
                  <text
                    fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted}
                    wrapMode="none"
                  >
                    {"  "}
                  </text>
                </box>
                <box width={modelTokensWidth()}>
                  <text
                    fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted}
                    wrapMode="none"
                  >
                    {formatCompactTokens(item.tokens).padStart(modelTokensWidth(), " ")}
                  </text>
                </box>
                <box width={2}>
                  <text
                    fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted}
                    wrapMode="none"
                  >
                    {"  "}
                  </text>
                </box>
                <box width={modelSpentWidth()}>
                  <text
                    fg={active && mode() === "content" ? selectedForeground(theme, bg) : theme.textMuted}
                    wrapMode="none"
                  >
                    {money.format(item.cost).padStart(modelSpentWidth(), " ")}
                  </text>
                </box>
              </box>
            )
          })}
          <Show when={models().length > 0}>
            <text
              fg={theme.textMuted}
            >{`${modelIndex() + 1}/${models().length} · ${models()[modelIndex()]?.providerID}/${models()[modelIndex()]?.modelID}`}</text>
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
              <span style={{ fg: theme.text }}>tab</span> range <span style={{ fg: theme.text }}>↑↓</span> list{" "}
              <span style={{ fg: theme.text }}>esc</span> back
            </>
          )}
        </text>
      </box>
    </box>
  )
}
