export * as ConfigSubagentModels from "./subagent-models"

import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { ConfigModelID } from "./model-id"

export const Entry = Schema.Struct({
  provider: Schema.String.annotate({ description: "Provider ID, e.g. 'anthropic' or 'opencode'" }),
  model: ConfigModelID.annotate({
    description: "Model ID in the form accepted by the provider, e.g. 'claude-sonnet-4-5'",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Short hint shown to the main agent explaining when to pick this model",
  }),
}).annotate({ identifier: "SubagentModel" })

export const Info = Schema.Struct({
  entries: Schema.optional(Schema.mutable(Schema.Array(Entry))).annotate({
    description:
      "Allowlist of models the main agent can pick for subagent invocations. " +
      "If unset, all provider-listed models are available.",
  }),
})
  .annotate({ identifier: "SubagentModels" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>
