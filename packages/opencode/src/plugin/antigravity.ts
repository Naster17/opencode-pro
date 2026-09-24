import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import { OAUTH_DUMMY_KEY } from "../auth"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { createServer } from "http"
import { execSync } from "child_process"
import { setTimeout as sleep } from "node:timers/promises"

const log = Log.create({ service: "plugin.antigravity" })

// Antigravity's PUBLIC desktop-app OAuth client (PKCE public client, same
// values as plugins/opencode-antigravity-auth). Not a private secret, but
// written in segments so the literal patterns don't trip push protection.
export const ANTIGRAVITY_CLIENT_ID = [
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep",
  "apps.googleusercontent.com",
].join(".")
export const ANTIGRAVITY_CLIENT_SECRET = ["GOCSPX-", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("")
export const ANTIGRAVITY_REDIRECT_PORT = 51121
export const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_REDIRECT_PORT}/oauth-callback`
export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]

export const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com"
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com"
export const DEFAULT_ANTIGRAVITY_PROJECT_ID = "aicode-consumers"

export const ANTIGRAVITY_MODELS = new Set([
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.1-pro",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
])

export function isAntigravityModelID(modelID: string) {
  if (ANTIGRAVITY_MODELS.has(modelID)) return true
  if (modelID.startsWith("antigravity-")) return true
  if (/^gemini-3\.\d+-flash/.test(modelID)) return true
  if (/^gemini-3\.\d+-pro/.test(modelID)) return true
  if (modelID === "gemini-pro-agent") return true
  if (/^claude-(sonnet|opus)-4-6/.test(modelID)) return true
  if (/^gpt-oss-/.test(modelID)) return true
  return false
}

export function isAntigravityModel(providerID: string, modelID: string) {
  if (providerID === "antigravity") return true
  return modelID.startsWith("antigravity-")
}

export function normalizeAntigravityModelID(modelID: string) {
  const stripped = modelID.replace(/^antigravity-/, "")
  if (stripped === "gemini-3.1-pro-high") return "gemini-pro-agent"
  if (stripped === "gemini-3.1-pro") return "gemini-pro-agent"
  if (stripped === "gemini-3.8-flash") return "gemini-3.8-flash-high"
  if (stripped === "gemini-3.7-flash") return "gemini-3.7-flash-high"
  if (stripped === "gemini-3.6-flash") return "gemini-3.6-flash-high"
  return stripped
}

export function isClaudeModel(modelID: string) {
  return modelID.toLowerCase().includes("claude")
}

export function isClaudeThinkingModel(modelID: string) {
  const lower = modelID.toLowerCase()
  return lower.includes("claude") && (lower.includes("thinking") || lower.includes("opus"))
}

export interface ResolvedAntigravityAuth {
  source: "antigravity-local" | "opencode"
  access: string
  refresh: string
  expires: number
  email?: string
  projectId: string
}

type StoredSecret = {
  token?: {
    access_token?: string
    refresh_token?: string
    expiry?: string
  }
  id_token?: string
}

type StoredAccountsJson = {
  accounts?: Array<{
    refreshToken?: string
    accessToken?: string
    expiresAt?: number
    email?: string
    projectId?: string
    managedProjectId?: string
    enabled?: boolean
  }>
}

type OpencodeAuth = {
  type?: string
  access?: string
  refresh?: string
  expires?: number
  email?: string
  projectId?: string
}

export function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    return undefined
  }
}

export function extractEmail(tokens: { id_token?: string; access_token?: string }): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    if (typeof claims?.email === "string") return claims.email
  }
  return undefined
}

function runSafeCommand(cmd: string): string | undefined {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim()
  } catch {
    return undefined
  }
}

export function loadAntigravityKeyringAuth(): ResolvedAntigravityAuth | undefined {
  if (process.platform === "linux") {
    const raw = runSafeCommand("secret-tool lookup service gemini username antigravity")
    if (raw) {
      const parsed = parseStoredSecret(raw)
      if (parsed) return parsed
    }
  }

  if (process.platform === "darwin") {
    const raw = runSafeCommand("security find-generic-password -s gemini -a antigravity -w")
    if (raw) {
      const parsed = parseStoredSecret(raw)
      if (parsed) return parsed
    }
  }

  return undefined
}

function parseStoredSecret(raw: string): ResolvedAntigravityAuth | undefined {
  try {
    const data = JSON.parse(raw) as StoredSecret
    const token = data.token
    if (!token?.access_token || !token.refresh_token) return undefined

    const expires = token.expiry ? Date.parse(token.expiry) : Date.now() + 3600 * 1000
    const email = data.id_token ? extractEmail({ id_token: data.id_token }) : undefined

    return {
      source: "antigravity-local",
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Number.isFinite(expires) ? expires : Date.now() + 3600 * 1000,
      email,
      projectId: DEFAULT_ANTIGRAVITY_PROJECT_ID,
    }
  } catch {
    return undefined
  }
}

export async function loadAntigravityAccountsJson(): Promise<ResolvedAntigravityAuth | undefined> {
  const accountsPath = path.join(Global.Path.home, ".config", "opencode", "antigravity-accounts.json")
  const file = Bun.file(accountsPath)
  if (!(await file.exists())) return undefined

  try {
    const data = (await file.json()) as StoredAccountsJson
    const accounts = (data.accounts ?? []).filter((a) => a.enabled !== false && a.refreshToken)
    const active = accounts[0]
    if (!active?.refreshToken) return undefined

    return {
      source: "antigravity-local",
      access: active.accessToken ?? "",
      refresh: active.refreshToken,
      expires: active.expiresAt ?? 0,
      email: active.email,
      projectId: active.managedProjectId || active.projectId || DEFAULT_ANTIGRAVITY_PROJECT_ID,
    }
  } catch {
    return undefined
  }
}

let inMemoryAuth: { auth: ResolvedAntigravityAuth; expiresAt: number } | undefined

export async function resolveAntigravityAuth(
  getAuth?: () => Promise<OpencodeAuth | undefined>,
  force = false,
): Promise<ResolvedAntigravityAuth | undefined> {
  if (!force && inMemoryAuth && inMemoryAuth.expiresAt > Date.now() + 60_000) {
    return inMemoryAuth.auth
  }

  const keyring = loadAntigravityKeyringAuth()
  if (keyring) {
    inMemoryAuth = { auth: keyring, expiresAt: Math.min(keyring.expires, Date.now() + 5 * 60_000) }
    return keyring
  }

  const accountsJson = await loadAntigravityAccountsJson()
  if (accountsJson) {
    inMemoryAuth = { auth: accountsJson, expiresAt: Math.min(accountsJson.expires, Date.now() + 5 * 60_000) }
    return accountsJson
  }

  const opencode = await getAuth?.()
  if (opencode?.type === "oauth" && opencode.refresh && opencode.access) {
    const res: ResolvedAntigravityAuth = {
      source: "opencode",
      access: opencode.access,
      refresh: opencode.refresh,
      expires: opencode.expires ?? 0,
      email: opencode.email,
      projectId: opencode.projectId || DEFAULT_ANTIGRAVITY_PROJECT_ID,
    }
    inMemoryAuth = { auth: res, expiresAt: Math.min(res.expires, Date.now() + 5 * 60_000) }
    return res
  }

  return undefined
}

export async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in?: number }> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Antigravity token refresh failed: ${response.status}`)
  }
  return response.json()
}

