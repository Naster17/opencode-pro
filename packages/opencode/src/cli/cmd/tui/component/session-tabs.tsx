import { RGBA, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useRoute, useRouteData } from "@tui/context/route"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useKV } from "@tui/context/kv"
import { Locale } from "@/util/locale"
import type { ColorGenerator } from "opentui-spinner"
import "opentui-spinner/solid"

const TAB_TITLE_MAX = 30
const TAB_TITLE_MIN_WIDTH = 14

const BOUNCE_FRAMES = 24
const BOUNCE_INTERVAL = 40
const bounceFrames = Array.from({ length: BOUNCE_FRAMES }, () => "•")

// Browser-style bouncing: a single dot rises and falls on a sine wave.
function createBounceColor(color: RGBA): ColorGenerator {
  return (frameIndex) => {
    const phase = (frameIndex / BOUNCE_FRAMES) % 1
    const height = Math.sin(phase * Math.PI)
    return RGBA.fromValues(color.r, color.g, color.b, 0.3 + 0.7 * height)
  }
}

function Bounce() {
  const { theme } = useTheme()
  const kv = useKV()
  return (
    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
      <spinner color={createBounceColor(theme.info)} frames={bounceFrames} interval={BOUNCE_INTERVAL} />
    </Show>
  )
}

export function SessionTabs() {
  const route = useRouteData("session")
  const local = useLocal()
  const sync = useSync()

  const pinned = createMemo(() => local.session.pinned())
  const current = createMemo(() => sync.session.get(route.sessionID))
  const transient = createMemo(() => {
    const session = current()
    if (!session) return undefined
    if (local.session.isFavorite(session.id)) return undefined
    return session
  })
  const visible = createMemo(() => pinned().length >= 2)

  const busy = (id: string) => sync.session.status(id) === "working"
  // Permission/question requests from a session's children (subagents) surface
  // on the parent's tab, mirroring how the session route aggregates them.
  const attention = (id: string) => {
    const ids = [id, ...sync.data.session.filter((item) => item.parentID === id).map((item) => item.id)]
    return ids.some((x) => (sync.data.permission[x]?.length ?? 0) > 0 || (sync.data.question[x]?.length ?? 0) > 0)
  }

  return (
    <Show when={visible()}>
      {/* floats above the chat column — same left inset as the chat window itself */}
      <box flexDirection="row" flexShrink={0} height={1} width="100%" paddingLeft={2} overflow="hidden">
        <For each={pinned()}>
          {(session) => (
            <Tab
              id={session.id}
              title={session.title}
              active={session.id === route.sessionID}
              busy={busy(session.id)}
              attention={attention(session.id)}
              onClose={() => local.session.removeFavorite(session.id)}
            />
          )}
        </For>
        <Show when={transient()}>
          {(session) => (
            <Tab
              id={session().id}
              title={session().title}
              active={true}
              busy={busy(session().id)}
              attention={attention(session().id)}
              transient
            />
          )}
        </Show>
      </box>
    </Show>
  )
}

function Tab(props: {
  id: string
  title: string
  active: boolean
  busy?: boolean
  attention?: boolean
  transient?: boolean
  onClose?: () => void
}) {
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const [hover, setHover] = createSignal<"body" | "close" | undefined>()

  const bg = createMemo(() => {
    if (props.transient) return theme.background
    if (props.active || hover() === "body") return theme.backgroundElement
    return theme.backgroundPanel
  })
  // The close key always sits on the darkest background, so a neighboring tab's
  // body color can never blend into it; hover only adds bold.
  const closeBg = () => theme.background
  const fg = createMemo(() => (props.active && !props.transient ? theme.text : theme.textMuted))
  const title = createMemo(() => Locale.truncate(props.title, TAB_TITLE_MAX))
  const minWidth = () => (props.onClose ? 8 : 5)
  // Natural (Chrome-style) width: tabs keep their full size until the row
  // overflows, then yoga's flexShrink compresses them proportionally so all
  // of them stay on screen.
  // body: 1 left pad + title + 1 right pad; the close key adds 3
  // (pad+glyph+pad). Width is computed WITHOUT the busy/attention marker, so
  // the tab's size never changes when a marker appears — instead the marker
  // borrows space from the title, which shifts right and clips at the tail.
  const width = createMemo(() => {
    const body = 1 + Math.max(title().length, TAB_TITLE_MIN_WIDTH) + 1
    return body + (props.onClose ? 3 : 0)
  })

  return (
    <box flexDirection="row" flexShrink={1} width={width()} minWidth={minWidth()} overflow="hidden">
      <box
        backgroundColor={bg()}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        justifyContent="flex-start"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        // gap only separates existing children: marker→title gets one cell,
        // and with no marker the title still sits flush against the left pad
        gap={1}
        onMouseOver={() => setHover("body")}
        onMouseOut={() => setHover(undefined)}
        onMouseUp={() => {
          if (props.active) return
          navigate({ type: "session", sessionID: props.id })
        }}
      >
        <Show when={props.attention}>
          <text fg={theme.error}>[!]</text>
        </Show>
        <Show when={!props.attention && props.busy}>
          <Bounce />
        </Show>
        <text
          fg={fg()}
          flexShrink={1}
          overflow="hidden"
          wrapMode="none"
          attributes={
            (props.active ? TextAttributes.BOLD : 0) | (props.transient ? TextAttributes.ITALIC : 0) || undefined
          }
        >
          {title()}
        </text>
      </box>
      <Show when={props.onClose}>
        <box
          backgroundColor={closeBg()}
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
          onMouseOver={() => setHover("close")}
          onMouseOut={() => setHover(undefined)}
          onMouseUp={() => props.onClose?.()}
        >
          <text fg={theme.error} attributes={hover() === "close" ? TextAttributes.BOLD : undefined}>
            ✕
          </text>
        </box>
      </Show>
    </box>
  )
}
