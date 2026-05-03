import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SyncEvent } from "@/sync"
import { Effect, Layer, Context } from "effect"
import * as ShareNext from "./share-next"

export interface Interface {
  readonly create: (input?: Session.CreateInput) => Effect.Effect<Session.Info>
  readonly share: (sessionID: SessionID) => Effect.Effect<{ url: string }, unknown>
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionShare") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareNext = yield* ShareNext.Service
    const sync = yield* SyncEvent.Service

    const share = Effect.fn("SessionShare.share")(function* (sessionID: SessionID) {
      void sessionID
      throw new Error("Sharing is permanently disabled")
    })

    const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
      yield* shareNext.remove(sessionID)
      yield* sync.run(Session.Event.Updated, { sessionID, info: { share: { url: null } } })
    })

    const create = Effect.fn("SessionShare.create")(function* (input?: Session.CreateInput) {
      const result = yield* session.create(input)
      return result
    })

    return Service.of({ create, share, unshare })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(ShareNext.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SyncEvent.defaultLayer),
)

export * as SessionShare from "./session"
