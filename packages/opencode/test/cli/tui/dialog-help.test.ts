import { describe, expect, test } from "bun:test"
import { helpCommandSearchTerms, helpSearchTerms, matchesHelpQuery } from "../../../src/cli/cmd/tui/ui/dialog-help"

describe("dialog help search terms", () => {
  test("expands keybind punctuation for fuzzy help search", () => {
    expect(helpSearchTerms("alt+r, shift+tab")).toEqual([
      "alt+r",
      "alt-r",
      "alt r",
      "shift+tab",
      "shift-tab",
      "shift tab",
    ])
  })

  test("includes slash names, aliases, and keybind variants for commands", () => {
    expect(
      helpCommandSearchTerms(
        {
          slash: {
            name: "plugins",
            aliases: ["plugin"],
          },
        },
        "alt+p",
      ),
    ).toEqual(["/plugins", "plugins", "plugin", "/plugin", "alt+p", "alt-p", "alt p"])
  })

  test("matches help rows by description, slash aliases, and keybind variants", () => {
    expect(
      matchesHelpQuery("models", {
        label: "Model switch",
        description: "Pick a model, provider, or variant for the active agent.",
        meta: "ctrl+m",
        search: ["model_list", "models"],
      }),
    ).toBe(true)

    expect(
      matchesHelpQuery("alt-p", {
        label: "Plugin Manager",
        description: "Manage plugins",
        meta: "alt+p · /plugins",
        search: ["/plugins", "plugin", "alt+p", "alt-p", "alt p"],
      }),
    ).toBe(true)
  })
})
