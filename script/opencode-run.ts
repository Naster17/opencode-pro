#!/usr/bin/env bun

const normalizeModel = (value: string | undefined, provider = "google") => {
  const model = value?.trim().replace(/^\/+|\/+$/g, "")
  if (!model) return
  if (model.includes("/")) return model
  return `${provider}/${model}`
}

function hasOption(args: string[], names: string[]) {
  return args.some((arg, index) => names.includes(arg) && index < args.length - 1)
}

function readOption(args: string[], names: string[]) {
  const index = args.findIndex((arg) => names.includes(arg))
  if (index < 0 || index >= args.length - 1) return
  return args[index + 1]
}

function withDefaults(args: string[], model: string | undefined, variant: string | undefined) {
  const next = [...args]
  const insertAt = next.length > 0 ? 1 : 0
  if (model && !hasOption(next, ["--model", "-m"])) next.splice(insertAt, 0, "--model", model)
  if (variant && !hasOption(next, ["--variant"])) next.splice(insertAt, 0, "--variant", variant)
  return next
}

function replaceModel(args: string[], model: string) {
  const next = [...args]
  const long = next.findIndex((arg) => arg === "--model")
  if (long >= 0 && long < next.length - 1) {
    next[long + 1] = model
    return next
  }
  const short = next.findIndex((arg) => arg === "-m")
  if (short >= 0 && short < next.length - 1) {
    next[short + 1] = model
    return next
  }
  return withDefaults(next, model, undefined)
}

function shouldFallback(text: string) {
  const lower = text.toLowerCase()
  return [
    "thinking level is not supported for this model",
    "rate limit",
    "too many requests",
    "resource_exhausted",
    "quota",
    "429",
    "provider is overloaded",
    "overloaded",
    "service unavailable",
  ].some((item) => lower.includes(item))
}

async function run(args: string[]) {
  const proc = Bun.spawn(["opencode", ...args], {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  return { stdout, stderr, code }
}

const cliArgs = Bun.argv.slice(2)
if (cliArgs.length === 0) throw new Error("Usage: bun script/opencode-run.ts <opencode args>")

const primaryModel = normalizeModel(
  process.env.OPENCODE_CI_MODEL ?? process.env.OPENCODE_CHANGELOG_MODEL ?? process.env.OPENCODE_MODEL,
)
const fallbackModel = normalizeModel(
  process.env.OPENCODE_CI_FALLBACK_MODEL ?? process.env.OPENCODE_FALLBACK_MODEL ?? process.env.OPENCODE_CI_SMALL_MODEL,
)
const variant = process.env.OPENCODE_CI_VARIANT?.trim() || undefined
const firstArgs = withDefaults(cliArgs, primaryModel, variant)
const firstModel = readOption(firstArgs, ["--model", "-m"])
const first = await run(firstArgs)

if (first.code === 0) process.exit(0)

if (!fallbackModel || fallbackModel === firstModel || !shouldFallback(`${first.stdout}\n${first.stderr}`)) {
  process.exit(first.code)
}

console.error(`[opencode-ci] retrying with fallback model ${fallbackModel}`)
const second = await run(replaceModel(firstArgs, fallbackModel))
process.exit(second.code)
