import path from "path"
import { Global } from "@opencode-ai/core/global"
import { extractAccountId, refreshAccessToken } from "@/plugin/codex"
import { Process, stop } from "@/util/process"

const authPath = path.join(Global.Path.data, "auth.json")
const codexAppServer = ["codex", "app-server", "--listen", "ws://127.0.0.1:0"]
const cacheTTL = 5 * 60 * 1000
const appServerTimeout = 10_000

type StoredAuth = {
  openai?: {
    type?: string
    access?: string
    refresh?: string
    expires?: number
    accountId?: string
  }
}

type JsonRpcResponse = {
  id?: string | number
  result?: unknown
  error?: {
    code?: number
    message?: string
  }
}

type AccountResponse = {
  account: { type: "chatgpt"; email: string } | { type: string } | null
}

type RateLimitResponse = {
  rateLimits: RateLimitSnapshot | null
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null
}

type RateLimitSnapshot = {
  primary: {
    usedPercent: number
    resetsAt: number | null
  } | null
}

type CodexAppServerAuth = {
  accessToken: string
  refreshToken: string
  accountId: string
  expires: number
}

export type CodexUsageSnapshot = {
  configured: boolean
  email?: string
  usedPercent?: number
  resetsAt?: number
}

let cached: { time: number; value: CodexUsageSnapshot } | undefined
let inflight: Promise<CodexUsageSnapshot> | undefined

async function readStoredAuth() {
  const file = Bun.file(authPath)
  if (!(await file.exists())) return
  return (await file.json()) as StoredAuth
}

async function writeStoredAuth(auth: StoredAuth) {
  await Bun.write(authPath, `${JSON.stringify(auth, null, 2)}\n`)
}

async function loadCodexAppServerAuth(): Promise<CodexAppServerAuth | undefined> {
  const stored = await readStoredAuth()
  if (stored?.openai?.type !== "oauth") return
  if (!stored.openai.access || !stored.openai.refresh || !stored.openai.accountId || !stored.openai.expires) return

  if (stored.openai.expires > Date.now()) {
    return {
      accessToken: stored.openai.access,
      refreshToken: stored.openai.refresh,
      accountId: stored.openai.accountId,
      expires: stored.openai.expires,
    }
  }

  const refreshed = await refreshAccessToken(stored.openai.refresh)
  const accountId = extractAccountId(refreshed) || stored.openai.accountId
  stored.openai.access = refreshed.access_token
  stored.openai.refresh = refreshed.refresh_token
  stored.openai.accountId = accountId
  stored.openai.expires = Date.now() + (refreshed.expires_in ?? 3600) * 1000
  await writeStoredAuth(stored)

  return {
    accessToken: stored.openai.access,
    refreshToken: stored.openai.refresh,
    accountId,
    expires: stored.openai.expires,
  }
}

