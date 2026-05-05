#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const npmPackagePrefix = process.env.OPENCODE_NPM_PACKAGE_PREFIX || Script.repoName
const previewPublishAuthError = /npm error code E403|Two-factor authentication|bypass 2fa enabled|required to publish packages/i

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

const shouldPublishNpm = process.env.OPENCODE_PUBLISH_NPM === "true"

const originalText = await Bun.file("package.json").text()
const pkg = JSON.parse(originalText) as {
  name: string
  version: string
  exports: Record<string, unknown>
}
pkg.name = `${npmPackagePrefix}-sdk`
function transformExports(exports: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(exports).map(([key, value]) => {
      if (typeof value === "string") {
        const file = value.replace("./src/", "./dist/").replace(".ts", "")
        return [key, { import: file + ".js", types: file + ".d.ts" }]
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return [key, transformExports(value)]
      }
      return [key, value]
    }),
  )
}
if (!shouldPublishNpm) {
  console.log(`skipping npm publish for ${pkg.name}@${pkg.version} because OPENCODE_PUBLISH_NPM is not enabled`)
} else if (await published(pkg.name, pkg.version)) {
  console.log(`already published ${pkg.name}@${pkg.version}`)
} else {
  pkg.exports = transformExports(pkg.exports)
  await Bun.write("package.json", JSON.stringify(pkg, null, 2))
  try {
    await $`bun pm pack`
    const result = await $`npm publish *.tgz --tag ${Script.channel} --access public`.nothrow()
    if (result.exitCode !== 0) {
      if (Script.preview && previewPublishAuthError.test(result.stderr.toString())) {
        console.log(`skipping npm publish for ${pkg.name}@${pkg.version} because npm token cannot publish preview packages`)
      } else {
        throw new Error(result.stderr.toString())
      }
    }
  } finally {
    await Bun.write("package.json", originalText)
  }
}
