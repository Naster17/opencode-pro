import { describe, expect, test } from "bun:test"
import { normalizeThinkingDisplay, normalizeThinkingLevel } from "../../../../src/cli/cmd/tui/context/thinking"

describe("thinking normalization", () => {
  test("preserves extended effort tiers", () => {
    expect(normalizeThinkingLevel("xhigh")).toBe("xhigh")
    expect(normalizeThinkingLevel("max")).toBe("max")
  })

  test("maps alias labels onto the right effective tier", () => {
    expect(normalizeThinkingDisplay("minimal")).toBe("low")
    expect(normalizeThinkingDisplay("none")).toBe("off")
    expect(normalizeThinkingDisplay("thinking")).toBe("thinking")
  })
})
