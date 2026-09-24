import path from "path"
import { Global } from "@opencode-ai/core/global"
import { resolveAntigravityAuth, type ResolvedAntigravityAuth } from "@/plugin/antigravity"
import { execSync } from "child_process"
import fs from "fs"

const cacheTTL = 5 * 60 * 1000

export type BucketSnapshot = {
  remainingPercent: number
  usedPercent: number
  resetsAt?: number
}

export type AntigravityUsageSnapshot = {
  configured: boolean
  email?: string
  plan?: string
  tier?: string
  gemini5h?: BucketSnapshot
  geminiWeekly?: BucketSnapshot
  claude5h?: BucketSnapshot
  claudeWeekly?: BucketSnapshot
  models?: Record<string, BucketSnapshot>
}

let cached: { time: number; value: AntigravityUsageSnapshot } | undefined
let inflight: Promise<AntigravityUsageSnapshot> | undefined

export function clearAntigravityUsageCache() {
  cached = undefined
  inflight = undefined
}

export function formatResetDuration(resetsAt: number, now = Date.now()) {
  const targetMs = resetsAt < 10_000_000_000 && now >= 10_000_000_000 ? resetsAt * 1000 : resetsAt
  const totalMinutes = Math.max(0, Math.floor((targetMs - now) / 60_000))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function bucketFromFraction(remainingFraction: number, resetTime?: unknown): BucketSnapshot {
  const resetsAt = typeof resetTime === "string" ? Date.parse(resetTime) : undefined
  return {
    remainingPercent: Math.round(remainingFraction * 1000) / 10,
    usedPercent: Math.round((1 - remainingFraction) * 1000) / 10,
    resetsAt: Number.isFinite(resetsAt) ? (resetsAt as number) : undefined,
  }
}

function isFiveHourWindow(window: unknown): boolean {
  return typeof window === "string" && /5\s*h/i.test(window)
}

function isWeeklyWindow(window: unknown): boolean {
  return typeof window === "string" && /week/i.test(window)
}

/**
 * Parse quota groups (language server RetrieveUserQuotaSummary or Cloud Code
 * retrieveUserQuota) into per-family 5h/weekly buckets. Shared by both data
 * sources so the widget always has the same shape regardless of which source
 * answered.
 */
export function bucketsFromGroups(groups: unknown): {
  gemini5h?: BucketSnapshot
  geminiWeekly?: BucketSnapshot
  claude5h?: BucketSnapshot
  claudeWeekly?: BucketSnapshot
} {
  let gemini5h: BucketSnapshot | undefined
  let geminiWeekly: BucketSnapshot | undefined
  let claude5h: BucketSnapshot | undefined
  let claudeWeekly: BucketSnapshot | undefined

  if (!Array.isArray(groups)) return { gemini5h, geminiWeekly, claude5h, claudeWeekly }

  for (const group of groups) {
    if (!group || typeof group !== "object") continue
    const name = String((group as Record<string, unknown>).displayName || "").toLowerCase()
    const isGemini = name.includes("gemini")
    const isClaude = name.includes("claude") || name.includes("gpt")
    if (!isGemini && !isClaude) continue

    const buckets = (group as Record<string, unknown>).buckets
    if (!Array.isArray(buckets)) continue
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue
      const b = bucket as Record<string, unknown>
      if (typeof b.remainingFraction !== "number") continue
      const snapshot = bucketFromFraction(b.remainingFraction, b.resetTime)
      if (isGemini) {
        if (isFiveHourWindow(b.window)) gemini5h = snapshot
        if (isWeeklyWindow(b.window)) geminiWeekly = snapshot
      }
      if (isClaude) {
        if (isFiveHourWindow(b.window)) claude5h = snapshot
        if (isWeeklyWindow(b.window)) claudeWeekly = snapshot
      }
    }
  }

  return { gemini5h, geminiWeekly, claude5h, claudeWeekly }
}

/**
 * Stable single-format bucket line: always `5h%/weekly% (reset)`, with `—`
 * for a missing side, so the widget never changes shape when a source omits
 * weekly buckets or reset times.
 */
export function formatBucket(fiveHour?: BucketSnapshot, weekly?: BucketSnapshot, now = Date.now()): string | undefined {
  if (!fiveHour && !weekly) return undefined
  const fiveStr = fiveHour ? `${fiveHour.remainingPercent}%` : "—"
  const weeklyStr = weekly ? `${weekly.remainingPercent}%` : "—"
  const primary = fiveHour ?? weekly!
  const resetStr = primary.resetsAt ? ` (${formatResetDuration(primary.resetsAt, now)})` : ""
  return `${fiveStr}/${weeklyStr}${resetStr}`
}

