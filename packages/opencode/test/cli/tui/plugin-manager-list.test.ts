import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "url"
import {
  configuredPlugins,
  backendPluginProvider,
  backendPlugins,
} from "../../../src/cli/cmd/tui/feature-plugins/system/plugins"
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

    const items = configuredPlugins(api, 140, [
      {
        id: "acme-runtime",
        source: "npm",
        spec: "acme-runtime@1.0.0",
        target: "/tmp/node_modules/acme-runtime/tui.js",
        enabled: true,
        active: true,
      },
    ])

    expect(items).toHaveLength(2)
    expect(items.map((item) => ({ ...item, footer: undefined }))).toEqual([
      {
        title: "acme-server",
        value: "config:acme-server",
        category: "Configured",
        spec: "acme-server@1.0.0",
        enabled: true,
        description: "No TUI entry: acme-server",
        footer: undefined,
      },
      {
        title: "demo-tui",
        value: `config:${tuiOnly}`,
        category: "Configured",
        spec: tuiOnly,
        enabled: true,
        description: "No TUI entry: demo-tui.ts",
        footer: undefined,
      },
    ])
  })

  test("uses persisted enabled state for configured plugins missing from runtime", () => {
    const api = createTuiPluginApi({
      state: {
        config: {
          plugin: ["acme-server@1.0.0"],
        },
      },
      tuiConfig: {
        plugin_enabled: {
          "spec:acme-server": false,
        },
      },
    })

    const [item] = configuredPlugins(api, 140, [])
    expect(item).toMatchObject({
      value: "config:acme-server",
      enabled: false,
    })
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

  test("maps backend plugin ids to provider ids for config toggles", () => {
    expect(backendPluginProvider("codex")).toBe("openai")
    expect(backendPluginProvider("github-copilot")).toBe("github-copilot")
    expect(backendPluginProvider("missing-provider")).toBe("missing-provider")
  })
})
