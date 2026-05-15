#!/usr/bin/env bun

import { $ } from "bun"
import path from "node:path"

const platform = process.platform === "darwin" ? "--mac" : process.platform === "win32" ? "--win" : "--linux"
const arch = process.arch === "arm64" ? "--arm64" : "--x64"

process.env.ELECTRON_RENDERER_SOURCEMAP = "false"
process.env.OPENCODE_MODELS_FALLBACK_JSON = path.resolve(import.meta.dir, "../../opencode/test/tool/fixtures/models-api.json")

await $`bun ./scripts/prebuild.ts`
await $`electron-vite build`
await $`electron-builder ${platform} ${arch} --dir --config electron-builder.config.ts`
