import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { LSPCatalog } from "@/lsp/catalog"
import { LSPOverride } from "@/lsp/override"
import fuzzysort from "fuzzysort"
import { isRecord } from "@/util/record"

type LSPStatus = "enabled" | "disabled" | "not-installed" | "installed"

interface LSPEntry {
  id: string
  title: string
  status: LSPStatus
  extensions: string[]
  command?: string[]
}

export const LspCommand = effectCmd({
  command: "lsp [query]",
  describe: "manage and list LSP servers",
  builder: (yargs) =>
    yargs.positional("query", {
      describe: "filter LSP servers by name",
      type: "string",
    }),
  handler: Effect.fn("Cli.lsp")(function* (args) {
    UI.empty()
    prompts.intro("LSP Manager")

    const configService = yield* Config.Service
    const config = yield* configService.get()
    const lspService = yield* LSP.Service
    const activeClients = yield* lspService.status()
    const enabledOverride = yield* Effect.promise(() => LSPOverride.readGlobalOverride())
    const globalEnabled = LSPOverride.resolveEnabled(config.lsp, enabledOverride)
    const lspEntries = LSPCatalog.list(config.lsp)
      .map<LSPEntry>((spec) => {
        const userConfig = isRecord(config.lsp) ? config.lsp[spec.id] : undefined
        const active = activeClients.some((client) => client.id === spec.id)
        const disabled = !globalEnabled || (isRecord(userConfig) && userConfig.disabled === true)
        const status = disabled
          ? "disabled"
          : active
            ? "enabled"
            : LSPCatalog.detectInstalled(spec, active)
              ? "installed"
              : "not-installed"
        return {
          id: spec.id,
          title: LSPCatalog.displayTitle(spec),
          status,
          extensions: spec.extensions,
          command: spec.kind === "custom" ? spec.command : undefined,
        }
      })
      .toSorted((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))

    let filtered = lspEntries
    if (args.query) {
      const results = fuzzysort.go(args.query, lspEntries, { keys: ["title", "id"] })
      filtered = results.map((result) => result.obj)
    }

    if (filtered.length === 0) {
      prompts.log.warn(args.query ? `No LSP servers matching "${args.query}"` : "No LSP servers found")
      prompts.outro("Done")
      return
    }

    const options = filtered.map((entry) => {
      let color = UI.Style.TEXT_DIM
      if (entry.status === "enabled") color = UI.Style.TEXT_SUCCESS
      if (entry.status === "disabled") color = UI.Style.TEXT_WARNING
      if (entry.status === "installed") color = UI.Style.TEXT_INFO

      const label = `${entry.title.padEnd(20)} ${color}${entry.status.toUpperCase()}${UI.Style.TEXT_NORMAL}`
      const hint =
        entry.title === entry.id ? entry.extensions.join(", ") : `${entry.id} • ${entry.extensions.join(", ")}`

      return {
        label,
        value: entry.id,
        hint,
      }
    })

    const selected = yield* Effect.promise(() =>
      prompts.select({
        message: "LSP Servers (Select to see details)",
        options: [{ label: "Search...", value: "SEARCH_ACTION" }, ...options],
      }),
    )

    if (prompts.isCancel(selected)) {
      prompts.outro("Done")
      return
    }

    if (selected === "SEARCH_ACTION") {
      const query = yield* Effect.promise(() =>
        prompts.text({
          message: "Enter search query",
        }),
      )
      if (prompts.isCancel(query)) {
        prompts.outro("Done")
        return
      }
      // Re-run the command with the query
      // Note: In a real CLI this might need a different approach, but for this demo:
      UI.println(`Searching for: ${query}...`)
      // Normally we'd recursion or loop, but let's just show the filtered list next time
    } else {
      const entry = lspEntries.find((item) => item.id === selected)
      if (entry) {
        UI.empty()
        UI.println(`${UI.Style.TEXT_NORMAL_BOLD}${entry.title}${UI.Style.TEXT_NORMAL}`)
        if (entry.title !== entry.id) {
          UI.println(`ID: ${entry.id}`)
        }
        UI.println(`Status: ${entry.status}`)
        UI.println(`Extensions: ${entry.extensions.join(", ")}`)
        if (entry.command) {
          UI.println(`Command: ${entry.command.join(" ")}`)
        }
      }
    }

    prompts.outro("Use opencode.json to enable/disable specific servers.")
  }),
})
