import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
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
// Space taken by the close key (pad + glyph + pad).
const TAB_CLOSE_WIDTH = 3

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

// Closing removes the tab from everywhere at once — a favorite gets unpinned
// too, so "close" always means "gone from the bar". After closing the active
// tab, focus moves to the previous one, Chrome-style; closing a background
// tab never steals focus.
export function useTabClose() {
  const local = useLocal()
  const route = useRouteData("session")
  const { navigate } = useRoute()
  return (id: string) => {
    const tabs = local.session.tabs()
    const index = tabs.findIndex((item) => item.id === id)
    if (local.session.isFavorite(id)) local.session.removeFavorite(id)
    local.session.removeActive(id)
    if (id !== route.sessionID) return
    const neighbor = tabs[index - 1] ?? tabs[index + 1]
    if (neighbor) navigate({ type: "session", sessionID: neighbor.id })
  }
}

export function SessionTabs() {
  const route = useRouteData("session")
  const local = useLocal()
  const sync = useSync()

  // Every visited session becomes a tab right away; so does any session that
  // starts working, even if opened elsewhere. Neither needs to be favorited —
  // favorites just survive restarts, the rest vanish when the app exits.
  // The effects keep their own session/session_status reads tracked so a
  // session created via /new (arriving in sync data a tick after navigation)
  // still triggers a retry; markActive reads everything untracked, so closing
  // a tab can never re-trigger these effects through its own writes.
  createEffect(() => {
    const id = route.sessionID
    if (!sync.data.session.some((item) => item.id === id)) return
    local.session.markActive(id)
  })
  createEffect(() => {
    const known = new Set(sync.data.session.map((item) => item.id))
    for (const [id, status] of Object.entries(sync.data.session_status)) {
      if (status.type === "busy" && known.has(id)) local.session.markActive(id)
    }
  })

  const tabs = createMemo(() => local.session.tabs())
  const visible = createMemo(() => tabs().length >= 2)

  const dimensions = useTerminalDimensions()
  const kv = useKV()
  // Width of the chat column the strip floats over: full terminal minus the
  // wide-mode sidebar (its narrow overlay variant doesn't steal column space)
  // and the strip's own left inset.
  const availableWidth = createMemo(() => {
    const wide = dimensions().width > 120
    const sidebar = kv.get("sidebar", "auto")
    const sidebarSpace = sidebar !== "hide" && wide ? 42 : 0
    return dimensions().width - sidebarSpace - 2
  })
  const naturalWidth = (title: string) =>
    2 + Math.max(TAB_TITLE_MIN_WIDTH, Math.min(title.length, TAB_TITLE_MAX)) + TAB_CLOSE_WIDTH
  // One shared width for every tab: the widest title's natural size, clamped
  // to the equal budget when the row overflows — tabs shrink together to fit.
  const tabWidth = createMemo(() =>
    Math.min(
      Math.max(TAB_TITLE_MIN_WIDTH + 5, ...tabs().map((item) => naturalWidth(item.title))),
      Math.max(8, Math.floor(availableWidth() / Math.max(1, tabs().length))),
    ),
  )

  const busy = (id: string) => sync.session.status(id) === "working"
  // Permission/question requests from a session's children (subagents) surface
  // on the parent's tab, mirroring how the session route aggregates them.
  const attention = (id: string) => {
    const ids = [id, ...sync.data.session.filter((item) => item.parentID === id).map((item) => item.id)]
    return ids.some((x) => (sync.data.permission[x]?.length ?? 0) > 0 || (sync.data.question[x]?.length ?? 0) > 0)
  }
  const closeTab = useTabClose()

  return (
    <Show when={visible()}>
      {/* floats above the chat column — same left inset as the chat window itself */}
      <box flexDirection="row" flexShrink={0} height={1} width="100%" paddingLeft={2} overflow="hidden">
        <For each={tabs()}>
          {(session) => {
            const pinned = () => local.session.isFavorite(session.id)
            return (
              <Tab
                id={session.id}
                title={session.title}
                width={tabWidth()}
                active={session.id === route.sessionID}
                busy={busy(session.id)}
                attention={attention(session.id)}
                transient={!pinned()}
                onClose={() => closeTab(session.id)}
              />
            )
          }}
        </For>
      </box>
    </Show>
  )
}

function Tab(props: {
  id: string
  title: string
  /** Natural size per-title; parent clamps it down when the row overflows. */
  width: number
  active: boolean
  busy?: boolean
  attention?: boolean
  transient?: boolean
  onClose?: () => void
}) {
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const [hover, setHover] = createSignal<"body" | "close" | undefined>()

  // Transient (unpinned) tabs stay ghosted only while inactive; the active one
  // highlights exactly like a pinned tab.
  const bg = createMemo(() => {
    if (props.active || hover() === "body") return theme.backgroundElement
    if (props.transient) return theme.background
    return theme.backgroundPanel
  })
  // The close key always sits on the darkest background, so a neighboring tab's
  // body color can never blend into it; hover only adds bold.
  const closeBg = () => theme.background
  const fg = createMemo(() => (props.active ? theme.text : theme.textMuted))
  const title = createMemo(() => Locale.truncate(props.title, TAB_TITLE_MAX))
  // Width comes from the parent: natural per-title size, pre-clamped to the
  // equal share when too many tabs are open. The marker still borrows space
  // from the title, so the outer size never changes when it appears.
  return (
    <box flexDirection="row" flexShrink={0} width={props.width} overflow="hidden">
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
