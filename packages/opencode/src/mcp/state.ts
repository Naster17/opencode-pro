import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer, Context } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

const filepath = path.join(Global.Path.data, "mcp-state.json")

export interface Interface {
  readonly all: () => Effect.Effect<Record<string, boolean>>
  readonly get: (name: string) => Effect.Effect<boolean | undefined>
  readonly set: (name: string, enabled: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const all = Effect.fn("McpState.all")(function* () {
      return yield* fs.readJson(filepath).pipe(
        Effect.map((data) => data as Record<string, boolean>),
        Effect.catch(() => Effect.succeed({} as Record<string, boolean>)),
      )
    })

    const get = Effect.fn("McpState.get")(function* (name: string) {
      const data = yield* all()
      return data[name]
    })

    const set = Effect.fn("McpState.set")(function* (name: string, enabled: boolean) {
      const data = yield* all()
      yield* fs.writeJson(filepath, { ...data, [name]: enabled }, 0o600).pipe(Effect.orDie)
    })

    return Service.of({
      all,
      get,
      set,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as McpState from "./state"
