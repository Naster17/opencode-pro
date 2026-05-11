import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Storage } from "@/storage/storage"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(SessionSummary.defaultLayer, Storage.defaultLayer))

it.instance("reads message diffs from stable-history storage", () =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const summary = yield* SessionSummary.Service
    const sessionID = SessionID.make("ses_summary")
    const messageID = MessageID.make("msg_summary")
    const stored = [
      {
        file: '"quoted path.ts"',
        patch: "patch body",
        additions: 2,
        deletions: 1,
      },
    ]

    yield* storage.write(["message_diff", sessionID, messageID], stored)

    expect(yield* summary.diff({ sessionID, messageID })).toStrictEqual([
      {
        ...stored[0],
        file: "quoted path.ts",
      },
    ])
  }),
)
