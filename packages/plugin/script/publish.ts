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

await $`bun tsc`
const originalText = await Bun.file("package.json").text()
const pkg = JSON.parse(originalText) as {
  name: string
  version: string
  exports: Record<string, string>
}
pkg.name = `${npmPackagePrefix}-plugin`
if (!shouldPublishNpm) {
  console.log(`skipping npm publish for ${pkg.name}@${pkg.version} because OPENCODE_PUBLISH_NPM is not enabled`)
} else if (await published(pkg.name, pkg.version)) {
  console.log(`already published ${pkg.name}@${pkg.version}`)
} else {
  for (const [key, value] of Object.entries(pkg.exports)) {
    const file = value.replace("./src/", "./dist/").replace(".ts", "")
    // @ts-ignore
    pkg.exports[key] = {
      import: file + ".js",
      types: file + ".d.ts",
    }
  }
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
