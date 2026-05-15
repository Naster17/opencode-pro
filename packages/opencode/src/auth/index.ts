import path from "path"
import { Effect, Layer, Schema, Context } from "effect"
import { zod } from "@/util/effect-zod"
import { NonNegativeInt } from "@/util/schema"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")
const TRANSIENT_AUTH_RETRIES = 3
const TRANSIENT_AUTH_RETRY_DELAY = "50 millis"

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export const Info = Object.assign(_Info, { zod: zod(_Info) })
export type Info = Schema.Schema.Type<typeof _Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const decode = Schema.decodeUnknownOption(Info)
    let lastGood: Record<string, Info> = {}

    const decodeAuth = (data: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(data).flatMap(([key, value]) => {
          const decoded = decode(value)
          return decoded._tag === "Some" ? [[key, decoded.value] as const] : []
        }),
      )

    const readAuthFile = Effect.fn("Auth.readFile")(function* () {
      return (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => undefined))) as
        | Record<string, unknown>
        | undefined
    })

    const readDiskAuth = Effect.fn("Auth.readDisk")(function* () {
      for (let attempt = 0; attempt <= TRANSIENT_AUTH_RETRIES; attempt++) {
        const data = yield* readAuthFile()
        if (!data || typeof data !== "object") return lastGood

        const next = decodeAuth(data)
        if (Object.keys(data).length === 0 || Object.keys(next).length < Object.keys(data).length) {
          if (attempt < TRANSIENT_AUTH_RETRIES) {
            yield* Effect.sleep(TRANSIENT_AUTH_RETRY_DELAY)
            continue
          }
        }

        lastGood = next
        return next
      }
      return lastGood
    })

    const readEnvAuth = () => {
      try {
        const parsed = JSON.parse(process.env.OPENCODE_AUTH_CONTENT!)
        if (!parsed || typeof parsed !== "object") return lastGood
        const next = decodeAuth(parsed as Record<string, unknown>)
        lastGood = next
        return next
      } catch (err) {
        return lastGood
      }
    }

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        return readEnvAuth()
      }
      return yield* readDiskAuth()
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Auth from "."
