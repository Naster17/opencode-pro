import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "url"
import { configuredPlugins, backendPlugins } from "../../../src/cli/cmd/tui/feature-plugins/system/plugins"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

describe("plugin manager list", () => {
  test("includes configured server-only and tui-only plugins missing from runtime", () => {
    const tuiOnly = pathToFileURL("/tmp/demo-tui.ts").href
    const api = createTuiPluginApi({
      state: {
        config: {
          plugin: ["acme-server@1.0.0", "acme-runtime@1.0.0"],
        },
      },
      tuiConfig: {
        plugin: [tuiOnly],
      },
    })

    expect(
      configuredPlugins(api, 140, [
        {
          id: "acme-runtime",
          source: "npm",
          spec: "acme-runtime@1.0.0",
          target: "/tmp/node_modules/acme-runtime/tui.js",
          enabled: true,
          active: true,
        },
      ]),
    ).toEqual([
      {
        title: "acme-server",
        value: "config:acme-server",
        category: "Configured",
        description: "No TUI entry: acme-server@1.0.0",
        footer: "server-only or failed to load",
      },
      {
        title: "demo-tui",
        value: `config:${tuiOnly}`,
        category: "Configured",
        description: `No TUI entry: /tmp/demo-tui.ts`,
        footer: "server-only or failed to load",
      },
    ])
  })

  test("keeps backend auth plugins at the end", () => {
    expect(backendPlugins(120).map((item) => item.value)).toEqual([
      "backend:codex",
      "backend:github-copilot",
      "backend:gitlab",
      "backend:poe",
      "backend:cloudflare-workers",
      "backend:cloudflare-aigateway",
      "backend:azure",
    ])
  })
})
