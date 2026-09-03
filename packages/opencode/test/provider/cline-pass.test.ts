import { describe, expect, test } from "bun:test"
import { fromModelsDevProvider, backfillMissingModels } from "@/provider/provider"

function database() {
  return {
    "cline-pass": fromModelsDevProvider({
      id: "cline-pass",
      name: "ClinePass",
      env: ["CLINE_API_KEY"],
      api: "https://api.cline.bot/api/v1",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "cline-pass/glm-5.3": {
          id: "cline-pass/glm-5.3",
          name: "GLM-5.3",
          release_date: "2026-08-14",
          attachment: false,
          reasoning: true,
          temperature: true,
          tool_call: true,
          limit: { context: 1000000, output: 131072 },
          cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
        },
      },
    }),
  }
}

describe("cline-pass backfill", () => {
  test("adds glm-5.3-flash", () => {
    const db = database()
    backfillMissingModels(db)
    const flash = db["cline-pass"].models["cline-pass/glm-5.3-flash"]
    expect(flash.name).toBe("GLM-5.3-Flash")
    expect(flash.api.id).toBe("cline-pass/glm-5.3-flash")
    expect(flash.limit.context).toBe(1000000)
    expect(flash.cost).toEqual({ input: 0.075, output: 0.25, cache: { read: 0.015, write: 0 } })
  })

  test("keeps upstream entry when present", () => {
    const db = database()
    db["cline-pass"].models["cline-pass/glm-5.3-flash"] = {
      ...db["cline-pass"].models["cline-pass/glm-5.3"],
      id: "cline-pass/glm-5.3-flash" as never,
      name: "Upstream",
    }
    backfillMissingModels(db)
    expect(db["cline-pass"].models["cline-pass/glm-5.3-flash"].name).toBe("Upstream")
  })

  test("no-ops without cline-pass", () => {
    const db = {}
    backfillMissingModels(db)
    expect(db).toEqual({})
  })
})
