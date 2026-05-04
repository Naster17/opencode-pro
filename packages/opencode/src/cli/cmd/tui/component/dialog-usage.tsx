import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { Show, createMemo, createSignal, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useTheme } from "../context/theme"
import { formatAlignedRow, formatCompactTokens, formatUsageDuration, money, summarizeUsage } from "../util/usage"

const ranges = [
  { label: "Today", start: () => new Date().setHours(0, 0, 0, 0) },
  { label: "7d", start: () => Date.now() - 7 * 24 * 60 * 60 * 1000 },
  { label: "30d", start: () => Date.now() - 30 * 24 * 60 * 60 * 1000 },
  { label: "All", start: () => undefined },
] as const

export function DialogUsage() {
  const sync = useSync()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [loading, setLoading] = createSignal(true)
  const [range, setRange] = createSignal(0)

  onMount(() => {
    void Promise.allSettled(sync.data.session.map((item) => sync.session.sync(item.id, { fullHistory: true }))).finally(
      () => setLoading(false),
    )
  })

  useKeyboard((evt) => {
    if (evt.name !== "tab") return
    evt.preventDefault()
    evt.stopPropagation()
    const direction = evt.shift ? -1 : 1
    setRange((value) => (value + direction + ranges.length) % ranges.length)
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
      width,
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
        {ranges.map((item, index) => (
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={range() === index ? theme.accent : theme.backgroundElement}
            onMouseUp={() => setRange(index)}
          >
            <text fg={range() === index ? theme.background : theme.text}>{item.label}</text>
          </box>
        ))}
      </box>
      <Show when={loading()}>
        <text fg={theme.textMuted}>Loading sessions...</text>
      </Show>
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
      <Show when={!loading() && sync.data.session.length === 0}>
        <text fg={theme.text}>No Sessions</text>
      </Show>
      <box width="100%" justifyContent="flex-end" paddingTop={1}>
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.text }}>tab</span> range <span style={{ fg: theme.text }}>shift+tab</span> back
        </text>
      </box>
    </box>
  )
}
