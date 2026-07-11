import * as Tool from "./tool"
import DESCRIPTION from "./subagent_models.txt"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { Effect, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.subagent_models" })

export const Parameters = Schema.Struct({})

type Entry = {
  provider: ProviderID
  model: ModelID
  note?: string
}

export const SubagentModelsTool = Tool.define(
  "subagent_models",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const providers = yield* Provider.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, _ctx) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const configured = cfg.subagent_models?.entries ?? []

          const all = yield* providers.list()
          const byKey = new Map<string, Entry>()
          for (const provider of Object.values(all)) {
            for (const model of Object.values(provider.models)) {
              byKey.set(`${provider.id}/${model.id}`, {
                provider: provider.id,
                model: model.id,
                ...(model.name ? { note: model.name } : {}),
              })
            }
          }

          if (configured.length === 0) {
            return {
              title: "Available subagent models",
              metadata: { count: byKey.size, curated: false },
              output: renderList(byKey.values()),
            }
          }

          const filtered: Entry[] = []
          for (const item of configured) {
            const parsed = parseConfigured(item.model)
            const key = `${parsed.providerID}/${parsed.modelID}`
            const hit = byKey.get(key)
            if (!hit) {
              log.warn("subagent_models entry not found in provider list, dropping", { key })
              continue
            }
            filtered.push({
              provider: hit.provider,
              model: hit.model,
              ...(item.note ? { note: item.note } : hit.note ? { note: hit.note } : {}),
            })
          }

          return {
            title: "Available subagent models",
            metadata: { count: filtered.length, curated: true },
            output: renderList(filtered),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function parseConfigured(value: string): { providerID: ProviderID; modelID: ModelID } {
  const [providerID, ...rest] = value.split("/")
  return {
    providerID: ProviderID.make(providerID),
    modelID: ModelID.make(rest.join("/")),
  }
}

function renderList(entries: Iterable<Entry>) {
  const lines: string[] = []
  for (const entry of entries) {
    const head = `- ${entry.provider}/${entry.model}`
    lines.push(entry.note ? `${head} — ${entry.note}` : head)
  }
  if (lines.length === 0) return "No models available."
  return ["Available models (provider/model):", ...lines].join("\n")
}

export * as SubagentModels from "./subagent_models"
