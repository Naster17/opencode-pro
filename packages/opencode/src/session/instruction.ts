import path from "path"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@opencode-ai/core/global"
import { Storage } from "@/storage/storage"
import type { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"

const FILES = [
  "AGENTS.md",
  ...(Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ? [] : ["CLAUDE.md"]),
  "CONTEXT.md", // deprecated
]

function extract(messages: MessageV2.WithParts[], compactedPartIDs?: Set<string>) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.tool !== "read" || part.state.status !== "completed") continue
      // Check if part is compacted (stable_prune mode uses storage, legacy mode uses part.state.time.compacted)
      if (compactedPartIDs?.has(part.id)) continue
      if (part.state.time.compacted) continue
      const loaded = part.state.metadata?.loaded
      if (!loaded || !Array.isArray(loaded)) continue
      for (const p of loaded) {
        if (typeof p === "string") paths.add(p)
      }
    }
  }
  return paths
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, AppFileSystem.Error>
  readonly system: () => Effect.Effect<string[], AppFileSystem.Error>
  readonly systemForSession: (sessionID: SessionID) => Effect.Effect<string[], AppFileSystem.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, AppFileSystem.Error>
  readonly resolve: (
    messages: MessageV2.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], AppFileSystem.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | Config.Service | Global.Service | HttpClient.HttpClient
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
          system: new Map<SessionID, string[]>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        for (const file of FILES) {
          const matches = yield* fs.findUp(file, ctx.directory, ctx.worktree)
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      return [
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
    })

    const systemForSession = Effect.fn("Instruction.systemForSession")(function* (sessionID: SessionID) {
      const s = yield* InstanceState.get(state)
      const cached = s.system.get(sessionID)
      if (cached) return [...cached]

      const storage = yield* Effect.serviceOption(Storage.Service)
      const key = ["session_instruction", sessionID]
      if (storage._tag === "Some") {
        const stored = yield* storage.value
          .read<string[]>(key)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (stored) {
          s.system.set(sessionID, stored)
          return [...stored]
        }
      }

      const loaded = yield* system()
      s.system.set(sessionID, loaded)
      if (storage._tag === "Some") yield* storage.value.write(key, loaded).pipe(Effect.ignore)
      return [...loaded]
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of FILES) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: MessageV2.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const stablePrune = (yield* cfg.get()).compaction?.stable_prune ?? true
      const storage = yield* Effect.serviceOption(Storage.Service)
      const compactedParts = new Set<string>()
      if (stablePrune && storage._tag === "Some") {
        const sessionIDs = new Set(messages.map((m) => m.info.sessionID).filter(Boolean))
        for (const sid of sessionIDs) {
          const stored = yield* storage.value
            .read<{ partIDs?: string[] }>(["compacted_tool_session", sid])
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (stored?.partIDs) {
            for (const id of stored.partIDs) compactedParts.add(id)
          }
        }
      }

      const already = extract(messages, compactedParts.size > 0 ? compactedParts : undefined)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      return results
    })

    return Service.of({ clear, systemPaths, system, systemForSession, find, resolve })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export const loaded = Effect.fn("Instruction.loaded")(function* (messages: MessageV2.WithParts[]) {
  const storage = yield* Effect.serviceOption(Storage.Service)
  const cfg = yield* Effect.serviceOption(Config.Service)
  const compactedParts = new Set<string>()
  
  // Load compacted part IDs from storage when stable_prune is enabled
  const stablePrune = cfg._tag === "Some" ? (yield* cfg.value.get()).compaction?.stable_prune ?? true : true
  
  if (stablePrune && storage._tag === "Some") {
    const sessionIDs = new Set(messages.map((m) => m.info.sessionID).filter(Boolean))
    for (const sid of sessionIDs) {
      const stored = yield* storage.value
        .read<{ partIDs?: string[] }>(["compacted_tool_session", sid])
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (stored?.partIDs) {
        for (const id of stored.partIDs) compactedParts.add(id)
      }
    }
  }
  
  return extract(messages, compactedParts.size > 0 ? compactedParts : undefined)
})

export * as Instruction from "./instruction"
