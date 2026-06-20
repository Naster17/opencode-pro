import type { APIEvent } from "@solidjs/start/server"
import { ZenData } from "@opencode-ai/console-core/model.js"
import { and, Database, eq, isNotNull, isNull } from "@opencode-ai/console-core/drizzle/index.js"
import { KeyTable } from "@opencode-ai/console-core/schema/key.sql.js"
import { WorkspaceTable } from "@opencode-ai/console-core/schema/workspace.sql.js"
import { ModelTable } from "@opencode-ai/console-core/schema/model.sql.js"
import { BillingTable, SubscriptionTable } from "@opencode-ai/console-core/schema/billing.sql.js"
import { ProviderTable } from "@opencode-ai/console-core/schema/provider.sql.js"
import { buildOptionsResponse, buildModelsResponse } from "~/routes/zen/util/modelsHandler"

export async function OPTIONS(_input: APIEvent) {
  return buildOptionsResponse()
}

export async function GET(input: APIEvent) {
  const zenData = ZenData.list("full")
  const apiKey = input.request.headers.get("authorization")?.split(" ")[1]
  const auth = await getAuthInfo(apiKey)
  if (auth === "invalid") return new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 })

  const models = Object.entries(zenData.models)
    .filter(([id, model]) => !auth?.disabledModels.includes(id))
    .filter(([_, model]) => isModelAvailable(model, auth))
    .map(([id]) => id)

  return buildModelsResponse(models, {
    "X-OpenCode-Model-Scope": auth?.hasFullAccess ? "full" : "free",
  })
}

type ZenModel = ReturnType<typeof ZenData.list>["models"][string]
type AuthInfo = Awaited<ReturnType<typeof getAuthInfo>>

function isModelAvailable(model: ZenModel, auth: Exclude<AuthInfo, "invalid">) {
  const models = Array.isArray(model) ? model : [model]
  return models.some((item) => {
    if (item.trialEnded) return false
    if (!auth) return item.allowAnonymous === true
    if (item.allowAnonymous === true) return true
    if (item.byokProvider && auth.byokProviders.includes(item.byokProvider)) return true
    return auth.hasFullAccess
  })
}

async function getAuthInfo(apiKey: string | undefined) {
  if (!apiKey || apiKey === "public") return

  const data = await Database.use((tx) =>
    tx
      .select({
        workspaceID: KeyTable.workspaceID,
        userID: KeyTable.userID,
        billing: {
          balance: BillingTable.balance,
          paymentMethodID: BillingTable.paymentMethodID,
          subscription: BillingTable.subscription,
        },
        black: {
          id: SubscriptionTable.id,
        },
      })
      .from(KeyTable)
      .innerJoin(WorkspaceTable, eq(WorkspaceTable.id, KeyTable.workspaceID))
      .innerJoin(BillingTable, eq(BillingTable.workspaceID, KeyTable.workspaceID))
      .leftJoin(
        SubscriptionTable,
        and(
          eq(SubscriptionTable.workspaceID, KeyTable.workspaceID),
          eq(SubscriptionTable.userID, KeyTable.userID),
          isNull(SubscriptionTable.timeDeleted),
        ),
      )
      .where(and(eq(KeyTable.key, apiKey), isNull(KeyTable.timeDeleted)))
      .then((rows) => rows[0]),
  )
  if (!data) return "invalid" as const

  const disabledModels = await Database.use((tx) =>
    tx
      .select({ model: ModelTable.model })
      .from(ModelTable)
      .where(and(eq(ModelTable.workspaceID, data.workspaceID), isNull(ModelTable.timeDeleted)))
      .then((rows) => rows.map((row) => row.model)),
  )

  const byokProviders = await Database.use((tx) =>
    tx
      .select({ provider: ProviderTable.provider })
      .from(ProviderTable)
      .where(and(eq(ProviderTable.workspaceID, data.workspaceID), isNotNull(ProviderTable.credentials)))
      .then((rows) => rows.map((row) => row.provider)),
  )

  return {
    disabledModels,
    byokProviders,
    hasFullAccess:
      (data.billing.subscription !== null && data.black?.id !== undefined && data.black.id !== null) ||
      data.billing.paymentMethodID !== null ||
      data.billing.balance > 0,
  }
}