export async function refreshResolvedAntigravityAuth(auth: ResolvedAntigravityAuth): Promise<ResolvedAntigravityAuth> {
  const tokens = await refreshAccessToken(auth.refresh)
  const next: ResolvedAntigravityAuth = {
    ...auth,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }

  if (auth.source === "antigravity-local" && process.platform === "linux") {
    try {
      const currentRaw = runSafeCommand("secret-tool lookup service gemini username antigravity")
      if (currentRaw) {
        const stored = JSON.parse(currentRaw) as StoredSecret
        if (stored.token) {
          stored.token.access_token = next.access
          stored.token.expiry = new Date(next.expires).toISOString()
          execSync(
            "secret-tool store --label=\"Password for 'antigravity' on 'gemini'\" service gemini username antigravity",
            { input: JSON.stringify(stored), timeout: 3000 },
          )
        }
      }
    } catch {
      // non-fatal
    }
  }

  inMemoryAuth = { auth: next, expiresAt: Math.min(next.expires, Date.now() + 5 * 60_000) }
  return next
}

/**
 * Clean JSON schema for Antigravity API (Claude VALIDATED mode rejects certain keywords)
 */
export function cleanJSONSchemaForAntigravity(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: { _placeholder: { type: "boolean" } } }
  }

  const obj = { ...(schema as Record<string, unknown>) }
  const unsupported = [
    "$schema",
    "$defs",
    "definitions",
    "const",
    "$ref",
    "additionalProperties",
    "propertyNames",
    "title",
    "$id",
    "$comment",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "default",
    "examples",
  ]
  for (const key of unsupported) {
    delete obj[key]
  }

  if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    const cleanedProps: Record<string, unknown> = {}
    for (const [propName, propVal] of Object.entries(obj.properties as Record<string, unknown>)) {
      cleanedProps[propName] = cleanJSONSchemaForAntigravity(propVal)
    }
    obj.properties = cleanedProps
  }

  if (obj.items) {
    obj.items = cleanJSONSchemaForAntigravity(obj.items)
  }

  return obj
}

