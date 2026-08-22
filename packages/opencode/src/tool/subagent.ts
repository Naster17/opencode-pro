import * as Tool from "./tool"
import DESCRIPTION from "./subagent.txt"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { Effect, Exit, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "subagent"

const description = Schema.String.annotate({ description: "A short (3-5 words) description of the task" })
const prompt = Schema.String.annotate({ description: "The task for the agent to perform" })
const agent_type = Schema.String.annotate({ description: "The type of specialized agent to use for this task" })
const model = Schema.optional(Schema.String).annotate({
  description:
    "The model the subagent should run on, in 'provider/model' form. " +
    "Pick from the list returned by the subagent_models tool. " +
    "Ignored when session_id is set (resumed sessions keep their original model).",
})
const session_id = Schema.optional(Schema.String).annotate({
  description: "Pass an existing subagent session id to resume that session instead of creating a fresh one",
})
const command = Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" })

export const Parameters = Schema.Struct({ description, prompt, agent_type, model, session_id, command })

// Non-boss agents (build, plan, ...) have no subagent_models tool, so the
// model argument is not exposed to them. The execute path still accepts it
// because it decodes against the full `Parameters` schema.
export const ParametersWithoutModel = Schema.Struct({ description, prompt, agent_type, session_id, command })

export const SubagentTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const providers = yield* Provider.Service
    const sessions = yield* Session.Service

    const resolveModel = Effect.fnUntraced(function* (
      requested: string | undefined,
      next: Agent.Info,
      parent: MessageV2.Assistant,
    ) {
      if (requested) {
        const parsed = Provider.parseModel(requested)
        const requestedHit = yield* providers.getModel(parsed.providerID, parsed.modelID).pipe(Effect.exit)
        if (Exit.isSuccess(requestedHit)) return parsed
      }

      if (next.model) {
        const agentHit = yield* providers.getModel(next.model.providerID, next.model.modelID).pipe(Effect.exit)
        if (Exit.isSuccess(agentHit)) return next.model
      }

      return {
        modelID: parent.modelID as ModelID,
        providerID: parent.providerID as ProviderID,
      }
    })

    const run = Effect.fn("SubagentTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.agent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            agent_type: params.agent_type,
            model: params.model,
          },
        })
      }

      const next = yield* agent.get(params.agent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.agent_type} is not a valid agent type`))
      }

      const canTask = next.permission.some((rule) => rule.permission === id)
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")
      const canSubagentModels = next.permission.some((rule) => rule.permission === "subagent_models")

      const sessionID = params.session_id
      const session = sessionID
        ? yield* sessions.get(SessionID.make(sessionID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [
            ...(parent.permission ?? []).filter(
              (rule) => rule.permission === "external_directory" || rule.action === "deny",
            ),
            ...(canTodo
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(canTask
              ? []
              : [
                  {
                    permission: id,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(canSubagentModels
              ? []
              : [
                  {
                    permission: "subagent_models" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const assistant = msg.info as MessageV2.Assistant

      const model = session
        ? { modelID: assistant.modelID, providerID: assistant.providerID }
        : yield* resolveModel(params.model, next, assistant)
      const variant = next.variant ?? assistant.variant

      yield* ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: nextSession.id,
          model,
          variant,
        },
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("SubagentTool requires promptOps in ctx.extra"))
      const runCancel = yield* EffectBridge.make()

      const messageID = MessageID.ascending()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const parts = yield* ops.resolvePromptParts(params.prompt)
            const result = yield* ops.prompt({
              messageID,
              sessionID: nextSession.id,
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              variant,
              agent: next.name,
              tools: {
                ...(canTodo ? {} : { todowrite: false }),
                ...(canTask ? {} : { [id]: false }),
                ...(next.mode === "subagent" ? { subagent_models: false } : {}),
                ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
              },
              parts,
            })

            return {
              title: params.description,
              metadata: {
                sessionId: nextSession.id,
                model,
              },
              output: [
                `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                "",
                "<task_result>",
                result.parts.findLast((item) => item.type === "text")?.text ?? "",
                "</task_result>",
              ].join("\n"),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancel
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
