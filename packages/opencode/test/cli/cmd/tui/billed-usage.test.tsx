/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { BilledUsageTracker } from "../../../../src/cli/cmd/tui/feature-plugins/sidebar/billed-usage"
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2"

function assistantInfo(id: string, created: number, tokens: AssistantMessage["tokens"]): AssistantMessage {
  return {
    id,
    sessionID: "session_1",
    role: "assistant",
    time: { created, completed: created + 5000 },
    parentID: "",
    modelID: "test-model",
    providerID: "test-provider",
    mode: "build",
    agent: "build",
    path: { cwd: "", root: "" },
    cost: 0.01,
    tokens,
    finish: "completed",
  }
}

function withParts(message: Message, parts: Part[]) {
  return { info: message, parts }
}

function textPart(id: string, messageID: string, text: string, start?: number): Part {
  return {
    id,
    sessionID: "session_1",
    messageID,
    type: "text",
    text,
    time: start === undefined ? undefined : { start, end: start + 100 },
  }
}

function reasoningPart(id: string, messageID: string, text: string, start?: number): Part {
  return {
    id,
    sessionID: "session_1",
    messageID,
    type: "reasoning",
    text,
    time: { start: start ?? 0, end: start === undefined ? undefined : start + 100 },
  }
}

function toolPart(id: string, messageID: string): Part {
  return {
    id,
    sessionID: "session_1",
    messageID,
    type: "tool",
    tool: "read",
    callID: id,
    state: { status: "completed", input: {}, output: "ok", metadata: {}, title: "Read", time: { start: 1, end: 2 } },
  }
}

describe("billed usage tracker", () => {
  test("seeds totals from a full-history snapshot", async () => {
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const first = assistantInfo("msg_1", 1000, {
          input: 100,
          output: 50,
          reasoning: 10,
          cache: { read: 20, write: 5 },
        })
        const second = assistantInfo("msg_2", 7000, {
          input: 30,
          output: 15,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        })
        const tracker = new BilledUsageTracker(async () => [
          withParts(first, [textPart("p1", "msg_1", "hello", 1100)]),
          // reasoning fallback: no reported reasoning tokens, 40 chars -> 10 tokens
          withParts(second, [reasoningPart("p2", "msg_2", "a".repeat(40), 7100)]),
        ])

        tracker.setTracked(["session_1"])
        void tracker.ensureBaseline("session_1").then(() => {
          const totals = tracker.totals
          expect(totals.input).toBe(130)
          expect(totals.output).toBe(65)
          expect(totals.reasoning).toBe(10 + 10)
          expect(totals.cache_read).toBe(20)
          expect(totals.cache_write).toBe(5)
          expect(totals.cost).toBeCloseTo(0.02)
          // both assistants have output + completed + text/reasoning start
          expect(totals.generation_output).toBe(65)
          expect(totals.generation_duration).toBeGreaterThan(0)
          dispose()
          resolve()
        })
      })
    })
  })

  test("adjusts totals incrementally from events without re-fetching", async () => {
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const first = assistantInfo("msg_1", 1000, {
          input: 100,
          output: 50,
          reasoning: 10,
          cache: { read: 20, write: 5 },
        })
        let fetches = 0
        const tracker = new BilledUsageTracker(async () => {
          fetches++
          return [withParts(first, [textPart("p1", "msg_1", "hello", 1100)])]
        })
        tracker.setTracked(["session_1"])
        void tracker.ensureBaseline("session_1").then(() => {
          const next = assistantInfo("msg_3", 12000, {
            input: 7,
            output: 3,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          })
          // New message arrives via event (no fetch).
          tracker.onEvent({
            id: "e1",
            type: "message.updated",
            properties: { sessionID: "session_1", info: next },
          })
          // Parts stream in: a tool call and a reasoning delta.
          tracker.onEvent({
            id: "e2",
            type: "message.part.updated",
            properties: { sessionID: "session_1", part: toolPart("p3", "msg_3"), time: 1 },
          })
          tracker.onEvent({
            id: "e3",
            type: "message.part.updated",
            properties: { sessionID: "session_1", part: reasoningPart("p4", "msg_3", ""), time: 1 },
          })
          tracker.onEvent({
            id: "e4",
            type: "message.part.delta",
            properties: { sessionID: "session_1", messageID: "msg_3", partID: "p4", field: "text", delta: "a".repeat(8) },
          })
          tracker.flush()

          let totals = tracker.totals
          expect(fetches).toBe(1) // snapshot fetched once, never again
          expect(totals.input).toBe(107)
          expect(totals.output).toBe(53)
          expect(totals.tools).toBe(1)
          // msg_3 reasoning fallback: 8 chars -> 2 tokens
          expect(totals.reasoning).toBe(10 + 2)

          // Removing the tool part drops the tools counter.
          tracker.onEvent({
            id: "e5",
            type: "message.part.removed",
            properties: { sessionID: "session_1", messageID: "msg_3", partID: "p3" },
          })
          tracker.flush()
          totals = tracker.totals
          expect(totals.tools).toBe(0)

          // Removing the whole message drops its contribution.
          tracker.onEvent({
            id: "e6",
            type: "message.removed",
            properties: { sessionID: "session_1", messageID: "msg_3" },
          })
          tracker.flush()
          totals = tracker.totals
          expect(totals.input).toBe(100)
          expect(totals.output).toBe(50)
          expect(totals.tools).toBe(0)
          expect(totals.reasoning).toBe(10)
          dispose()
          resolve()
        })
      })
    })
  })

  test("ignores events for sessions that are not tracked", async () => {
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const tracker = new BilledUsageTracker(async () => [])
        tracker.setTracked(["session_1"])
        const info = assistantInfo("msg_x", 1, {
          input: 5,
          output: 5,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        })
        tracker.onEvent({
          id: "e1",
          type: "message.updated",
          properties: { sessionID: "other", info },
        })
        tracker.flush()
        expect(tracker.totals.input).toBe(0)
        dispose()
        resolve()
      })
    })
  })
})
