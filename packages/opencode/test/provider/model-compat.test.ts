import { describe, expect, test } from "bun:test"
import { ModelCompat } from "../../src/provider/model-compat"

describe("ModelCompat", () => {
  test.each([
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "models/gemini-2.0-flash-001",
    "gemini-pro",
    "gemma-4b-it",
    "gemma-3n-e4b-it",
    "learnlm-2.0-flash-experimental",
  ])("accepts compatible Google Gemini chat model %s", (id) => {
    expect(ModelCompat.isGoogleModelIDCompatible(id)).toBe(true)
  })

  test.each([
    "antigravity-agent-preview",
    "embeddinggemma-300m",
    "gemini-embedding-001",
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-pro-deep-research",
    "gemini-2.5-computer-use-preview-10-2025",
    "gemini-2.0-flash-preview-image-generation",
    "gemini-live-2.5-flash-preview",
  ])("rejects unsupported Google model %s", (id) => {
    expect(ModelCompat.isGoogleModelIDCompatible(id)).toBe(false)
  })
})
