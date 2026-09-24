import { describe, expect, test } from "bun:test"
import { splitTimestampFooter } from "../../src/session/llm"
import {
  CACHE_TIME_BUCKET_MINUTES,
  floorDateToCacheBucket,
  isVolatileTimestampBlock,
  normalizeSystemPrompt,
} from "../../src/session/cache-optimizer"
import { ProviderTransform } from "@/provider/transform"

describe("cache stability", () => {
  test("floorDateToCacheBucket quantizes to 5-minute buckets", () => {
    expect(CACHE_TIME_BUCKET_MINUTES).toBe(5)
    const a = floorDateToCacheBucket(new Date(2026, 8, 24, 21, 3, 45))
    const b = floorDateToCacheBucket(new Date(2026, 8, 24, 21, 7, 10))
    expect(a.getMinutes()).toBe(0)
    expect(b.getMinutes()).toBe(5)
    expect(a.getSeconds()).toBe(0)
    // same bucket, different seconds -> identical
    expect(floorDateToCacheBucket(new Date(2026, 8, 24, 21, 6, 1)).getTime()).toBe(
      floorDateToCacheBucket(new Date(2026, 8, 24, 21, 9, 59)).getTime(),
    )
  })

  test("splitTimestampFooter separates volatile footer from stable prefix", () => {
    const text = ["You are helpful.", "Env: stable", "Current time: 2026-09-24 21:10 (local, Europe/Rome)", "Session started: 2026-09-24 20:55 (local)"].join("\n")
    const [prefix, footer] = splitTimestampFooter(text)
    expect(prefix).toBe("You are helpful.\nEnv: stable")
    expect(footer).toContain("Current time:")
    expect(footer).toContain("Session started:")
  })

  test("splitTimestampFooter returns no footer for stable content", () => {
    const text = "You are helpful.\nEnv: stable"
    const [prefix, footer] = splitTimestampFooter(text)
    expect(prefix).toBe(text)
    expect(footer).toBeUndefined()
  })

  test("normalizeSystemPrompt strips seconds from Current time", () => {
    const out = normalizeSystemPrompt("Current time: 2026-09-24 21:10:45 (local, Europe/Rome)")
    expect(out).not.toContain(":45")
    expect(out).toContain("Current time:")
  })

  test("isVolatileTimestampBlock detects footer-only content", () => {
    expect(isVolatileTimestampBlock("Current time: 2026-09-24 21:10 (local)\nSession started: 2026-09-24 20:55 (local)")).toBe(true)
    expect(isVolatileTimestampBlock("You are a helpful assistant.")).toBe(false)
    expect(isVolatileTimestampBlock("")).toBe(false)
  })

  test("applyCaching skips cache markers on volatile footer system message", () => {
    const model = {
      providerID: "anthropic",
      id: "claude-sonnet-4-6",
      api: { id: "claude-sonnet-4-6", npm: "@ai-sdk/anthropic" },
      capabilities: { interleaved: false, input: { text: true } },
    } as any
    const msgs = [
      { role: "system", content: "stable prefix" },
      { role: "system", content: "Current time: 2026-09-24 21:10 (local)\nSession started: 2026-09-24 20:55 (local)" },
      { role: "user", content: "hi" },
    ] as any
    const out = ProviderTransform.message(msgs, model, {}, { caching: {} }) as any[]
    expect(out[0].providerOptions?.anthropic?.cacheControl).toBeDefined()
    expect(out[1].providerOptions?.anthropic?.cacheControl).toBeUndefined()
  })
})
