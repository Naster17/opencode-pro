import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { sanitize as sanitizeNpmPackage } from "@opencode-ai/core/npm"
import type { InstanceContext } from "@/project/instance-context"
import * as LSPServer from "@/lsp/server"
import { Process } from "@/util/process"

const ctx = {
  directory: "/tmp/opencode-lsp",
  worktree: "/tmp/opencode-lsp",
  project: {} as never,
} satisfies InstanceContext

describe("LSP install", () => {
  afterEach(async () => {
    await fs.rm(path.join(Global.Path.cache, "packages", sanitizeNpmPackage("typescript-language-server")), {
      force: true,
      recursive: true,
    })
  })

  test("installs npm-backed LSPs via npm cache", async () => {
    const npm = spyOn(Npm, "which").mockResolvedValue("/tmp/opencode-lsp/node_modules/.bin/typescript-language-server")

    try {
      await expect(LSPServer.install("typescript", ctx)).resolves.toEqual({
        ok: true,
        message: "Installed typescript LSP",
      })
      expect(npm).toHaveBeenCalledWith("typescript-language-server", "typescript-language-server")
    } finally {
      npm.mockRestore()
    }
  })

  test("installs spawn-backed LSPs by reusing server bootstrap", async () => {
    const proc = {
      exitCode: null,
      signalCode: null,
      kill() {},
    }
    const spawn = spyOn(LSPServer.Gopls, "spawn").mockResolvedValue({
      process: proc as never,
    })
    const stop = spyOn(Process, "stop").mockResolvedValue()

    try {
      await expect(LSPServer.install("gopls", ctx)).resolves.toEqual({
        ok: true,
        message: "Installed gopls LSP",
      })
      expect(spawn).toHaveBeenCalledWith(ctx.directory, ctx)
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      spawn.mockRestore()
      stop.mockRestore()
    }
  })

  test("returns a manual-install hint for unsupported servers", async () => {
    await expect(LSPServer.install("rust", ctx)).resolves.toEqual({
      ok: false,
      message: "Automatic install is not available for rust. Install it manually and reopen /lsp.",
    })
  })

  test("deletes npm-backed managed installs from the cache", async () => {
    const dir = path.join(Global.Path.cache, "packages", sanitizeNpmPackage("typescript-language-server"))
    await fs.mkdir(path.join(dir, "node_modules", ".bin"), { recursive: true })

    await expect(LSPServer.uninstall("typescript", ctx)).resolves.toEqual({
      ok: true,
      message: "Deleted typescript LSP",
    })
    await expect(fs.stat(dir)).rejects.toBeDefined()
  })
})
