import type { ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"
import type { Config } from "@/config/config"
import * as Log from "@opencode-ai/core/util/log"
import { createHash } from "crypto"

const log = Log.create({ service: "cache-optimizer" })

function stableHashValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableHashValue)
  if (!value || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "providerOptions" && key !== "providerMetadata" && key !== "callProviderMetadata")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableHashValue(item)]),
  )
}

/**
 * Cache optimization utilities for reducing token usage through intelligent caching
 */

interface CacheStats {
  sessionID: string
  systemPromptHash: string
  conversationHash: string
  messageCount: number
  cacheableMessages: number
  lastCacheBreakpoint: number
  timestamp: number
}

// In-memory cache stats per session
const sessionCacheStats = new Map<string, CacheStats>()

/**
 * Compute a stable hash of system prompts to detect when they change
 * This helps identify cache invalidation causes
 */
export function hashSystemPrompt(messages: ModelMessage[]): string {
  const systemMessages = messages
    .filter((msg) => msg.role === "system")
    .map((msg) => (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)))
    .join("\n")

  return createHash("sha256").update(systemMessages).digest("hex").slice(0, 16)
}

/**
 * Compute a stable hash of conversation history to detect when old messages change
 * This is critical because OpenCode's prune() function can modify old tool parts
 * by setting compacted timestamps, which invalidates the cache
 */
export function hashConversationHistory(messages: ModelMessage[]): string {
  // Hash only non-system messages (conversation history)
  const conversationMessages = messages
    .filter((msg) => msg.role !== "system")
    .map((msg) => {
      const role = msg.role
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(stableHashValue(msg.content))
      return `${role}:${content}`
    })
    .join("|")

  return createHash("sha256").update(conversationMessages).digest("hex").slice(0, 16)
}

/**
 * Analyze message history to determine optimal cache breakpoints
 * Returns indices where cache control should be applied
 */
export function computeCacheBreakpoints(
  messages: ModelMessage[],
  options: {
    interval?: number
    minMessages?: number
    config?: Config.Info
  } = {},
): number[] {
  const config = options.config
  const cachingEnabled = config?.caching?.enabled ?? true

  if (!cachingEnabled) {
    return []
  }

  const interval = config?.caching?.breakpoint_interval ?? options.interval ?? 10
  const minMessages = config?.caching?.min_messages ?? options.minMessages ?? 5

  const nonSystemMessages = messages.filter((msg) => msg.role !== "system")

  // Don't cache if conversation is too short
  if (nonSystemMessages.length < minMessages) {
    return []
  }

  // Find last user message to exclude current turn from caching
  let lastUserIndex = -1
  for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
    if (nonSystemMessages[i].role === "user") {
      lastUserIndex = i
      break
    }
  }

  if (lastUserIndex <= 0) {
    return []
  }

  // Create breakpoints at regular intervals
  const breakpoints: number[] = []
  for (let i = interval - 1; i < lastUserIndex; i += interval) {
    breakpoints.push(i)
  }

  // Always add the last cacheable message as a breakpoint
  if (breakpoints[breakpoints.length - 1] !== lastUserIndex - 1) {
    breakpoints.push(lastUserIndex - 1)
  }

  return breakpoints
}

/**
 * Track cache statistics for a session
 */
export function trackCacheStats(input: { sessionID: string; messages: ModelMessage[]; breakpoints: number[] }): void {
  const systemHash = hashSystemPrompt(input.messages)
  const conversationHash = hashConversationHistory(input.messages)
  const nonSystemCount = input.messages.filter((msg) => msg.role !== "system").length

  const existing = sessionCacheStats.get(input.sessionID)

  // Detect system prompt changes (cache invalidation)
  if (existing && existing.systemPromptHash !== systemHash) {
    log.warn("system prompt changed - cache invalidated", {
      sessionID: input.sessionID,
      oldHash: existing.systemPromptHash,
      newHash: systemHash,
    })
  }

  // Detect conversation history changes (e.g., from prune() modifying old tool parts)
  // This is a CRITICAL issue: prune() sets compacted timestamps on old messages
  if (existing && existing.conversationHash !== conversationHash && nonSystemCount === existing.messageCount) {
    log.warn("conversation history modified - cache invalidated (likely from prune)", {
      sessionID: input.sessionID,
      messageCount: nonSystemCount,
      oldHash: existing.conversationHash,
      newHash: conversationHash,
      reason: "Old messages were modified (e.g., tool output pruning)",
    })
  }

  // Detect message count jumps (potential compaction)
  if (existing && nonSystemCount < existing.messageCount) {
    log.info("message count decreased - compaction detected", {
      sessionID: input.sessionID,
      oldCount: existing.messageCount,
      newCount: nonSystemCount,
    })
  }

  const stats: CacheStats = {
    sessionID: input.sessionID,
    systemPromptHash: systemHash,
    conversationHash,
    messageCount: nonSystemCount,
    cacheableMessages: input.breakpoints.length > 0 ? input.breakpoints[input.breakpoints.length - 1] + 1 : 0,
    lastCacheBreakpoint: input.breakpoints[input.breakpoints.length - 1] ?? -1,
    timestamp: Date.now(),
  }

  sessionCacheStats.set(input.sessionID, stats)

  log.debug("cache stats updated", {
    sessionID: input.sessionID,
    messageCount: stats.messageCount,
    cacheableMessages: stats.cacheableMessages,
    breakpoints: input.breakpoints.length,
  })
}

