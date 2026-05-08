import { describe, expect, test } from "bun:test"
import { LSPCatalog } from "../../src/lsp/catalog"
import * as LSPServer from "../../src/lsp/server"
import { isRecord } from "../../src/util/record"

describe("LSPCatalog", () => {
  test("exposes every builtin server exactly once", () => {
    const expected = Object.values(LSPServer)
      .filter((item): item is LSPServer.Info => isRecord(item) && typeof item.id === "string" && Array.isArray(item.extensions))
      .map((item) => item.id)
      .toSorted()
    const actual = LSPCatalog.listBuiltin()
      .map((item) => item.id)
      .toSorted()
    expect(actual).toEqual(expected)
  })

  test("recognizes builtin ids through the shared catalog", () => {
    expect(LSPCatalog.isBuiltin("typescript")).toBe(true)
    expect(LSPCatalog.isBuiltin("custom-lsp")).toBe(false)
    expect(LSPCatalog.find("typescript")?.binaries).toContain("typescript-language-server")
  })

  test("derives custom specs from config entries", () => {
    const list = LSPCatalog.list({
      "custom-lsp": {
        command: ["custom-bin", "--stdio"],
        extensions: [".foo"],
      },
    })
    const custom = list.find((item) => item.id === "custom-lsp")
    expect(custom).toEqual({
      kind: "custom",
      id: "custom-lsp",
      title: "custom-lsp",
      extensions: [".foo"],
      binaries: ["custom-bin"],
      command: ["custom-bin", "--stdio"],
    })
  })
})
