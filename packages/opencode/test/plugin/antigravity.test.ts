import { describe, expect, test } from "bun:test"
import {
  isAntigravityModelID,
  isAntigravityModel,
  normalizeAntigravityModelID,
  isClaudeModel,
  isClaudeThinkingModel,
  cleanClaudeTools,
  sanitizeClaudeContents,
  resolveAntigravityAuth,
} from "../../src/plugin/antigravity"

describe("plugin.antigravity", () => {
  describe("isAntigravityModelID", () => {
    test("identifies Gemini models supported by Antigravity", () => {
      expect(isAntigravityModelID("gemini-3.8-flash")).toBe(true)
      expect(isAntigravityModelID("gemini-3.8-flash-high")).toBe(true)
      expect(isAntigravityModelID("gemini-3.8-flash-medium")).toBe(true)
      expect(isAntigravityModelID("gemini-3.8-flash-low")).toBe(true)
      expect(isAntigravityModelID("gemini-3.7-flash")).toBe(true)
      expect(isAntigravityModelID("gemini-3.6-flash")).toBe(true)
      expect(isAntigravityModelID("gemini-3.1-pro")).toBe(true)
      expect(isAntigravityModelID("gemini-pro-agent")).toBe(true)
      expect(isAntigravityModelID("gemini-3.1-pro-low")).toBe(true)
    })

    test("identifies Claude and GPT-OSS models provided through Antigravity", () => {
      expect(isAntigravityModelID("claude-sonnet-4-6")).toBe(true)
      expect(isAntigravityModelID("claude-opus-4-6-thinking")).toBe(true)
      expect(isAntigravityModelID("gpt-oss-120b-medium")).toBe(true)
    })

    test("rejects standard models not provided by Antigravity", () => {
      expect(isAntigravityModelID("gpt-4o")).toBe(false)
      expect(isAntigravityModelID("claude-3-5-sonnet-20241022")).toBe(false)
      expect(isAntigravityModelID("gemini-1.5-pro")).toBe(false)
    })
  })

  describe("isAntigravityModel", () => {
    test("supports antigravity provider and antigravity-prefixed model IDs", () => {
      expect(isAntigravityModel("antigravity", "gemini-3.8-flash-high")).toBe(true)
      expect(isAntigravityModel("antigravity", "claude-sonnet-4-6")).toBe(true)
      expect(isAntigravityModel("google", "gemini-3.8-flash-high")).toBe(false)
      expect(isAntigravityModel("google", "claude-sonnet-4-6")).toBe(false)
      expect(isAntigravityModel("anthropic", "claude-sonnet-4-6")).toBe(false)
      expect(isAntigravityModel("openai", "gpt-oss-120b-medium")).toBe(false)
      expect(isAntigravityModel("anthropic", "antigravity-claude-sonnet-4-6")).toBe(true)
    })
  })

  describe("normalizeAntigravityModelID", () => {
    test("maps aliases to default variants", () => {
      expect(normalizeAntigravityModelID("gemini-3.8-flash")).toBe("gemini-3.8-flash-high")
      expect(normalizeAntigravityModelID("gemini-3.7-flash")).toBe("gemini-3.7-flash-high")
      expect(normalizeAntigravityModelID("gemini-3.6-flash")).toBe("gemini-3.6-flash-high")
    })

    test("preserves exact model IDs", () => {
      expect(normalizeAntigravityModelID("gemini-3.8-flash-low")).toBe("gemini-3.8-flash-low")
      expect(normalizeAntigravityModelID("claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
      expect(normalizeAntigravityModelID("claude-opus-4-6-thinking")).toBe("claude-opus-4-6-thinking")
      expect(normalizeAntigravityModelID("gpt-oss-120b-medium")).toBe("gpt-oss-120b-medium")
    })
  })

  describe("isClaudeModel and thinking", () => {
    test("identifies claude models", () => {
      expect(isClaudeModel("claude-sonnet-4-6")).toBe(true)
      expect(isClaudeModel("claude-opus-4-6-thinking")).toBe(true)
      expect(isClaudeModel("gemini-3.8-flash-high")).toBe(false)
    })

    test("identifies thinking models", () => {
      expect(isClaudeThinkingModel("claude-opus-4-6-thinking")).toBe(true)
      expect(isClaudeThinkingModel("claude-sonnet-4-6")).toBe(false)
    })
  })

  describe("cleanClaudeTools", () => {
    test("strips unsupported fields for Claude compatibility", () => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: "read_file",
              description: "Read a file from disk",
              parameters: {
                type: "object",
                properties: {
                  path: {
                    type: "string",
                    default: "/tmp/foo",
                    examples: ["/tmp/bar"],
                    description: "Path to file",
                  },
                  offset: {
                    type: "integer",
                    format: "int32",
                  },
                },
                required: ["path"],
                $schema: "http://json-schema.org/draft-07/schema#",
                additionalProperties: false,
              },
            },
          ],
        },
      ]

      const cleaned = cleanClaudeTools(tools) as any[]
      const params = cleaned[0].functionDeclarations[0].parameters as any
      expect(params.$schema).toBeUndefined()
      expect(params.additionalProperties).toBeUndefined()
      expect(params.properties.path.default).toBeUndefined()
      expect(params.properties.path.examples).toBeUndefined()
      expect(params.properties.offset.format).toBeUndefined()
      expect(params.properties.path.type).toBe("string")
      expect(params.properties.offset.type).toBe("integer")
    })
  })

  describe("sanitizeClaudeContents", () => {
    test("removes thought parts from contents history for Claude", () => {
      const contents = [
        {
          role: "user",
          parts: [{ text: "Hello" }],
        },
        {
          role: "model",
          parts: [{ thought: "Internal thinking..." } as any, { text: "Hello! How can I help you today?" }],
        },
      ]

      const sanitized = sanitizeClaudeContents(contents) as any[]
      expect(sanitized[1].parts.length).toBe(1)
      expect(sanitized[1].parts[0].text).toBe("Hello! How can I help you today?")
    })

    test("matches parallel same-name tool calls to responses in order", () => {
      const contents = [
        {
          role: "model",
          parts: [{ functionCall: { name: "read" } }, { functionCall: { name: "read" } }],
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "read" } }, { functionResponse: { name: "read" } }],
        },
      ]

      const sanitized = sanitizeClaudeContents(contents) as any[]
      const callIDs = sanitized[0].parts.map((p: any) => p.functionCall.id)
      const responseIDs = sanitized[1].parts.map((p: any) => p.functionResponse.id)
      expect(new Set(callIDs).size).toBe(2)
      expect(responseIDs.sort()).toEqual(callIDs.sort())
    })
  })

  describe("resolveAntigravityAuth", () => {
    test("returns undefined or valid credentials depending on host environment", async () => {
      const auth = await resolveAntigravityAuth()
      if (!auth) return
      // Stored credentials may be expired on the host (refresh happens lazily
      // in the fetch handler, not here) — only assert shape in that case.
      expect(auth.access).toBeTruthy()
      expect(typeof auth.expires).toBe("number")
      if (auth.expires <= Date.now()) return
      if (auth.email) expect(auth.email).toContain("@")
    })
  })
})
