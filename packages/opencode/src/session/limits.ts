import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"

export interface Info {
  /** Fully disable auto-compaction and context limit enforcement for the session. */
  enabled: boolean
  /**
   * Suppress auto-compaction until the session reaches this many tokens.
   * At or above the threshold, normal overflow rules apply.
   */
  threshold?: number
}

// Runtime, in-memory, per-session override. Resets when the server restarts.
const flags = new Map<SessionID, Info>()

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly set: (input: {
    sessionID: SessionID
    enabled?: boolean
    threshold?: number | null
  }) => Effect.Effect<Info>
}

export const DEFAULT_INFO: Info = { enabled: false }

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLimits") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const get = Effect.fn("SessionLimits.get")(function* (sessionID: SessionID) {
      return flags.get(sessionID) ?? DEFAULT_INFO
    })

    const set = Effect.fn("SessionLimits.set")(function* (input: {
      sessionID: SessionID
      enabled?: boolean
      threshold?: number | null
    }) {
      if (input.enabled === true) {
        // Full disable wins over any threshold.
        flags.set(input.sessionID, { enabled: true })
        return { enabled: true }
      }

      if (input.threshold != null && input.threshold > 0) {
        flags.set(input.sessionID, { enabled: false, threshold: input.threshold })
        return { enabled: false, threshold: input.threshold }
      }

      // Explicit clear: enabled=false alone (or threshold=null/0) restores defaults.
      flags.delete(input.sessionID)
      return { enabled: false } satisfies Info
    })

    return Service.of({ get, set })
  }),
)

export const defaultLayer = layer

export * as SessionLimits from "./limits"