function withTimeout<Value>(promise: Promise<Value>, ms: number, message: string) {
  return new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function startCodexAppServer() {
  const proc = Process.spawn(codexAppServer, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  const url = await withTimeout(
    new Promise<string>((resolve, reject) => {
      let output = ""

      const onData = (chunk: Buffer) => {
        output += chunk.toString()
        const match = output.match(/listening on:\s+(ws:\/\/\S+)/)
        if (match) resolve(match[1])
      }

      proc.stdout?.on("data", onData)
      proc.stderr?.on("data", onData)
      proc.once("error", reject)
      void proc.exited.then((code) => reject(new Error(`codex app-server exited with code ${code}`)))
    }),
    appServerTimeout,
    "Timed out starting codex app-server",
  )

  return { proc, url }
}

function callCodexAppServer(url: string, auth: CodexAppServerAuth) {
  return withTimeout(
    new Promise<CodexUsageSnapshot>((resolve, reject) => {
      const ws = new WebSocket(url)
      let nextID = 1
      let currentAuth = auth
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
      let settled = false

      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        for (const request of pending.values()) request.reject(error instanceof Error ? error : new Error(String(error)))
        pending.clear()
        ws.close()
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      const finish = (value: CodexUsageSnapshot) => {
        if (settled) return
        settled = true
        ws.close()
        resolve(value)
      }

      const send = (method: string, params: unknown) => {
        const id = nextID++
        ws.send(JSON.stringify({ id, method, params }))
        return new Promise<unknown>((resolve, reject) => {
          pending.set(id, { resolve, reject })
        })
      }

      ws.onopen = async () => {
        try {
          await send("initialize", {
            clientInfo: { name: "opencode", version: "0" },
            capabilities: {
              experimentalApi: true,
              optOutNotificationMethods: ["remoteControl/status/changed"],
            },
          })
          await send("account/login/start", {
            type: "chatgptAuthTokens",
            accessToken: currentAuth.accessToken,
            chatgptAccountId: currentAuth.accountId,
            chatgptPlanType: null,
          })
          const account = (await send("account/read", {
            proactivelyRefreshAuthTokens: false,
          })) as AccountResponse
          const rateLimits = (await send("account/rateLimits/read", {})) as RateLimitResponse
          finish(resolveCodexUsage(account, rateLimits))
        } catch (error) {
          fail(error)
        }
      }

      ws.onmessage = async (event) => {
        const message = JSON.parse(String(event.data)) as JsonRpcResponse & {
          method?: string
          params?: { previousAccountId?: string | null }
        }

        if (message.method === "account/chatgptAuthTokens/refresh" && message.id !== undefined) {
          try {
            const refreshed = await refreshAccessToken(currentAuth.refreshToken)
            currentAuth = {
              accessToken: refreshed.access_token,
              refreshToken: refreshed.refresh_token,
              accountId: extractAccountId(refreshed) || message.params?.previousAccountId || currentAuth.accountId,
              expires: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
            }
            const stored = await readStoredAuth()
            if (stored?.openai?.type === "oauth") {
              stored.openai.access = currentAuth.accessToken
              stored.openai.refresh = currentAuth.refreshToken
              stored.openai.accountId = currentAuth.accountId
              stored.openai.expires = currentAuth.expires
              await writeStoredAuth(stored)
            }
            ws.send(
              JSON.stringify({
                id: message.id,
                result: {
                  accessToken: currentAuth.accessToken,
                  chatgptAccountId: currentAuth.accountId,
                  chatgptPlanType: null,
                },
              }),
            )
          } catch (error) {
            fail(error)
          }
          return
        }

        if (message.id === undefined) return
        const request = pending.get(Number(message.id))
        if (!request) return
        pending.delete(Number(message.id))
        if (message.error) {
          request.reject(new Error(message.error.message || `Codex request failed: ${message.error.code}`))
          return
        }
        request.resolve(message.result)
      }

      ws.onerror = () => {
        fail(new Error("Failed to connect to codex app-server"))
      }

      ws.onclose = () => {
        if (!settled) fail(new Error("codex app-server connection closed"))
      }
    }),
    appServerTimeout,
    "Timed out reading Codex usage",
  )
}

export function resolveCodexUsage(account: AccountResponse, rateLimits: RateLimitResponse): CodexUsageSnapshot {
  const snapshot = rateLimits.rateLimitsByLimitId?.codex || rateLimits.rateLimits
  const email = account.account?.type === "chatgpt" && "email" in account.account ? account.account.email : undefined
  return {
    configured: true,
    email,
    usedPercent: snapshot?.primary?.usedPercent,
    resetsAt: snapshot?.primary?.resetsAt ?? undefined,
  }
}

export function formatResetDuration(resetsAt: number, now = Date.now()) {
  const totalMinutes = Math.max(0, Math.floor((resetsAt * 1000 - now) / 60_000))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  return `${days}d ${hours}h ${minutes}m`
}

async function loadCodexUsage(): Promise<CodexUsageSnapshot> {
  const auth = await loadCodexAppServerAuth()
  if (!auth) return { configured: false }

  const server = await startCodexAppServer()
  try {
    return await callCodexAppServer(server.url, auth)
  } finally {
    await stop(server.proc)
  }
}

export async function getCodexUsage(force = false): Promise<CodexUsageSnapshot> {
  if (!force && cached && Date.now() - cached.time < cacheTTL) return cached.value
  if (!force && inflight) return inflight

  inflight = loadCodexUsage()
    .then((value) => {
      cached = { time: Date.now(), value }
      return value
    })
    .catch(() => ({ configured: true } satisfies CodexUsageSnapshot))
    .finally(() => {
      inflight = undefined
    })

  return inflight
}
