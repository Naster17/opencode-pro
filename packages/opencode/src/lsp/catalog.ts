export * as LSPCatalog from "./catalog"

import fs from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { sanitize as sanitizeNpmPackage } from "@opencode-ai/core/npm"
import { isRecord } from "@/util/record"
import { which } from "@/util/which"
import * as LSPServer from "./server"

type Metadata = {
  title: string
  label?: string
  manager?: string
  description?: string
  binaries: string[]
  npm?: {
    pkg: string
    bin: string
  }
}

type ResolvedBinary = {
  candidate: string
  path: string
  source: "path" | "managed"
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
  astro: {
    title: "Astro",
    label: "astro",
    manager: "astro-ls",
    binaries: ["astro-ls"],
    npm: { pkg: "@astrojs/language-server", bin: "astro-ls" },
  },
  bash: {
    title: "Bash",
    label: "bash",
    manager: "bash-language-server",
    binaries: ["bash-language-server"],
    npm: { pkg: "bash-language-server", bin: "bash-language-server" },
  },
  biome: {
    title: "Biome",
    label: "biome",
    manager: "biome",
    binaries: ["biome"],
    npm: { pkg: "biome", bin: "biome" },
  },
  clangd: { title: "clangd", binaries: ["clangd"] },
  "clojure-lsp": { title: "Clojure", label: "clojure", manager: "clojure-lsp", binaries: ["clojure-lsp", "clojure-lsp.exe"] },
  csharp: { title: "C#", label: "roslyn", manager: "roslyn-language-server", binaries: ["roslyn-language-server", "dotnet"] },
  dart: { title: "Dart", binaries: ["dart"] },
  deno: { title: "Deno", binaries: ["deno"] },
  dockerfile: {
    title: "Dockerfile",
    label: "docker",
    manager: "docker-langserver",
    binaries: ["docker-langserver"],
    npm: { pkg: "dockerfile-language-server-nodejs", bin: "docker-langserver" },
  },
  "elixir-ls": { title: "ElixirLS", label: "elixir", manager: "elixir-ls", binaries: ["elixir-ls", "elixir"] },
  eslint: { title: "ESLint", binaries: ["eslint"] },
  fsharp: { title: "F#", label: "fsac", manager: "fsautocomplete", binaries: ["fsautocomplete", "dotnet"] },
  gleam: { title: "Gleam", binaries: ["gleam"] },
  gopls: { title: "Go", label: "gopls", manager: "gopls", binaries: ["gopls"] },
  "haskell-language-server": {
    title: "Haskell",
    manager: "haskell-language-server-wrapper",
    binaries: ["haskell-language-server-wrapper"],
  },
  jdtls: { title: "Java", label: "jdtls", manager: "jdtls", binaries: ["java"] },
  julials: { title: "Julia", label: "julia", manager: "LanguageServer.jl", binaries: ["julia"] },
  "kotlin-ls": { title: "Kotlin", label: "kotlin", manager: "kotlin-lsp", binaries: ["java", "kotlin-lsp"] },
  "lua-ls": { title: "Lua", label: "lua", manager: "lua-language-server", binaries: ["lua-language-server"] },
  nixd: { title: "Nix", binaries: ["nixd"] },
  "ocaml-lsp": { title: "OCaml", label: "ocaml", manager: "ocamllsp", binaries: ["ocamllsp"] },
  oxlint: { title: "Oxlint", label: "oxlint", manager: "oxlint --lsp", binaries: ["oxc_language_server", "oxlint"] },
  "php intelephense": {
    title: "PHP Intelephense",
    label: "intelephense",
    manager: "intelephense",
    binaries: ["intelephense"],
    npm: { pkg: "intelephense", bin: "intelephense" },
  },
  prisma: { title: "Prisma", manager: "prisma language-server", binaries: ["prisma"] },
  pyright: {
    title: "Pyright",
    label: "pyright",
    manager: "pyright-langserver",
    binaries: ["pyright-langserver", "pyright"],
    npm: { pkg: "pyright", bin: "pyright-langserver" },
  },
  razor: { title: "Razor", label: "roslyn", manager: "roslyn-language-server", binaries: ["roslyn-language-server", "dotnet"] },
  rust: { title: "Rust", label: "rust", manager: "rust-analyzer", binaries: ["rust-analyzer"] },
  "ruby-lsp": {
    title: "Ruby",
    label: "rubocop",
    manager: "rubocop --lsp",
    description: "Uses rubocop in LSP mode rather than a separate ruby-lsp binary.",
    binaries: ["rubocop", "ruby", "gem"],
  },
  "sourcekit-lsp": { title: "SourceKit-LSP", binaries: ["sourcekit-lsp", "xcrun"] },
  svelte: {
    title: "Svelte",
    label: "svelte",
    manager: "svelteserver",
    binaries: ["svelteserver"],
    npm: { pkg: "svelte-language-server", bin: "svelteserver" },
  },
  terraform: { title: "Terraform", label: "terraform", manager: "terraform-ls", binaries: ["terraform-ls"] },
  texlab: { title: "TeXLab", label: "texlab", manager: "texlab", binaries: ["texlab"] },
  tinymist: { title: "Tinymist", label: "tinymist", manager: "tinymist", binaries: ["tinymist"] },
  typescript: {
    title: "TypeScript",
    label: "typescript",
    manager: "typescript-language-server",
    binaries: ["typescript-language-server"],
    npm: { pkg: "typescript-language-server", bin: "typescript-language-server" },
  },
  ty: { title: "ty", binaries: ["ty"] },
  vue: {
    title: "Vue",
    label: "vue",
    manager: "vue-language-server",
    binaries: ["vue-language-server"],
    npm: { pkg: "@vue/language-server", bin: "vue-language-server" },
  },
  "yaml-ls": {
    title: "YAML",
    label: "yaml",
    manager: "yaml-language-server",
    binaries: ["yaml-language-server"],
    npm: { pkg: "yaml-language-server", bin: "yaml-language-server" },
  },
  zls: { title: "ZLS", label: "zls", manager: "zls", binaries: ["zls", "zig"] },
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

export function displayTitle(spec: Pick<Spec, "id" | "title">) {
  const label = metadata[spec.id]?.manager ?? metadata[spec.id]?.label
  if (!label || label === spec.title.toLowerCase()) return spec.title
  return `${spec.title} (${label})`
}

export function description(id: string) {
  return metadata[id]?.description
}

export function manager(id: string) {
  return metadata[id]?.manager
}

export function detectInstalled(spec: Pick<Spec, "id" | "binaries">, active = false) {
  if (active) return true
  if (spec.binaries.some((candidate) => Boolean(which(candidate)))) return true
  const npm = metadata[spec.id]?.npm
  if (!npm) return false
  return npmBinCandidates(npm.pkg, npm.bin).some((candidate) => fs.existsSync(candidate))
}

export function resolvedBinaries(spec: Pick<Spec, "id" | "binaries">): ResolvedBinary[] {
  const pathMatches = spec.binaries.flatMap<ResolvedBinary>((candidate) => {
    const found = which(candidate)
    return found ? [{ candidate, path: found, source: "path" }] : []
  })
  const npm = metadata[spec.id]?.npm
  const managedMatches =
    npm && !pathMatches.some((item) => item.candidate === npm.bin)
      ? npmBinCandidates(npm.pkg, npm.bin)
          .filter((candidate) => fs.existsSync(candidate))
          .map<ResolvedBinary>((candidate) => ({
            candidate: npm.bin,
            path: candidate,
            source: "managed",
          }))
      : []
  return [...pathMatches, ...managedMatches]
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

function npmBinCandidates(pkg: string, bin: string) {
  const dir = path.join(Global.Path.cache, "packages", sanitizeNpmPackage(pkg), "node_modules", ".bin")
  const windows = process.platform === "win32" ? [".cmd", ".ps1", ".exe"] : []
  return [path.join(dir, bin), ...windows.map((ext) => path.join(dir, bin + ext))]
}
