import { describe, expect, test } from "bun:test"
import { Permission } from "@/permission"

type Action = "allow" | "ask" | "deny"

const rule = (permission: string, action: Action, pattern = "*") => ({ permission, pattern, action })

describe("disabled", () => {
  test("deny with wildcard pattern removes the tool from the LLM request", () => {
    const disabled = Permission.disabled(["question", "read"], [rule("question", "deny")])
    expect(disabled.has("question")).toBe(true)
    expect(disabled.has("read")).toBe(false)
  })

  test("allow and ask keep the tool visible (ask is enforced at call time)", () => {
    const disabled = Permission.disabled(["read", "webfetch"], [rule("read", "allow"), rule("webfetch", "ask")])
    expect(disabled.size).toBe(0)
  })

  test("pattern-scoped deny does not remove the tool", () => {
    const disabled = Permission.disabled(["read"], [rule("read", "deny", "*.env")])
    expect(disabled.has("read")).toBe(false)
  })

  test("last matching rule wins so session overrides agent", () => {
    const agent = [rule("*", "allow"), rule("question", "deny")]
    const session = [rule("question", "allow")]
    expect(Permission.disabled(["question"], Permission.merge(agent, session)).has("question")).toBe(false)
    expect(Permission.disabled(["question"], Permission.merge(agent, [rule("question", "deny")])).has("question")).toBe(
      true,
    )
  })

  test("edit deny hides the whole edit group", () => {
    const disabled = Permission.disabled(["edit", "write", "apply_patch"], [rule("edit", "deny")])
    expect([...disabled].toSorted()).toEqual(["apply_patch", "edit", "write"])
  })

  test("write-only deny is inert (manager always writes the edit key instead)", () => {
    const disabled = Permission.disabled(["edit", "write"], [rule("write", "deny")])
    expect(disabled.size).toBe(0)
  })

  test("bash normalizes to shell", () => {
    expect(Permission.disabled(["shell"], [rule("bash", "deny")]).has("shell")).toBe(true)
  })

  test("wildcard permission patterns hide matching tools", () => {
    const disabled = Permission.disabled(["playwright_navigate", "read"], [rule("playwright_*", "deny")])
    expect(disabled.has("playwright_navigate")).toBe(true)
    expect(disabled.has("read")).toBe(false)
  })

  test("custom tool deny removes it by exact id", () => {
    const disabled = Permission.disabled(["ecc-run-tests", "read"], [rule("ecc-run-tests", "deny")])
    expect(disabled.has("ecc-run-tests")).toBe(true)
    expect(disabled.has("read")).toBe(false)
  })
})
