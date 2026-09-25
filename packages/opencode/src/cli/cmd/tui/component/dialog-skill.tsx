import { Keybind } from "@/util/keybind"
import { Wildcard } from "@/util/wildcard"
import type { Agent, PermissionRuleset, Session } from "@opencode-ai/sdk/v2"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { useRoute } from "@tui/context/route"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useTheme } from "@tui/context/theme"
import { useToast } from "../ui/toast"
import { createEffect, createMemo, createResource, createSignal } from "solid-js"

type SkillItem = { name: string; description?: string; location?: string }
type ToolAction = "allow" | "deny"
type ToolStatus = "enabled" | "disabled"

const flipKey = Keybind.parse("space").at(0)
const allKey = Keybind.parse("ctrl+a").at(0)
const scopeKey = Keybind.parse("tab").at(0)

function normalize(permission: string) {
  return permission === "bash" ? "shell" : permission
}

function findRule(name: string, rulesets: PermissionRuleset[]) {
  return rulesets
    .flat()
    .findLast((rule) => Wildcard.match("skill", normalize(rule.permission)) && Wildcard.match(name, rule.pattern))
}

function skillStatus(name: string, rulesets: PermissionRuleset[]): ToolStatus {
  const match = findRule(name, rulesets)
  if (match?.action === "deny") return "disabled"
  return "enabled"
}

function allDisabled(rulesets: PermissionRuleset[]): boolean {
  const match = rulesets.flat().findLast((rule) => Wildcard.match("skill", normalize(rule.permission)))
  return match?.pattern === "*" && match.action === "deny"
}

function statusOf(action: ToolAction): ToolStatus {
  return action === "deny" ? "disabled" : "enabled"
}

function pill(theme: TuiThemeCurrent, action: ToolAction) {
  const color = action === "deny" ? theme.error : theme.success
  return <span style={{ fg: color }}>{statusOf(action)}</span>
}

function status(action: ToolAction) {
  return action === "deny" ? "disabled" : "enabled"
}