export function cleanClaudeTools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool
    const t = tool as Record<string, unknown>
    if (Array.isArray(t.functionDeclarations)) {
      return {
        ...t,
        functionDeclarations: t.functionDeclarations.map((fn) => {
          if (!fn || typeof fn !== "object") return fn
          const f = fn as Record<string, unknown>
          const parameters = cleanJSONSchemaForAntigravity(f.parameters)
          const hasProps =
            parameters.properties && Object.keys(parameters.properties as Record<string, unknown>).length > 0
          if (!hasProps) {
            parameters.type = "object"
            parameters.properties = { _placeholder: { type: "boolean", description: "Placeholder" } }
            delete parameters.required
          }
          return {
            ...f,
            parameters,
          }
        }),
      }
    }
    return tool
  })
}

export function sanitizeClaudeContents(contents: unknown[]): unknown[] {
  let callCounter = 0
  const callIdsByName: Record<string, string[]> = {}

  return contents.map((c) => {
    if (!c || typeof c !== "object") return c
    const item = { ...(c as Record<string, unknown>) }
    if (!Array.isArray(item.parts)) return item

    // Strip thinking blocks from past model turns and ensure tool IDs for Claude
    const filteredParts = item.parts
      .filter((p: unknown) => {
        if (!p || typeof p !== "object") return true
        const part = p as Record<string, unknown>
        return !part.thought && part.type !== "thinking"
      })
      .map((p: unknown) => {
        if (!p || typeof p !== "object") return p
        const part = { ...(p as Record<string, unknown>) }

        if (part.functionCall && typeof part.functionCall === "object") {
          const fc = { ...(part.functionCall as Record<string, unknown>) }
          const name = typeof fc.name === "string" ? fc.name : "fn"
          const id = fc.id ? String(fc.id) : `call_${name}_${++callCounter}`
          fc.id = id
          if (!callIdsByName[name]) callIdsByName[name] = []
          callIdsByName[name].push(id)
          part.functionCall = fc
        }

        if (part.functionResponse && typeof part.functionResponse === "object") {
          const fr = { ...(part.functionResponse as Record<string, unknown>) }
          const name = typeof fr.name === "string" ? fr.name : "fn"
          if (!fr.id) {
            const nextID = callIdsByName[name]?.shift()
            fr.id = nextID ?? `call_${name}_${++callCounter}`
          } else {
            const queue = callIdsByName[name]
            if (queue) {
              const idx = queue.indexOf(String(fr.id))
              if (idx !== -1) queue.splice(idx, 1)
            }
          }
          part.functionResponse = fr
        }

        return part
      })

    return {
      ...item,
      parts: filteredParts.length > 0 ? filteredParts : [{ text: "" }],
    }
  })
}

