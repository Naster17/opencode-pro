import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { sanitize as sanitizeNpmPackage } from "@opencode-ai/core/npm"
import { LSPCatalog } from "../../src/lsp/catalog"
import * as LSPServer from "../../src/lsp/server"
import { isRecord } from "../../src/util/record"

describe("LSPCatalog", () => {
  afterEach(async () => {
    await fs.rm(path.join(Global.Path.cache, "packages", sanitizeNpmPackage("bash-language-server")), {
      force: true,
      recursive: true,
    })
    await fs.rm(path.join(Global.Path.cache, "packages", sanitizeNpmPackage("typescript-language-server")), {
      force: true,
      recursive: true,
    })
  })

  test("exposes every builtin server exactly once", () => {
    const expected = Object.values(LSPServer)
      .filter(
        (item): item is LSPServer.Info =>
          isRecord(item) && typeof item.id === "string" && Array.isArray(item.extensions),
      )
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

  test("formats builtin titles using the installed server label", () => {
    expect(LSPCatalog.displayTitle(LSPCatalog.find("ruby-lsp")!)).toBe("Ruby (rubocop --lsp)")
    expect(LSPCatalog.displayTitle(LSPCatalog.find("typescript")!)).toBe("TypeScript (typescript-language-server)")
  })

  test("detects npm-backed installs from the managed cache", async () => {
    const dir = path.join(
      Global.Path.cache,
      "packages",
      sanitizeNpmPackage("typescript-language-server"),
      "node_modules",
      ".bin",
    )
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "typescript-language-server"), "")

    expect(LSPCatalog.detectInstalled(LSPCatalog.find("typescript")!)).toBe(true)
  })

  test("reports managed npm binaries even when they are not on PATH", async () => {
    const dir = path.join(
      Global.Path.cache,
      "packages",
      sanitizeNpmPackage("bash-language-server"),
      "node_modules",
      ".bin",
    )
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "bash-language-server"), "")

    expect(LSPCatalog.resolvedBinaries(LSPCatalog.find("bash")!)).toEqual([
      {
        candidate: "bash-language-server",
        path: path.join(dir, "bash-language-server"),
        source: "managed",
      },
    ])
  })
})