export function DialogSkill(props: { onSelect: (skill: string) => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const event = useEvent()
  const route = useRoute()
  const toast = useToast()
  const colors = useTheme().theme
  const size = useTerminalDimensions()
  dialog.setSize("large")

  const [cur, setCur] = createSignal<string | undefined>()
  const [lock, setLock] = createSignal(false)
  const [global, setGlobal] = createSignal(false)
  const [skills] = createResource(async () => {
    const result = await sdk.client.app.skills()
    return result.data ?? []
  })

  createEffect(() => {
    const width = size().width
    if (width >= 128) {
      dialog.setSize("xlarge")
      return
    }
    if (width >= 96) {
      dialog.setSize("large")
      return
    }
    dialog.setSize("medium")
  })

  useKeyboard((evt) => {
    if (evt.name !== "tab") return
    evt.preventDefault()
    evt.stopPropagation()
    if (lock()) return
    setGlobal((x) => !x)
  })

  const currentSession = () => {
    const data = route.data
    if (data.type !== "session") return
    return sync.data.session.find((item) => item.id === data.sessionID)
  }

  const currentAgent = (session: Session | undefined) => {
    const agents: Agent[] = sync.data.agent
    return (
      agents.find((item) => item.name === session?.agent) ?? agents.find((item) => item.name === "build") ?? agents[0]
    )
  }

  const rulesets = createMemo<PermissionRuleset[]>(() => {
    const session = currentSession()
    return [currentAgent(session)?.permission ?? [], session?.permission ?? []]
  })

  const sourceOf = (name: string) => {
    const session = currentSession()
    if (session && findRule(name, [session.permission ?? []])) return "session"
    const config = sync.data.config as { permission?: Record<string, unknown> } | undefined
    return config?.permission?.skill !== undefined ? "config" : "default"
  }

  function waitForDisposal(timeoutMs = 5000) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        off()
        resolve()
      }, timeoutMs)
      const off = event.on("server.instance.disposed", () => {
        clearTimeout(timer)
        off()
        resolve()
      })
    })
  }

  const persist = async (
    permission: Record<string, ToolAction | Record<string, ToolAction>>,
    target: ToolAction,
    name?: string,
  ) => {
    setLock(true)
    try {
      // Config-first write: the server disposes the instance on persist, so
      // the next prompt boots with fresh permissions. Session rules are only
      // appended to heal a detected conflict, never speculatively: they merge
      // last and would shadow later config flips.
      const disposed = waitForDisposal()
      const persisted = await sdk.client.config.permission.update({
        scope: global() ? "global" : "local",
        permission,
      })
      if (persisted.error) throw persisted.error
      await disposed
      await sync.bootstrap({ fatal: false })
      const pattern = name ?? "*"
      const session = currentSession()
      const conflict = session
        ? (() => {
            const match = findRule(pattern, [session.permission ?? []])
            return match !== undefined && match.action !== target
          })()
        : false
      if (conflict && session) {
        const healed = await sdk.client.session.update({
          sessionID: session.id,
          permission: [{ permission: "skill", pattern, action: target }],
        })
        if (healed.error) throw healed.error
        await sync.bootstrap({ fatal: false })
      }
      const rules = rulesets()
      const actual = name ? skillStatus(name, rules) : status(allDisabled(rules) ? "deny" : "allow")
      const scope = global() ? "global" : "local"
      const label = name ?? "All skills"
      if (actual === status(target)) {
        toast.show({
          variant: "success",
          message:
            target === "deny"
              ? `${label} disabled (${scope})${conflict ? ", session override healed" : ""}, removed from context in new prompts`
              : `${label} enabled (${scope})${conflict ? ", session override healed" : ""}, live in new prompts`,
        })
      } else {
        toast.show({
          variant: "warning",
          message: `${label} saved as ${status(target)} (${scope}), but this session still resolves ${actual} (session override)`,
        })
      }
    } catch (error) {
      toast.show({
        variant: "error",
        message: error instanceof Error ? error.message : `Failed to update skills`,
      })
    } finally {
      setLock(false)
    }
  }

  const flip = async (name: string) => {
    const target = skillStatus(name, rulesets()) === "disabled" ? "allow" : "deny"
    setCur(name)
    await persist({ skill: { [name]: target } }, target, name)
  }

  const flipAll = async () => {
    const target = allDisabled(rulesets()) ? "allow" : "deny"
    await persist({ skill: target }, target)
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list: SkillItem[] = skills() ?? []
    return list.map((skill) => {
      const action = skillStatus(skill.name, rulesets()) === "disabled" ? "deny" : "allow"
      return {
        title: skill.name,
        description: skill.description?.replace(/\s+/g, " ").trim(),
        value: skill.name,
        category: "Skills",
        footer: (
          <>
            {pill(colors, action)}
            <span style={{ fg: colors.textMuted }}> · {sourceOf(skill.name)}</span>
          </>
        ),
        onSelect: () => {
          props.onSelect(skill.name)
          dialog.clear()
        },
      }
    })
  })

  return (
    <DialogSelect
      title="Skills"
      placeholder="Search skills..."
      options={options()}
      current={cur()}
      footerLeft={
        <>
          <span style={{ fg: colors.text }}>{"↑↓"}</span> navigate
          <span style={{ fg: colors.textMuted }}>
            {" "}
            · scope: {global() ? "global" : "local"} ({Keybind.toString(scopeKey)} toggle) · disabled = removed from LLM
            context
          </span>
        </>
      }
      keybind={[
        {
          title: "toggle",
          keybind: flipKey,
          disabled: lock(),
          onTrigger: (item) => {
            void flip(item.value)
          },
        },
        {
          title: "all on/off",
          keybind: allKey,
          disabled: lock(),
          onTrigger: () => {
            void flipAll()
          },
        },
      ]}
    />
  )
}
