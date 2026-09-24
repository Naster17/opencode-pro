type TextModel = {
  id: string
  providerID?: string
  api: {
    id: string
    npm: string
  }
  status: string
  capabilities: {
    input: {
      text: boolean
    }
    output: {
      text: boolean
    }
  }
}

const GOOGLE_TEXT_PREFIXES = ["gemini-", "gemma-", "learnlm-"]
const GOOGLE_GEMINI_TEXT_TIERS = ["pro", "flash", "flash-lite", "ultra"]
const GOOGLE_UNSUPPORTED_PARTS = [
  "antigravity",
  "aqa",
  "audio",
  "computer-use",
  "deep-research",
  "embedding",
  "image",
  "imagen",
  "live",
  "native-audio",
  "speech",
  "tts",
  "veo",
]

function hasPart(id: string, part: string) {
  return id === part || id.startsWith(`${part}-`) || id.endsWith(`-${part}`) || id.includes(`-${part}-`)
}

export function isGoogleModelIDCompatible(id: string) {
  const normalized = id.toLowerCase().replace(/^models\//, "")
  if (!GOOGLE_TEXT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false
  if (GOOGLE_UNSUPPORTED_PARTS.some((part) => hasPart(normalized, part))) return false
  if (!normalized.startsWith("gemini-")) return true
  return GOOGLE_GEMINI_TEXT_TIERS.some((tier) => hasPart(normalized, tier))
}

export function isSelectable(model: TextModel) {
  if (model.status === "deprecated") return false
  if (!model.capabilities.input.text || !model.capabilities.output.text) return false
  // Antigravity serves Claude and GPT-OSS through the Google-protocol envelope
  // (@ai-sdk/google), so their IDs are not gemini-like. They are registered
  // explicitly by the plugin and are always selectable.
  if (model.providerID === "antigravity") return true
  if (model.api.npm === "@ai-sdk/google") {
    return isGoogleModelIDCompatible(model.id) && isGoogleModelIDCompatible(model.api.id)
  }
  return true
}

export * as ModelCompat from "./model-compat"
