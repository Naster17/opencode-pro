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

function stepFinish(input: {
  messageID: string
  input: number
  output: number
  reasoning?: number
  cache_read?: number
  cache_write?: number
  cost?: number
}) {
  return {
    id: `${input.messageID}-finish`,
    messageID: input.messageID,
    sessionID: "s1",
    type: "step-finish",
    reason: "stop",
    cost: input.cost ?? 0,
    tokens: {
      input: input.input,
      output: input.output,
      reasoning: input.reasoning ?? 0,
      cache: {
        read: input.cache_read ?? 0,
        write: input.cache_write ?? 0,
      },
    },
  } as unknown as Part
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

  test("uses step-finish tokens when assistant message tokens are empty", () => {
    const session = {
      id: "s1",
      title: "Test",
      time: { created: 1, updated: 2 },
    } as unknown as Session
    const messages = [assistant({ id: "m1", input: 0, output: 0 })]
    const parts = {
      m1: [stepFinish({ messageID: "m1", input: 100, output: 25, reasoning: 5, cache_read: 10, cost: 0.01 })],
    }

    const result = summarizeUsage(
      [
        {
          session,
          messages,
          getParts: (id) => parts[id as keyof typeof parts] ?? [],
        },
      ],
      [] as Provider[],
    )

    expect(result.input).toBe(100)
    expect(result.output).toBe(25)
    expect(result.reasoning).toBe(5)
    expect(result.cache_read).toBe(10)
    expect(result.tokens).toBe(140)
    expect(result.cost).toBe(0.01)
  })

  test("reports context tokens for reasoning-only model usage", () => {
    const session = {
      id: "s1",
      title: "Test",
      time: { created: 1, updated: 2 },
    } as unknown as Session
    const messages = [assistant({ id: "m1", input: 900, output: 0, reasoning: 100 })]
    const providers = [
      {
        id: "test",
        models: {
          "test-model": {
            name: "Test Model",
            limit: { context: 1000 },
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

    expect(result.context_tokens).toBe(900)
    expect(result.average_context_percent).toBe(90)
  })
})
