import { describe, expect, test } from "bun:test"
import { resolveVisibleVariantLabel } from "../../../../src/cli/cmd/tui/component/prompt/model-meta"

describe("resolveVisibleVariantLabel", () => {
  test("hides variant labels that duplicate the active thinking badge", () => {
    expect(resolveVisibleVariantLabel("Low", "minimal")).toBeUndefined()
    expect(resolveVisibleVariantLabel("Xhigh", "xhigh")).toBeUndefined()
    expect(resolveVisibleVariantLabel("Off", "none")).toBeUndefined()
  })

  test("keeps non-duplicate custom variants visible", () => {
    expect(resolveVisibleVariantLabel("High", "xhigh")).toBe("xhigh")
    expect(resolveVisibleVariantLabel("Low", "balanced")).toBe("balanced")
    expect(resolveVisibleVariantLabel(undefined, "thinking")).toBe("thinking")
  })
})