function isBucketFresh(bucket: BucketSnapshot | undefined, now = Date.now()): boolean {
  if (!bucket) return false
  return bucket.resetsAt === undefined || bucket.resetsAt > now
}

/**
 * Carry over buckets the new snapshot is missing (e.g. Cloud API fallback
 * without weekly windows) from the previous snapshot while their reset time
 * is still in the future. Keeps the widget shape stable across source flips.
 */
export function mergeUsageSnapshots(
  prev: AntigravityUsageSnapshot | undefined,
  next: AntigravityUsageSnapshot,
  now = Date.now(),
): AntigravityUsageSnapshot {
  if (!prev || !next.configured) return next
  const pick = (n: BucketSnapshot | undefined, p: BucketSnapshot | undefined) =>
    n ?? (isBucketFresh(p, now) ? p : undefined)
  return {
    ...next,
    email: next.email ?? prev.email,
    plan: next.plan ?? prev.plan,
    tier: next.tier ?? prev.tier,
    gemini5h: pick(next.gemini5h, prev.gemini5h),
    geminiWeekly: pick(next.geminiWeekly, prev.geminiWeekly),
    claude5h: pick(next.claude5h, prev.claude5h),
    claudeWeekly: pick(next.claudeWeekly, prev.claudeWeekly),
    models: { ...prev.models, ...next.models },
  }
}

interface LocalLanguageServerInfo {
  port: number
  csrfToken: string
}

function detectLocalLanguageServer(): LocalLanguageServerInfo | undefined {
  try {
    const rawPids = execSync("pgrep -f language_server", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean)
    if (rawPids.length === 0) return undefined

    let csrfToken: string | undefined
    for (const pid of rawPids) {
      let args: string[] = []
      try {
        if (fs.existsSync(`/proc/${pid}/cmdline`)) {
          args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")
        } else {
          args = execSync(`ps -p ${pid} -o args=`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
            .trim()
            .split(/\s+/)
        }
      } catch {
        continue
      }

      const csrfIdx = args.indexOf("--csrf_token")
      if (csrfIdx !== -1 && args[csrfIdx + 1]) {
        csrfToken = args[csrfIdx + 1]
        break
      }
    }

    if (!csrfToken) return undefined

    const logPath = path.join(Global.Path.home, ".config", "Antigravity", "logs", "language_server.log")
    if (!fs.existsSync(logPath)) return undefined
    const stat = fs.statSync(logPath)
    const readSize = Math.min(stat.size, 64 * 1024)
    const buffer = Buffer.alloc(readSize)
    const fd = fs.openSync(logPath, "r")
    try {
      fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize))
    } finally {
      fs.closeSync(fd)
    }

    const logTail = buffer.toString("utf8")
    const matches = logTail.match(/at (\d+) for HTTP/g)
    if (!matches || matches.length === 0) return undefined
    const lastMatch = matches[matches.length - 1]
    const portMatch = lastMatch.match(/at (\d+) for HTTP/)
    if (!portMatch || !portMatch[1]) return undefined
    const port = parseInt(portMatch[1], 10)

    return { port, csrfToken }
  } catch {
    return undefined
  }
}

async function loadFromLanguageServer(info: LocalLanguageServerInfo): Promise<AntigravityUsageSnapshot> {
  const headers = {
    "Content-Type": "application/json",
    "x-codeium-csrf-token": info.csrfToken,
  }

  const [userRes, quotaRes, modelsRes] = await Promise.all([
    fetch(`http://127.0.0.1:${info.port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
      method: "POST",
      headers,
      body: "{}",
    }).catch(() => undefined),
    fetch(`http://127.0.0.1:${info.port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`, {
      method: "POST",
      headers,
      body: "{}",
    }).catch(() => undefined),
    fetch(`http://127.0.0.1:${info.port}/exa.language_server_pb.LanguageServerService/GetAvailableModels`, {
      method: "POST",
      headers,
      body: "{}",
    }).catch(() => undefined),
  ])

  const user = userRes?.ok ? ((await userRes.json()) as any) : undefined
  const quota = quotaRes?.ok ? ((await quotaRes.json()) as any) : undefined
  const models = modelsRes?.ok ? ((await modelsRes.json()) as any) : undefined

  const email = user?.userStatus?.email
  const plan =
    user?.userStatus?.planStatus?.planInfo?.planName ||
    user?.userStatus?.userTier?.name ||
    user?.userStatus?.userTier?.id
  const tier = user?.userStatus?.userTier?.name

  const { gemini5h, geminiWeekly, claude5h, claudeWeekly } = bucketsFromGroups(quota?.response?.groups)

  const modelSnapshots: Record<string, BucketSnapshot> = {}
  for (const [id, m] of Object.entries((models?.response?.models || {}) as Record<string, any>)) {
    const q = m?.quotaInfo
    if (q && typeof q.remainingFraction === "number") {
      const remainingPercent = Math.round(q.remainingFraction * 1000) / 10
      const usedPercent = Math.round((1 - q.remainingFraction) * 1000) / 10
      const resetsAt = q.resetTime ? Date.parse(q.resetTime) : undefined
      modelSnapshots[id] = {
        remainingPercent,
        usedPercent,
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
      }
    }
  }

  return {
    configured: true,
    email,
    plan,
    tier,
    gemini5h,
    geminiWeekly,
    claude5h,
    claudeWeekly,
    models: modelSnapshots,
  }
}

