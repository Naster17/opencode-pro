import { describe, expect, test } from "bun:test"
import { ThinkTags } from "../../src/session/think-tags"

describe("ThinkTags", () => {
  test("strips complete and split think tags from reasoning streams", () => {
    const stripper = ThinkTags.createStripper()

    expect(stripper.push("<thi")).toBe("")
    expect(stripper.push("nk>hello</thi")).toBe("hello")
    expect(stripper.push("nk> world")).toBe(" world")
    expect(stripper.flush()).toBe("")
  })

  test("splits inline think blocks out of text streams", () => {
    const state = { active: false, pending: "" }

    expect(ThinkTags.split(state, "before <thi")).toStrictEqual([{ type: "text", text: "before " }])
    expect(ThinkTags.split(state, "nk>hidden</think> after")).toStrictEqual([
      { type: "reasoning", text: "hidden" },
      { type: "text", text: " after" },
    ])
    expect(ThinkTags.flushSplit(state)).toStrictEqual([])
  })
})
