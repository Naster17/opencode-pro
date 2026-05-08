export * as LSPCatalog from "./catalog"

import { isRecord } from "@/util/record"
import { which } from "@/util/which"
import * as LSPServer from "./server"

type Metadata = {
  title: string
  binaries: string[]
}

export type Builtin = {
  kind: "builtin"
  id: string
  title: string
  extensions: string[]
  binaries: string[]
  server: LSPServer.Info
}

export type Custom = {
  kind: "custom"
  id: string
  title: string
  extensions: string[]
  binaries: string[]
  command: string[]
}

export type Spec = Builtin | Custom

const metadata: Record<string, Metadata> = {
  astro: { title: "Astro", binaries: ["astro-ls"] },
  bash: { title: "Bash", binaries: ["bash-language-server"] },
  biome: { title: "Biome", binaries: ["biome"] },
  clangd: { title: "clangd", binaries: ["clangd"] },
  "clojure-lsp": { title: "Clojure", binaries: ["clojure-lsp", "clojure-lsp.exe"] },
  csharp: { title: "C#", binaries: ["roslyn-language-server", "dotnet"] },
  dart: { title: "Dart", binaries: ["dart"] },
  deno: { title: "Deno", binaries: ["deno"] },
  dockerfile: { title: "Dockerfile", binaries: ["docker-langserver"] },
  "elixir-ls": { title: "ElixirLS", binaries: ["elixir-ls", "elixir"] },
  eslint: { title: "ESLint", binaries: ["eslint"] },
  fsharp: { title: "F#", binaries: ["fsautocomplete", "dotnet"] },
  gleam: { title: "Gleam", binaries: ["gleam"] },
  gopls: { title: "Go", binaries: ["gopls"] },
  "haskell-language-server": { title: "Haskell", binaries: ["haskell-language-server-wrapper"] },
  jdtls: { title: "Java", binaries: ["java"] },
  julials: { title: "Julia", binaries: ["julia"] },
  "kotlin-ls": { title: "Kotlin", binaries: ["java", "kotlin-lsp"] },
  "lua-ls": { title: "Lua", binaries: ["lua-language-server"] },
  nixd: { title: "Nix", binaries: ["nixd"] },
  "ocaml-lsp": { title: "OCaml", binaries: ["ocamllsp"] },
  oxlint: { title: "Oxlint", binaries: ["oxc_language_server", "oxlint"] },
  "php intelephense": { title: "PHP Intelephense", binaries: ["intelephense"] },
  prisma: { title: "Prisma", binaries: ["prisma"] },
  pyright: { title: "Pyright", binaries: ["pyright-langserver", "pyright"] },
  razor: { title: "Razor", binaries: ["roslyn-language-server", "dotnet"] },
  rust: { title: "Rust", binaries: ["rust-analyzer"] },
  "ruby-lsp": { title: "Ruby", binaries: ["rubocop", "ruby", "gem"] },
  "sourcekit-lsp": { title: "SourceKit-LSP", binaries: ["sourcekit-lsp", "xcrun"] },
  svelte: { title: "Svelte", binaries: ["svelteserver"] },
  terraform: { title: "Terraform", binaries: ["terraform-ls"] },
  texlab: { title: "TeXLab", binaries: ["texlab"] },
  tinymist: { title: "Tinymist", binaries: ["tinymist"] },
  typescript: { title: "TypeScript", binaries: ["typescript-language-server"] },
  ty: { title: "ty", binaries: ["ty"] },
  vue: { title: "Vue", binaries: ["vue-language-server"] },
  "yaml-ls": { title: "YAML", binaries: ["yaml-language-server"] },
  zls: { title: "ZLS", binaries: ["zls", "zig"] },
}

const builtin = Object.values(LSPServer)
  .filter((item): item is LSPServer.Info => isRecord(item) && typeof item.id === "string" && Array.isArray(item.extensions))
  .map<Builtin>((server) => ({
    kind: "builtin",
    id: server.id,
    title: metadata[server.id]?.title ?? server.id,
    extensions: server.extensions,
    binaries: metadata[server.id]?.binaries ?? [],
    server,
  }))
  .toSorted((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))

const builtinByID = new Map(builtin.map((item) => [item.id, item]))
const builtinIDs = new Set(builtin.map((item) => item.id))

export function listBuiltin() {
  return builtin
}

export function listBuiltinServers() {
  return builtin.map((item) => item.server)
}

export function builtinServerIDs() {
  return builtinIDs
}

export function find(id: string) {
  return builtinByID.get(id)
}

export function isBuiltin(id: string) {
  return builtinIDs.has(id)
}

export function detectInstalled(spec: Pick<Spec, "binaries">, active = false) {
  return active || spec.binaries.some((candidate) => Boolean(which(candidate)))
}

export function fromConfig(id: string, entry: unknown) {
  if (!isRecord(entry)) return
  if (isBuiltin(id)) return
  const command = "command" in entry && Array.isArray(entry.command) ? entry.command.filter(isString) : []
  const extensions = "extensions" in entry && Array.isArray(entry.extensions) ? entry.extensions.filter(isString) : []
  return {
    kind: "custom",
    id,
    title: id,
    extensions,
    binaries: command[0] ? [command[0]] : [],
    command,
  } satisfies Custom
}

export function list(config: unknown) {
  if (!isRecord(config)) return builtin
  return [
    ...builtin,
    ...Object.entries(config)
      .flatMap(([id, entry]) => {
        const item = fromConfig(id, entry)
        return item ? [item] : []
      })
      .toSorted((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id)),
  ]
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}