/**
 * Get cache statistics for a session
 */
export function getCacheStats(sessionID: string): CacheStats | undefined {
  return sessionCacheStats.get(sessionID)
}

/**
 * Clear cache statistics for a session (e.g., after session ends)
 */
export function clearCacheStats(sessionID: string): void {
  sessionCacheStats.delete(sessionID)
}

/**
 * Estimate potential token savings from caching
 * This is a rough estimate based on message count and typical token sizes
 */
export function estimateTokenSavings(input: {
  totalMessages: number
  cacheableMessages: number
  avgTokensPerMessage?: number
}): {
  potentialSavings: number
  cacheHitRate: number
} {
  const { totalMessages, cacheableMessages, avgTokensPerMessage = 500 } = input

  if (totalMessages === 0) {
    return { potentialSavings: 0, cacheHitRate: 0 }
  }

  const cacheHitRate = cacheableMessages / totalMessages
  const potentialSavings = cacheableMessages * avgTokensPerMessage * 0.9 // 90% savings on cached tokens

  return {
    potentialSavings: Math.floor(potentialSavings),
    cacheHitRate: Math.round(cacheHitRate * 100) / 100,
  }
}

/**
 * Optimize system prompt stability by normalizing dynamic content
 * This helps maintain cache hits across requests
 */
export function normalizeSystemPrompt(content: string, config?: Config.Info): string {
  const normalizeDates = config?.caching?.normalize_dates ?? true

  if (!normalizeDates) {
    return content
  }

  // Normalize date formats to stable daily values
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const stableDate = today.toDateString()

  // Replace various date formats with stable version
  return content
    .replace(/Today's date: .+$/gm, `Today's date: ${stableDate}`)
    .replace(/Current date: \d{4}-\d{2}-\d{2}/g, `Current date: ${today.toISOString().slice(0, 10)}`)
    .replace(/Date: .+$/gm, `Date: ${stableDate}`)
}

/**
 * Check if a model supports prompt caching
 */
export function supportsCaching(model: Provider.Model): boolean {
  // Anthropic models support prompt caching
  if (
    model.providerID === "anthropic" ||
    model.providerID === "google-vertex-anthropic" ||
    model.api.npm === "@ai-sdk/anthropic" ||
    model.api.npm === "@ai-sdk/google-vertex/anthropic"
  ) {
    return true
  }

  // Bedrock supports caching
  if (model.providerID.includes("bedrock") || model.api.npm === "@ai-sdk/amazon-bedrock") {
    return true
  }

  // OpenRouter supports caching for some models
  if (model.api.npm === "@openrouter/ai-sdk-provider") {
    return true
  }

  // GitHub Copilot supports caching
  if (model.api.npm === "@ai-sdk/github-copilot") {
    return true
  }

  // Alibaba supports caching
  if (model.api.npm === "@ai-sdk/alibaba") {
    return true
  }

  // OpenAI-compatible providers may support caching
  if (model.api.npm === "@ai-sdk/openai-compatible") {
    return true
  }

  return false
}

export function shouldStripProviderMetadata(model: Provider.Model, config?: Config.Info): boolean {
  return (
    config?.caching?.strip_provider_metadata ??
    (model.providerID === "llama.cpp" && model.api.npm === "@ai-sdk/openai-compatible")
  )
}

export function shouldInlineReasoning(model: Provider.Model, config?: Config.Info): boolean {
  return (
    config?.caching?.inline_reasoning ??
    (model.providerID === "llama.cpp" && model.api.npm === "@ai-sdk/openai-compatible" && model.capabilities.reasoning)
  )
}

/**
 * Log cache performance metrics
 */
export function logCacheMetrics(input: {
  sessionID: string
  model: Provider.Model
  messages: ModelMessage[]
  breakpoints: number[]
  config?: Config.Info
}): void {
  const logMetrics = input.config?.caching?.log_metrics ?? false

  if (!logMetrics || !supportsCaching(input.model)) {
    return
  }

  const stats = getCacheStats(input.sessionID)
  const nonSystemCount = input.messages.filter((msg) => msg.role !== "system").length
  const savings = estimateTokenSavings({
    totalMessages: nonSystemCount,
    cacheableMessages: input.breakpoints.length > 0 ? input.breakpoints[input.breakpoints.length - 1] + 1 : 0,
  })

  log.info("cache metrics", {
    sessionID: input.sessionID,
    modelID: input.model.id,
    providerID: input.model.providerID,
    totalMessages: nonSystemCount,
    cacheableMessages: savings.cacheHitRate * nonSystemCount,
    breakpoints: input.breakpoints.length,
    estimatedSavings: savings.potentialSavings,
    cacheHitRate: `${(savings.cacheHitRate * 100).toFixed(1)}%`,
    systemPromptStable: stats ? "yes" : "unknown",
  })
}

export * as CacheOptimizer from "./cache-optimizer"
