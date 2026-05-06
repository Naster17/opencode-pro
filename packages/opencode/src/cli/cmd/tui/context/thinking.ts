export const THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
export type ThinkingState = ThinkingLevel | "thinking" | "inherit"

export function normalizeThinkingLevel(value: string | undefined) {
  if (!value) return
  if (["none", "off", "disabled"].includes(value)) return "off" as const
  if (["minimal", "low"].includes(value)) return "low" as const
  if (value === "medium") return "medium" as const
  if (value === "high") return "high" as const
  if (value === "xhigh") return "xhigh" as const
  if (value === "max") return "max" as const
  if (value === "thinking") return "thinking" as const
  if (["on", "enabled", "adaptive"].includes(value)) return "high" as const
}

export function normalizeThinkingDisplay(value: string | undefined) {
  if (!value) return
  const normalized = value.trim().toLowerCase()
  return normalizeThinkingLevel(normalized)
}

const THINKING_VARIANT_ORDER = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "thinking"]

export function compareThinkingVariantOrder(left: string, right: string) {
  const leftIndex = THINKING_VARIANT_ORDER.indexOf(left.trim().toLowerCase())
  const rightIndex = THINKING_VARIANT_ORDER.indexOf(right.trim().toLowerCase())
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1
    if (rightIndex === -1) return -1
    return leftIndex - rightIndex
  }
  return 0
}
