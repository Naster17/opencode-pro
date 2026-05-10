import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, Provider, Session } from "@opencode-ai/sdk/v2"
import { summarizeUsage } from "../../../../src/cli/cmd/tui/util/usage"

function assistant(input: {
  id: string
  input: number
  output: number
  reasoning?: number
  cache_read?: number
  cache_write?: number
  completed?: number
}) {
  return {
    id: input.id,
    role: "assistant",
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    providerID: "test",
    modelID: "test-model",
    content: [],
    finish: "stop",
    cost: 0,
    tokens: {
      input: input.input,
      output: input.output,
      reasoning: input.reasoning ?? 0,
      cache: {
        read: input.cache_read ?? 0,
        write: input.cache_write ?? 0,
      },
    },
    time: {
      created: 1,
      completed: input.completed ?? 2,
    },
  } as unknown as AssistantMessage
}

describe("summarizeUsage", () => {
  test("reports context tokens from prompt-side tokens only", () => {
    const session = {
      id: "s1",
      title: "Test",
      time: { created: 1, updated: 2 },
    } as unknown as Session
    const messages = [
      assistant({
        id: "m1",
        input: 1200,
        output: 300,
        reasoning: 200,
        cache_read: 100,
        cache_write: 50,
      }),
    ]
    const providers = [
      {
        id: "test",
        models: {
          "test-model": {
            name: "Test Model",
            limit: { context: 2000 },
          },
        },
      },
    ] as unknown as Provider[]

    const result = summarizeUsage(
      [
        {
          session,
          messages,
          getParts: () => [] as Part[],
        },
      ],
      providers,
    )

    expect(result.context_tokens).toBe(1350)
    expect(result.average_context_percent).toBe(68)
  })
})
