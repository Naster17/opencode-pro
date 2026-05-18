import { describe, expect, test } from "bun:test"
import type { Message, Part, Provider } from "@opencode-ai/sdk/v2"
import { summarizeUsage } from "../../src/cli/cmd/tui/util/usage"

function provider(limit: number) {
  return [
    {
      id: "openai",
      models: {
        "gpt-4": {
          limit: {
            context: limit,
          },
        },
      },
    },
  ] as unknown as readonly Provider[]
}

function userMessage(input: { id: string }) {
  return {
    id: input.id,
    role: "user",
    agent: "default",
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: 1 },
  } as unknown as Message
}

function assistantMessage(input: { id: string; parentID: string; inputTokens: number; outputTokens: number; summary?: boolean }) {
  return {
    id: input.id,
    role: "assistant",
    parentID: input.parentID,
    agent: "default",
    mode: "default",
    providerID: "openai",
    modelID: "gpt-4",
    summary: input.summary,
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: {
      input: input.inputTokens,
      output: input.outputTokens,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 2, completed: 3 },
    finish: "end_turn",
  } as unknown as Message
}

describe("tui usage", () => {
  test("uses compacted history for current context after compaction", () => {
    const messages = [
      userMessage({ id: "user-1" }),
      assistantMessage({ id: "assistant-1", parentID: "user-1", inputTokens: 4800, outputTokens: 200 }),
      userMessage({ id: "user-2" }),
      assistantMessage({ id: "assistant-2", parentID: "user-2", inputTokens: 5200, outputTokens: 160, summary: true }),
    ] satisfies readonly Message[]
    const parts = new Map<string, readonly Part[]>([
      ["user-1", [{ type: "text", text: "older conversation that should be compacted away" } as unknown as Part]],
      ["assistant-1", [{ type: "text", text: "older assistant response" } as unknown as Part]],
      ["user-2", [{ type: "compaction", auto: false, overflow: false } as unknown as Part]],
      ["assistant-2", [{ type: "text", text: "Short compact summary" } as unknown as Part]],
    ])

    const summary = summarizeUsage(
      [
        {
          messages,
          getParts: (messageID) => parts.get(messageID) ?? [],
        },
      ],
      provider(10_000),
    )

    expect(summary.context_tokens).toBeGreaterThan(0)
    expect(summary.context_tokens).toBeLessThan(5_200)
    expect(summary.average_context_percent).toBe(Math.round((summary.context_tokens / 10_000) * 100))
  })

  test("keeps ctx at the last exact value while the assistant is still streaming", () => {
    const messages = [
      userMessage({ id: "user-1" }),
      assistantMessage({ id: "assistant-1", parentID: "user-1", inputTokens: 12_000, outputTokens: 400 }),
      userMessage({ id: "user-2" }),
      {
        ...assistantMessage({ id: "assistant-2", parentID: "user-2", inputTokens: 0, outputTokens: 0 }),
        time: { created: 4 },
        finish: undefined,
      } as unknown as Message,
    ] satisfies readonly Message[]
    const parts = new Map<string, readonly Part[]>([
      ["user-1", [{ type: "text", text: "previous context" } as unknown as Part]],
      ["assistant-1", [{ type: "text", text: "done" } as unknown as Part]],
      ["user-2", [{ type: "text", text: "new prompt that should not change live ctx yet" } as unknown as Part]],
      ["assistant-2", [{ type: "text", text: "streaming reply" } as unknown as Part]],
    ])

    const summary = summarizeUsage(
      [
        {
          messages,
          getParts: (messageID) => parts.get(messageID) ?? [],
        },
      ],
      provider(20_000),
    )

    expect(summary.context_tokens).toBe(12_000)
    expect(summary.average_context_percent).toBe(60)
  })

  test("keeps ctx at the last exact value right after sending a new user message", () => {
    const messages = [
      userMessage({ id: "user-1" }),
      assistantMessage({ id: "assistant-1", parentID: "user-1", inputTokens: 12_200, outputTokens: 400 }),
      userMessage({ id: "user-2" }),
    ] satisfies readonly Message[]
    const parts = new Map<string, readonly Part[]>([
      ["user-1", [{ type: "text", text: "previous context" } as unknown as Part]],
      ["assistant-1", [{ type: "text", text: "done" } as unknown as Part]],
      ["user-2", [{ type: "text", text: "new prompt should not bump ctx immediately" } as unknown as Part]],
    ])

    const summary = summarizeUsage(
      [
        {
          messages,
          getParts: (messageID) => parts.get(messageID) ?? [],
        },
      ],
      provider(20_000),
    )

    expect(summary.context_tokens).toBe(12_200)
    expect(summary.average_context_percent).toBe(61)
  })
})
