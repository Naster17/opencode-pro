import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"

export type BtwUsageTotals = {
  input: number
  output: number
  reasoning: number
  cache_read: number
  cache_write: number
  cost: number
  tools: number
}

const empty = (): BtwUsageTotals => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache_read: 0,
  cache_write: 0,
  cost: 0,
  tools: 0,
})

export const { use: useBtwUsage, provider: BtwUsageProvider } = createSimpleContext({
  name: "BtwUsage",
  init: () => {
    const [store, setStore] = createStore<Record<string, BtwUsageTotals>>({})
    const counted = new Set<string>()

    return {
      add(sessionID: string, response: { info: AssistantMessage; parts: Part[] }) {
        if (counted.has(response.info.id)) return
        counted.add(response.info.id)
        setStore(
          produce((draft) => {
            const current = draft[sessionID] ?? empty()
            draft[sessionID] = {
              input: current.input + response.info.tokens.input,
              output: current.output + response.info.tokens.output,
              reasoning: current.reasoning + response.info.tokens.reasoning,
              cache_read: current.cache_read + response.info.tokens.cache.read,
              cache_write: current.cache_write + response.info.tokens.cache.write,
              cost: current.cost + (response.info.cost ?? 0),
              tools: current.tools + response.parts.filter((part) => part.type === "tool").length,
            }
          }),
        )
      },
      get(sessionID: string) {
        return store[sessionID] ?? empty()
      },
      sum(sessionIDs: Iterable<string>) {
        return Array.from(sessionIDs).reduce((total, sessionID) => {
          const item = store[sessionID]
          if (!item) return total
          return {
            input: total.input + item.input,
            output: total.output + item.output,
            reasoning: total.reasoning + item.reasoning,
            cache_read: total.cache_read + item.cache_read,
            cache_write: total.cache_write + item.cache_write,
            cost: total.cost + item.cost,
            tools: total.tools + item.tools,
          }
        }, empty())
      },
    }
  },
})
