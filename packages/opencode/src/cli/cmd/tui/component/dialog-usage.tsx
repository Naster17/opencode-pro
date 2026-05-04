import { TextAttributes } from "@opentui/core"
import { Show, createMemo, createSignal, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useTheme } from "../context/theme"
import { formatAlignedRow, formatCompactTokens, money, summarizeUsage } from "../util/usage"

export function DialogUsage() {
  const sync = useSync()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [loading, setLoading] = createSignal(true)

  onMount(() => {
    void Promise.allSettled(sync.data.session.map((item) => sync.session.sync(item.id))).finally(() => setLoading(false))
  })

  const usage = createMemo(() =>
    summarizeUsage(
      sync.data.session.map((session) => ({
        messages: sync.data.message[session.id] ?? [],
        getParts: (messageID: string) => sync.data.part[messageID] ?? [],
      })),
      sync.data.provider,
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
      <Show when={loading()}>
        <text fg={theme.textMuted}>Loading sessions...</text>
      </Show>
      <text fg={theme.textMuted}>
        {formatCompactTokens(usage().context_tokens)} context tokens across {sync.data.session.length} sessions
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
      <text fg={theme.textMuted}>{money.format(usage().cost)} spent</text>
      <Show when={!loading() && sync.data.session.length === 0}>
        <text fg={theme.text}>No Sessions</text>
      </Show>
    </box>
  )
}
