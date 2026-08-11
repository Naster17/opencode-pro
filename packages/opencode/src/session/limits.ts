import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"

// Runtime, in-memory, per-session override. Resets when the server restarts.
const flags = new Map<SessionID, boolean>()

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly set: (sessionID: SessionID, enabled: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLimits") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const get = Effect.fn("SessionLimits.get")(function* (sessionID: SessionID) {
      return flags.get(sessionID) ?? false
    })

    const set = Effect.fn("SessionLimits.set")(function* (sessionID: SessionID, enabled: boolean) {
      if (enabled) flags.set(sessionID, true)
      else flags.delete(sessionID)
    })

    return Service.of({ get, set })
  }),
)

export const defaultLayer = layer

export * as SessionLimits from "./limits"