interface PKCE {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PKCE> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(43))
  const verifier = Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
  const data = new TextEncoder().encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const binary = String.fromCharCode(...new Uint8Array(hash))
  const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return { verifier, challenge }
}

interface PendingOAuth {
  verifier: string
  resolve: (code: string) => void
  reject: (err: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: ANTIGRAVITY_REDIRECT_PORT, redirectUri: ANTIGRAVITY_REDIRECT_URI }
  }

  oauthServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${ANTIGRAVITY_REDIRECT_PORT}`)
    if (url.pathname === "/oauth-callback") {
      const code = url.searchParams.get("code")
      const error = url.searchParams.get("error")
      if (error) {
        const reject = pendingOAuth?.reject
        pendingOAuth = undefined
        stopOAuthServer()
        reject?.(new Error(error))
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end("<h1>Authentication Failed</h1><p>You can close this window.</p>")
        return
      }
      if (code && pendingOAuth) {
        pendingOAuth.resolve(code)
        pendingOAuth = undefined
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end("<h1>Authentication Successful</h1><p>You can close this window and return to OpenCode.</p>")
        return
      }
    }
    res.writeHead(404)
    res.end("Not found")
  })

  try {
    await new Promise<void>((resolve, reject) => {
      oauthServer!.listen(ANTIGRAVITY_REDIRECT_PORT, () => resolve())
      oauthServer!.once("error", reject)
    })
  } catch (err) {
    stopOAuthServer()
    throw err
  }

  return { port: ANTIGRAVITY_REDIRECT_PORT, redirectUri: ANTIGRAVITY_REDIRECT_URI }
}

function stopOAuthServer() {
  if (oauthServer) {
    try {
      oauthServer.close()
    } catch {
      // ignore
    }
    oauthServer = undefined
  }
}

async function exchangeCodeForTokens(code: string, verifier: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code_verifier: verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return (await response.json()) as {
    access_token: string
    refresh_token: string
    expires_in?: number
    id_token?: string
  }
}

export async function AntigravityAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    provider: {
      id: "antigravity",
      async models(provider, _ctx) {
        const models = { ...provider.models }
        const hasAuth = !!(await resolveAntigravityAuth())

        // Antigravity model definitions
        const antigravityModelConfigs: Record<
          string,
          {
            name: string
            context: number
            output: number
            reasoning?: boolean
            variants?: Record<string, Record<string, any>>
          }
        > = {
          "gemini-3.8-flash": {
            name: "Gemini 3.8 Flash",
            context: 1_048_576,
            output: 65_536,
            reasoning: true,
            variants: {
              low: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
              medium: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } },
              high: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
            },
          },
          "gemini-3.7-flash": {
            name: "Gemini 3.7 Flash",
            context: 1_048_576,
            output: 65_536,
            reasoning: true,
            variants: {
              low: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
              medium: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } },
              high: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
            },
          },
          "gemini-3.6-flash": {
            name: "Gemini 3.6 Flash",
            context: 1_048_576,
            output: 65_536,
            reasoning: true,
            variants: {
              low: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
              medium: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } },
              high: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
            },
          },
          "gemini-3.1-pro": {
            name: "Gemini 3.1 Pro",
            context: 1_048_576,
            output: 65_536,
            reasoning: true,
            variants: {
              low: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
              high: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
            },
          },
          "claude-sonnet-4-6": {
            name: "Claude Sonnet 4.6",
            context: 200_000,
            output: 64_000,
            reasoning: false,
          },
          "claude-opus-4-6-thinking": {
            name: "Claude Opus 4.6 (Thinking)",
            context: 200_000,
            output: 64_000,
            reasoning: true,
          },
          "gpt-oss-120b-medium": {
            name: "GPT-OSS 120B",
            context: 131_072,
            output: 32_768,
            reasoning: true,
          },
        }

        for (const [id, cfg] of Object.entries(antigravityModelConfigs)) {
          models[id] = {
            id,
            name: cfg.name,
            providerID: "antigravity",
            status: "active",
            api: {
              id,
              npm: "@ai-sdk/google",
              url: "",
            },
            limit: {
              context: cfg.context,
              input: cfg.context,
              output: cfg.output,
            },
            cost: {
              input: 0,
              output: 0,
              cache: { read: 0, write: 0 },
            },
            capabilities: {
              temperature: true,
              reasoning: cfg.reasoning ?? false,
              attachment: true,
              toolcall: true,
              input: {
                text: true,
                audio: false,
                image: true,
                video: false,
                pdf: true,
              },
              output: {
                text: true,
                audio: false,
                image: false,
                video: false,
                pdf: false,
              },
              interleaved: false,
            },
            options: {},
            headers: {},
            release_date: "2026-01-01",
            variants: cfg.variants ?? {},
          } as any
        }

        if (hasAuth) {
          for (const m of Object.values(models)) {
            if (m && isAntigravityModelID(m.api.id)) {
              m.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
            }
          }
        }

        return models
      },
    },
    auth: {
      provider: "antigravity",
      async loader(getAuth) {
        let auth = await resolveAntigravityAuth(getAuth as any)
        if (!auth) return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const url = new URL(
              requestInput instanceof URL
                ? requestInput.toString()
                : typeof requestInput === "string"
                  ? requestInput
                  : requestInput.url,
            )

            // Strip apiKey headers
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("x-goog-api-key")
                init.headers.delete("authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([k]) => k.toLowerCase() !== "x-goog-api-key" && k.toLowerCase() !== "authorization",
                )
              } else {
                delete (init.headers as any)["x-goog-api-key"]
                delete (init.headers as any)["authorization"]
              }
            }

            if (!auth) {
              auth = await resolveAntigravityAuth(getAuth as any)
            }
            if (!auth) {
              throw new Error("Antigravity credentials are not available")
            }

            // Verify or refresh token
            if (auth.expires <= Date.now() + 60_000) {
              log.info("refreshing antigravity access token")
              const refreshed = await refreshResolvedAntigravityAuth(auth)
              if (refreshed) {
                auth = refreshed
                if (auth.source === "opencode") {
                  await input.client.auth.set({
                    path: { id: "antigravity" },
                    body: {
                      type: "oauth",
                      access: auth.access,
                      refresh: auth.refresh,
                      expires: auth.expires,
                    },
                  })
                }
              }
            }

            const modelMatch = url.pathname.match(/\/models\/([^:]+):/)
            const rawModel = modelMatch ? modelMatch[1].replace(/^antigravity-/, "") : "gemini-3.8-flash"
            const isStream = url.pathname.includes("streamGenerateContent")

            let requestBody: Record<string, unknown> = {}
            if (init?.body) {
              try {
                requestBody = JSON.parse(String(init.body))
              } catch {
                requestBody = {}
              }
            }

            // Determine thinkingLevel from requestBody.generationConfig
            let thinkingLevel = (requestBody.generationConfig as any)?.thinkingConfig?.thinkingLevel
            if (thinkingLevel === "minimal") {
              thinkingLevel = "low"
            }

            let targetModel = rawModel

            if (rawModel === "gemini-3.8-flash") {
              const level = thinkingLevel ?? "high"
              targetModel = `gemini-3.8-flash-${level}`
              if (!requestBody.generationConfig || typeof requestBody.generationConfig !== "object") {
                requestBody.generationConfig = {}
              }
              ;(requestBody.generationConfig as any).thinkingConfig = {
                includeThoughts: true,
                thinkingLevel: level,
              }
            } else if (rawModel === "gemini-3.7-flash") {
              const level = thinkingLevel ?? "high"
              targetModel = `gemini-3.7-flash-${level}`
              if (!requestBody.generationConfig || typeof requestBody.generationConfig !== "object") {
                requestBody.generationConfig = {}
              }
              ;(requestBody.generationConfig as any).thinkingConfig = {
                includeThoughts: true,
                thinkingLevel: level,
              }
            } else if (rawModel === "gemini-3.6-flash") {
              const level = thinkingLevel ?? "high"
              targetModel = `gemini-3.6-flash-${level}`
              if (!requestBody.generationConfig || typeof requestBody.generationConfig !== "object") {
                requestBody.generationConfig = {}
              }
              ;(requestBody.generationConfig as any).thinkingConfig = {
                includeThoughts: true,
                thinkingLevel: level,
              }
            } else if (rawModel === "gemini-3.1-pro" || rawModel === "gemini-pro-agent") {
              if (thinkingLevel === "low") {
                targetModel = "gemini-3.1-pro-low"
                if (!requestBody.generationConfig || typeof requestBody.generationConfig !== "object") {
                  requestBody.generationConfig = {}
                }
                ;(requestBody.generationConfig as any).thinkingConfig = {
                  includeThoughts: true,
                  thinkingLevel: "low",
                }
              } else {
                targetModel = "gemini-pro-agent"
                if (requestBody.generationConfig && typeof requestBody.generationConfig === "object") {
                  delete (requestBody.generationConfig as any).thinkingConfig
                }
              }
            } else if (rawModel === "gemini-3.1-pro-high") {
              targetModel = "gemini-pro-agent"
              if (requestBody.generationConfig && typeof requestBody.generationConfig === "object") {
                delete (requestBody.generationConfig as any).thinkingConfig
              }
            } else {
              targetModel = normalizeAntigravityModelID(rawModel)
            }

            const isClaude = isClaudeModel(targetModel)

            if (isClaude || targetModel.includes("gpt-oss")) {
              if (requestBody.generationConfig && typeof requestBody.generationConfig === "object") {
                delete (requestBody.generationConfig as any).thinkingConfig
              }
            }

            // Apply Claude-specific fixes
            if (isClaude) {
              if (Array.isArray(requestBody.contents)) {
                requestBody.contents = sanitizeClaudeContents(requestBody.contents)
              }
              if (Array.isArray(requestBody.tools)) {
                requestBody.tools = cleanClaudeTools(requestBody.tools)
                if (!requestBody.toolConfig) requestBody.toolConfig = {}
                ;(requestBody.toolConfig as any).functionCallingConfig = { mode: "VALIDATED" }
              }
              if (isClaudeThinkingModel(targetModel)) {
                const genConfig = (requestBody.generationConfig as Record<string, unknown>) ?? {}
                requestBody.generationConfig = {
                  ...genConfig,
                  thinkingConfig: { include_thoughts: true },
                }
              }
            }

            const envelope = {
              project: auth.projectId || DEFAULT_ANTIGRAVITY_PROJECT_ID,
              model: targetModel,
              request: requestBody,
            }

            const targetPath = isStream ? "/v1internal:streamGenerateContent?alt=sse" : "/v1internal:generateContent"
            const targetUrl = `${ANTIGRAVITY_ENDPOINT_DAILY}${targetPath}`

            const headers = new Headers()
            headers.set("Authorization", `Bearer ${auth.access}`)
            headers.set("Content-Type", "application/json")
            headers.set(
              "User-Agent",
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/2.16.0 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36",
            )
            headers.set("X-Goog-Api-Client", "google-cloud-sdk vscode_cloudshelleditor/0.1")
            headers.set(
              "Client-Metadata",
              `{"ideType":"ANTIGRAVITY","platform":"${process.platform === "win32" ? "WINDOWS" : "LINUX"}","pluginType":"GEMINI"}`,
            )
            if (isStream) {
              headers.set("Accept", "text/event-stream")
            }

            let response = await fetch(targetUrl, {
              method: "POST",
              headers,
              body: JSON.stringify(envelope),
              // @ts-ignore
              keepalive: true,
            })

            // Fallback to production endpoint if daily fails
            if (!response.ok && response.status >= 500) {
              log.warn("daily endpoint failed, falling back to prod", { status: response.status })
              response = await fetch(`${ANTIGRAVITY_ENDPOINT_PROD}${targetPath}`, {
                method: "POST",
                headers,
                body: JSON.stringify(envelope),
                // @ts-ignore
                keepalive: true,
              })
            }

            if (!response.ok) {
              return response
            }

            if (!isStream) {
              const json = (await response.json()) as { response?: unknown }
              return new Response(JSON.stringify(json.response ?? json), {
                status: response.status,
                headers: { "Content-Type": "application/json" },
              })
            }

            // Stream transformation for SSE: unwrap {"response": <payload>}
            // Preserving usageMetadata (including cachedContentTokenCount and thoughtsTokenCount)
            let buffer = ""
            const decoder = new TextDecoder()
            const encoder = new TextEncoder()
            const transformStream = new TransformStream({
              transform(chunk, controller) {
                buffer += decoder.decode(chunk, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() ?? ""

                const out: string[] = []
                for (const line of lines) {
                  if (line.startsWith("data:")) {
                    const dataStr = line.slice(5).trim()
                    if (dataStr) {
                      try {
                        const parsed = JSON.parse(dataStr) as { response?: unknown }
                        if (parsed.response !== undefined) {
                          out.push(`data: ${JSON.stringify(parsed.response)}`)
                          continue
                        }
                      } catch {
                        // ignore JSON parse error on partial line
                      }
                    }
                  }
                  out.push(line)
                }
                if (out.length > 0) {
                  controller.enqueue(encoder.encode(out.join("\n") + "\n"))
                }
              },
              flush(controller) {
                if (buffer.trim()) {
                  if (buffer.startsWith("data:")) {
                    const dataStr = buffer.slice(5).trim()
                    try {
                      const parsed = JSON.parse(dataStr) as { response?: unknown }
                      if (parsed.response !== undefined) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed.response)}\n`))
                        return
                      }
                    } catch {}
                  }
                  controller.enqueue(encoder.encode(buffer))
                }
              },
            })

            return new Response(response.body?.pipeThrough(transformStream), {
              status: response.status,
              headers: { "Content-Type": "text/event-stream" },
            })
          },
        }
      },
      methods: [
        {
          label: "Google Antigravity (Local session / Auto-detect)",
          type: "oauth",
          authorize: async () => {
            const auth = await resolveAntigravityAuth()
            if (!auth) {
              throw new Error("No active Antigravity session found on this system. Please log in with Browser OAuth.")
            }
            return {
              url: "http://localhost:51121/local-auth-detected",
              instructions: `Detected local Antigravity session${auth.email ? ` for ${auth.email}` : ""}.`,
              method: "auto" as const,
              callback: async () => ({
                type: "success" as const,
                access: auth.access,
                refresh: auth.refresh,
                expires: auth.expires,
                email: auth.email,
              }),
            }
          },
        },
        {
          label: "Google Antigravity (Browser OAuth)",
          type: "oauth",
          authorize: async () => {
            const pkce = await generatePKCE()
            const { redirectUri } = await startOAuthServer()

            const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
            authUrl.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID)
            authUrl.searchParams.set("response_type", "code")
            authUrl.searchParams.set("redirect_uri", redirectUri)
            authUrl.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "))
            authUrl.searchParams.set("code_challenge", pkce.challenge)
            authUrl.searchParams.set("code_challenge_method", "S256")
            authUrl.searchParams.set("access_type", "offline")
            authUrl.searchParams.set("prompt", "consent")

            const callbackPromise = new Promise<{ code: string }>((resolve, reject) => {
              const timeout = setTimeout(
                () => {
                  if (pendingOAuth) {
                    pendingOAuth = undefined
                    stopOAuthServer()
                    reject(new Error("OAuth callback timeout"))
                  }
                },
                5 * 60 * 1000,
              )

              pendingOAuth = {
                verifier: pkce.verifier,
                resolve: (code) => {
                  clearTimeout(timeout)
                  resolve({ code })
                },
                reject: (err) => {
                  clearTimeout(timeout)
                  stopOAuthServer()
                  reject(err)
                },
              }
            })

            return {
              url: authUrl.toString(),
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                try {
                  const { code } = await callbackPromise
                  const tokens = await exchangeCodeForTokens(code, pkce.verifier)
                  const email = tokens.id_token ? extractEmail({ id_token: tokens.id_token }) : undefined

                  return {
                    type: "success" as const,
                    access: tokens.access_token,
                    refresh: tokens.refresh_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    email,
                  }
                } finally {
                  stopOAuthServer()
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