async function loadFromCloudCodeApi(auth: ResolvedAntigravityAuth): Promise<AntigravityUsageSnapshot> {
  const headers = {
    Authorization: `Bearer ${auth.access}`,
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/2.16.0 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": '{"ideType":"ANTIGRAVITY","platform":"LINUX","pluginType":"GEMINI"}',
  }

  const body = JSON.stringify({ project: auth.projectId || "aicode-consumers" })

  const [modelsRes, quotaRes] = await Promise.all([
    fetch("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
      method: "POST",
      headers,
      body,
    }).catch(() => undefined),
    fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers,
      body,
    }).catch(() => undefined),
  ])

  const modelsJson = modelsRes?.ok ? ((await modelsRes.json()) as any) : undefined
  const quotaJson = quotaRes?.ok ? ((await quotaRes.json()) as any) : undefined

  // Primary: quota groups carry 5h + weekly buckets with reset times.
  // retrieveUserQuota may wrap them as response.groups or plain groups.
  const grouped = bucketsFromGroups(quotaJson?.response?.groups ?? quotaJson?.groups)
  let { gemini5h, geminiWeekly, claude5h, claudeWeekly } = grouped

  const modelSnapshots: Record<string, BucketSnapshot> = {}
  let geminiMin: { rem: number; resetTime?: unknown } | undefined
  let claudeMin: { rem: number; resetTime?: unknown } | undefined

  for (const [id, m] of Object.entries((modelsJson?.models || {}) as Record<string, any>)) {
    const q = m?.quotaInfo
    if (q && typeof q.remainingFraction === "number") {
      const rem = q.remainingFraction
      modelSnapshots[id] = bucketFromFraction(rem, q.resetTime)

      const lower = id.toLowerCase()
      if (lower.includes("claude") || lower.includes("gpt")) {
        if (!claudeMin || rem < claudeMin.rem) claudeMin = { rem, resetTime: q.resetTime }
      } else if (lower.includes("gemini")) {
        if (!geminiMin || rem < geminiMin.rem) geminiMin = { rem, resetTime: q.resetTime }
      }
    }
  }

  // Fallback for families the quota groups did not cover. Never synthesize
  // 100%: when there is no data at all the bucket stays undefined and the
  // sticky merge in getAntigravityUsage keeps the last known value.
  if (!gemini5h && geminiMin) gemini5h = bucketFromFraction(geminiMin.rem, geminiMin.resetTime)
  if (!claude5h && claudeMin) claude5h = bucketFromFraction(claudeMin.rem, claudeMin.resetTime)

  return {
    configured: true,
    email: auth.email,
    plan: "Google AI Pro",
    gemini5h,
    geminiWeekly,
    claude5h,
    claudeWeekly,
    models: modelSnapshots,
  }
}

async function loadAntigravityUsage(): Promise<AntigravityUsageSnapshot> {
  const lsInfo = detectLocalLanguageServer()
  if (lsInfo) {
    const usage = await loadFromLanguageServer(lsInfo).catch(() => undefined)
    if (usage) return usage
  }

  const auth = await resolveAntigravityAuth()
  if (auth) {
    const usage = await loadFromCloudCodeApi(auth).catch(() => undefined)
    if (usage) return usage
  }

  return { configured: false }
}

export async function getAntigravityUsage(force = false): Promise<AntigravityUsageSnapshot> {
  if (!force && cached && Date.now() - cached.time < cacheTTL) return cached.value
  if (!force && inflight) return inflight

  inflight = loadAntigravityUsage()
    .then((value) => {
      // Sticky merge: a degraded source (e.g. Cloud API fallback without
      // weekly buckets) must not wipe buckets a richer source reported.
      const merged = mergeUsageSnapshots(cached?.value, value)
      cached = { time: Date.now(), value: merged }
      return merged
    })
    .catch(() => {
      // On failure keep the last known snapshot so the widget never flips to
      // an empty shape; only report unconfigured when we never had data.
      if (cached) return cached.value
      return { configured: false } satisfies AntigravityUsageSnapshot
    })
    .finally(() => {
      inflight = undefined
    })

  return inflight
}
