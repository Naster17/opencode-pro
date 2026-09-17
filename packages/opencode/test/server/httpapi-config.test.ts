import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { waitGlobalBusEventPromise } from "./global-bus"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app() {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = true
  return Server.Default().app
}

async function waitDisposed(directory: string) {
  await waitGlobalBusEventPromise({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  test("serves config update through Hono bridge", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const disposed = waitDisposed(tmp.path)

    const response = await app().request("/config", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ username: "patched-user", formatter: false, lsp: false })
    await disposed
    expect(await Bun.file(path.join(tmp.path, "config.json")).json()).toMatchObject({
      username: "patched-user",
      formatter: false,
      lsp: false,
    })
  })

  test("persists tool permission to local project config", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": tmp.path,
    }
    const file = path.join(tmp.path, ".opencode", "opencode.json")

    const first = await app().request("/config/permission", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ scope: "local", permission: { webfetch: "deny" } }),
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ success: true })
    expect(await Bun.file(file).json()).toMatchObject({ permission: { webfetch: "deny" } })

    const second = await app().request("/config/permission", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ scope: "local", permission: { read: "ask" } }),
    })
    expect(second.status).toBe(200)
    expect(await Bun.file(file).json()).toMatchObject({ permission: { webfetch: "deny", read: "ask" } })
  })

  test("global persist neutralizes shadowed local keys", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const local = path.join(tmp.path, ".opencode", "opencode.json")
    await Bun.write(local, JSON.stringify({ permission: { "shadow-probe-tool": "allow", read: "ask" } }))
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": tmp.path,
    }

    const response = await app().request("/config/permission", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ scope: "global", permission: { "shadow-probe-tool": "deny" } }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })

    const localAfter = (await Bun.file(local).json()) as { permission?: Record<string, unknown> }
    expect(localAfter.permission).not.toHaveProperty("shadow-probe-tool")
    expect(localAfter.permission).toMatchObject({ read: "ask" })

    const merged = await app().request("/config", { headers: { "x-opencode-directory": tmp.path } })
    expect(merged.status).toBe(200)
    expect(await merged.json()).toMatchObject({ permission: { "shadow-probe-tool": "deny" } })
  })

  test("rejects invalid tool permission values", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })

    const response = await app().request("/config/permission", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": tmp.path,
      },
      body: JSON.stringify({ scope: "local", permission: { webfetch: "sometimes" } }),
    })
    expect(response.status).toBe(400)
  })

  test("merges per-skill pattern patches into existing permission objects", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const local = path.join(tmp.path, ".opencode", "opencode.json")
    await Bun.write(local, JSON.stringify({ permission: { skill: { "*": "allow", "ecc-tools": "deny" } } }))
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": tmp.path,
    }

    const first = await app().request("/config/permission", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ scope: "local", permission: { skill: { "ecc-git-summary": "deny" } } }),
    })
    expect(first.status).toBe(200)
    expect(await Bun.file(local).json()).toMatchObject({
      permission: { skill: { "*": "allow", "ecc-tools": "deny", "ecc-git-summary": "deny" } },
    })

    const second = await app().request("/config/permission", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ scope: "local", permission: { skill: "allow" } }),
    })
    expect(second.status).toBe(200)
    expect(await Bun.file(local).json()).toMatchObject({ permission: { skill: "allow" } })
  })

  test("global per-skill persist neutralizes shadowed local skill key", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const local = path.join(tmp.path, ".opencode", "opencode.json")
    await Bun.write(local, JSON.stringify({ permission: { skill: "allow", read: "ask" } }))
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": tmp.path,
    }

    const response = await app().request("/config/permission", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ scope: "global", permission: { skill: { "ecc-tools": "deny" } } }),
    })
    expect(response.status).toBe(200)

    const localAfter = (await Bun.file(local).json()) as { permission?: Record<string, unknown> }
    expect(localAfter.permission).not.toHaveProperty("skill")
    expect(localAfter.permission).toMatchObject({ read: "ask" })

    const merged = await app().request("/config", { headers: { "x-opencode-directory": tmp.path } })
    expect(merged.status).toBe(200)
    expect(await merged.json()).toMatchObject({ permission: { skill: { "ecc-tools": "deny" } } })
  })
})
