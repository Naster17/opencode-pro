import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { uniqueBy } from "remeda"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { iife } from "@/util/iife"
import { useToast } from "../ui/toast"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { Filesystem } from "@/util/filesystem"
import { compareThinkingVariantOrder, normalizeThinkingLevel, THINKING_LEVELS, type ThinkingLevel, type ThinkingState } from "./thinking"

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

export const THINKING_DISPLAY_VARIANTS = new Set([
  "default",
  "off",
  "none",
  "disabled",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
])

function toggleThinkingState(value: boolean | undefined, variantName?: string): ThinkingState | undefined {
  if (value === undefined) return
  if (!value) return "off"
  return variantName === "thinking" ? "thinking" : "high"
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    const agent = iife(() => {
      const agents = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((x) => !x.hidden))
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const { theme } = useTheme()
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents().at(0)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    })

    const model = iife(() => {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const filePath = path.join(Global.Path.state, "model.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void Filesystem.writeJson(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
        })
      }

      Filesystem.readJson(filePath)
        .then((x: any) => {
          if (Array.isArray(x.recent)) setModelStore("recent", x.recent)
          if (Array.isArray(x.favorite)) setModelStore("favorite", x.favorite)
          if (typeof x.variant === "object" && x.variant !== null) setModelStore("variant", x.variant)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const args = useArgs()
      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        return (
          getFirstValidModel(
            () => a && modelStore.model[a.name],
            () => a && a.model,
            fallbackModel,
          ) ?? undefined
        )
      })
      const modelInfo = createMemo(() => {
        const value = currentModel()
        if (!value) return
        const provider = sync.data.provider.find((x) => x.id === value.providerID)
        return provider?.models[value.modelID]
      })
      const variantList = () => {
        const info = modelInfo()
        if (!info?.variants) return []
        return Object.entries(info.variants)
      }
      const thinkingState = (options: Record<string, any> | undefined, variantName?: string): ThinkingState => {
        if (!options) return "inherit"
        if (variantName === "thinking") return "thinking"
        if (variantName === "none") return "off"
        const direct =
          normalizeThinkingLevel(options.reasoningEffort) ??
          normalizeThinkingLevel(options.chat_template_kwargs?.reasoning_effort) ??
          normalizeThinkingLevel(options.chat_template_args?.reasoning_effort) ??
          normalizeThinkingLevel(options.chatTemplateArgs?.reasoning_effort) ??
          normalizeThinkingLevel(options.reasoning?.effort) ??
          normalizeThinkingLevel(options.reasoningConfig?.maxReasoningEffort) ??
          normalizeThinkingLevel(options.thinkingConfig?.thinkingLevel) ??
          normalizeThinkingLevel(options.thinkingLevel) ??
          normalizeThinkingLevel(options.effort)
        if (direct) return direct
        if (options.thinking_budget_tokens === 0) return "off"
        const toggle =
          toggleThinkingState(options.enable_thinking, variantName) ??
          toggleThinkingState(options.chat_template_kwargs?.enable_thinking, variantName) ??
          toggleThinkingState(options.chat_template_args?.enable_thinking, variantName) ??
          toggleThinkingState(options.chatTemplateArgs?.enable_thinking, variantName)
        if (toggle) return toggle
        if (options.thinking?.type === "disabled") return "off"
        if (["enabled", "adaptive"].includes(options.thinking?.type)) return "high"
        if (options.reasoningConfig?.type === "disabled") return "off"
        if (["enabled", "adaptive"].includes(options.reasoningConfig?.type)) return "high"
        if (options.thinkingConfig?.thinkingBudget === 0) return "off"
        if (options.thinkingConfig?.includeThoughts) return "high"
        return "inherit"
      }
      const resolveThinking = () => {
        const info = modelInfo()
        if (!info?.capabilities.reasoning) return
        const current = model.variant.current()
        const variants = variantList().map(([name, options]) => ({
          name,
          level: thinkingState(options, name),
        }))
        const variantMap = Object.fromEntries(variants.map((item) => [item.name, item])) as Record<
          string,
          (typeof variants)[number] | undefined
        >
        const baseLevel = thinkingState(info.options)
        const findLevel = (level: ThinkingLevel) =>
          variants.find((item) => item.level === level)?.level as ThinkingLevel | undefined
        const hasThinkingToggle = variants.some((item) => item.level === "thinking")
        const defaultLevel: ThinkingLevel =
          findLevel("off") ??
          findLevel("low") ??
          findLevel("medium") ??
          findLevel("high") ??
          findLevel("xhigh") ??
          findLevel("max") ??
          "off"
        const currentVariant = current ? variantMap[current] : undefined
        const currentLevel =
          !currentVariant || currentVariant.level === "inherit"
            ? undefined
            : currentVariant.level === "thinking"
              ? "high"
              : currentVariant.level
        const activeLevel: ThinkingLevel =
          currentLevel ?? (baseLevel === "inherit" ? defaultLevel : baseLevel === "thinking" ? "high" : baseLevel)
        const levelVariant = Object.fromEntries(
          THINKING_LEVELS.map((level) => [level, variants.find((item) => item.level === level)?.name]),
        ) as Record<ThinkingLevel, string | undefined>
        if (!levelVariant.high && hasThinkingToggle) {
          levelVariant.high = variants.find((item) => item.level === "thinking")?.name
        }
        const levels: ThinkingLevel[] = THINKING_LEVELS.filter((level) => {
          if (levelVariant[level]) return true
          if (baseLevel === level) return true
          return baseLevel === "inherit" && defaultLevel === level
        })
        const cycleVariants = variantList()
          .filter(([name]) => {
            const level = variantMap[name]?.level
            if (name === "none" && activeLevel === "off") return false
            if (level === "off" && baseLevel === "inherit" && defaultLevel === "off" && activeLevel === "off")
              return false
            return true
          })
          .map(([name]) => name)
        return {
          activeLevel,
          baseLevel,
          defaultLevel,
          hasThinkingToggle,
          levelVariant,
          levels,
          cycleVariants,
        }
      }
      const thinkingModes = (): Array<ThinkingLevel | "thinking"> => {
        const thinking = resolveThinking()
        if (!thinking) return []
        if (thinking.hasThinkingToggle && thinking.levelVariant.high === "thinking") {
          return ["off", "thinking"]
        }
        return THINKING_LEVELS.filter((level) => {
          if (level === "off") {
            return Boolean(thinking.levelVariant.off || thinking.baseLevel === "off" || thinking.defaultLevel === "off")
          }
          return Boolean(thinking.levelVariant[level] || thinking.levels.includes(level))
        })
      }
      const defaultVariantTitle = () => {
        const thinking = resolveThinking()
        if (!thinking) return "default"
        if (thinking.baseLevel !== "inherit") return thinking.baseLevel
        return "default"
      }
      const cycleVariantList = () => {
        const thinking = resolveThinking()
        if (!thinking) return variantList().map(([name]) => name)
        if (thinking.cycleVariants.length) return thinking.cycleVariants
        return variantList()
          .filter(([name, options]) => thinkingState(options, name) !== thinking.baseLevel)
          .map(([name]) => name)
      }
      const isThinkingOnlyVariantModel = () => {
        const variants = variantList()
        if (variants.length === 0) return false
        return variants.every(([name, options]) => thinkingState(options, name) !== "inherit")
      }
      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((x) => x.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          toast.show({ message: `Cycling favorite model...`, variant: "info", duration: 2000 })
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...next })
          const uniq = uniqueBy([next, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
          if (uniq.length > 10) uniq.pop()
          setModelStore(
            "recent",
            uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
          )
          save()
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const a = agent.current()
            if (!a) return
            setModelStore("model", a.name, model)
            if (options?.recent) {
              const uniq = uniqueBy([model, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
              if (uniq.length > 10) uniq.pop()
              setModelStore(
                "recent",
                uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
              )
              save()
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          options() {
            const variants = variantList().map(([name], index) => ({
              value: name,
              title: name,
              index,
            }))
            return [
              {
                value: "default",
                title: defaultVariantTitle(),
              },
              ...variants.toSorted((left, right) => compareThinkingVariantOrder(left.value, right.value) || left.index - right.index),
            ]
          },
          selected() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          current() {
            const v = this.selected()
            if (!v) return undefined
            if (!this.list().includes(v)) return undefined
            return v
          },
          list() {
            return variantList().map(([name]) => name)
          },
          display() {
            const current = this.current()
            if (current) {
              return this.options().find((item) => item.value === current)?.title ?? current
            }
            if (this.selected() === "default") return defaultVariantTitle()
            return undefined
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value ?? "default")
            save()
          },
          cycle() {
            const current = this.current()
            const thinking = resolveThinking()
            if (thinking && isThinkingOnlyVariantModel()) {
              this.cycleThinking()
              return
            }
            const variants = cycleVariantList()
            if (variants.length === 0) return
            if (thinking?.hasThinkingToggle && thinking.levelVariant.high === "thinking") {
              this.set(current === "thinking" ? undefined : "thinking")
              return
            }
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1) {
              this.set(variants[0])
              return
            }
            if (index < variants.length - 1) {
              this.set(variants[index + 1])
              return
            }
            if (!thinking) {
              this.set(variants[0])
              return
            }
            const offVariant = thinking.levelVariant.off
            if (offVariant && variants.includes(offVariant)) {
              this.set(offVariant)
              return
            }
            this.set(undefined)
          },
          thinking() {
            const thinking = resolveThinking()
            if (!thinking) return "off"
            if (thinking.hasThinkingToggle && thinking.levelVariant.high === "thinking") {
              if (thinking.activeLevel === "off") return "off"
              return "thinking"
            }
            return thinking.activeLevel
          },
          supportsThinking() {
            return thinkingModes().length > 1
          },
          cycleThinking() {
            const modes = thinkingModes()
            if (modes.length === 0) {
              toast.show({
                variant: "info",
                message: "Current model does not support thinking mode",
                duration: 3000,
              })
              return
            }
            const current = this.thinking()
            const index = modes.indexOf(current)
            const next = modes[(index + 1) % modes.length] ?? modes[0]
            this.setThinking(next)
          },
          setThinking(level: ThinkingLevel | "thinking") {
            const thinking = resolveThinking()
            if (!thinking) {
              toast.show({
                variant: "info",
                message: "Current model does not support thinking mode",
                duration: 3000,
              })
              return
            }
            if (thinking.baseLevel === level || (thinking.baseLevel === "inherit" && thinking.defaultLevel === level)) {
              this.set(undefined)
              return
            }
            if (level === "thinking") {
              const variant = thinking.levelVariant.high
              if (variant === "thinking") {
                this.set(variant)
                return
              }
            }
            const variant = level === "thinking" ? undefined : thinking.levelVariant[level]
            if (variant) {
              this.set(variant)
              return
            }
            toast.show({
              variant: "info",
              message: `Current model does not support ${level} thinking`,
              duration: 3000,
            })
          },
          toggleThinking() {
            const thinking = resolveThinking()
            if (!thinking) {
              toast.show({
                variant: "info",
                message: "Current model does not support thinking mode",
                duration: 3000,
              })
              return
            }
            if (thinking.activeLevel === "off") {
              const next = thinkingModes().find((level) => level !== "off")
              if (next) {
                this.setThinking(next)
                return
              }
              toast.show({
                variant: "info",
                message: "Current model only supports thinking off",
                duration: 3000,
              })
              return
            }
            this.setThinking("off")
          },
        },
      }
    })

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid(value.model)) return
      toast.show({
        variant: "warning",
        message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
        duration: 3000,
      })
    })

    const result = {
      model,
      agent,
      mcp,
    }
    return result
  },
})
