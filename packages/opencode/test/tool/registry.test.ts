import { describe, expect, test } from "bun:test"
import { dedupeTools } from "@/tool/registry"

describe("dedupeTools", () => {
  test("drops duplicate ids keeping the last definition", () => {
    const first = { id: "custom", marker: "file" }
    const second = { id: "custom", marker: "plugin" }
    const result = dedupeTools([{ id: "read" }, first, { id: "glob" }, second])
    expect(result.map((item) => item.id)).toEqual(["read", "custom", "glob"])
    expect(result.find((item) => item.id === "custom")).toBe(second)
  })

  test("keeps unique tools untouched", () => {
    const input = [{ id: "a" }, { id: "b" }, { id: "c" }]
    expect(dedupeTools(input).map((item) => item.id)).toEqual(["a", "b", "c"])
  })
})
