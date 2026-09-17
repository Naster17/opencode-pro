import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`
const rendererSourcemap = process.env.ELECTRON_RENDERER_SOURCEMAP !== "false"

const ignoreKnownBuildWarnings = (
  warning: { code?: string; id?: string; message: string },
  next: (warning: unknown) => void,
) => {
  if (warning.code === "EVAL" && warning.id?.includes("/packages/opencode/dist/node/node.js")) return
  if (
    warning.message.includes("dynamically imported by") &&
    warning.message.includes("will not move module into another chunk")
  )
    return
  next(warning)
}

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
        onwarn(warning, next) {
          ignoreKnownBuildWarnings(warning, next)
        },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    define: {
      "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      sourcemap: rendererSourcemap,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
        onwarn(warning, next) {
          ignoreKnownBuildWarnings(warning, next)
        },
      },
    },
  },
})
