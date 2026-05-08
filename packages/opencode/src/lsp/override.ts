import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@/util/record"

export function pathGlobalOverride() {
  return path.join(Global.Path.state, "lsp.json")
}

export async function readGlobalOverride() {
  const value = await Filesystem.readJson(pathGlobalOverride()).catch(() => undefined)
  if (!isRecord(value)) return
  if (typeof value.enabled !== "boolean") return
  return value.enabled
}

export async function writeGlobalOverride(enabled: boolean) {
  await Filesystem.writeJson(pathGlobalOverride(), { enabled })
}

export function resolveEnabled(config: unknown, override?: boolean) {
  return resolveConfig(config, override) !== false
}

export function resolveConfig(config: unknown, override?: boolean) {
  if (override === false) return false
  if (override === true) {
    if (config === false) return true
    return config ?? true
  }
  return config
}

export * as LSPOverride from "./override"
