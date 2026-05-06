import { describe, expect, test } from "bun:test"
import { compareThinkingVariantOrder } from "../../../../src/cli/cmd/tui/context/thinking"

describe("compareThinkingVariantOrder", () => {
  test("sorts standard thinking variants predictably", () => {
    const input = ["xhigh", "minimal", "high", "none", "max", "low"]
    expect(input.toSorted(compareThinkingVariantOrder)).toEqual(["none", "minimal", "low", "high", "xhigh", "max"])
  })

  test("keeps default at the front of supported variant lists", () => {
    const input = ["high", "default", "low", "none"]
    expect(input.toSorted(compareThinkingVariantOrder)).toEqual(["default", "none", "low", "high"])
  })
})
