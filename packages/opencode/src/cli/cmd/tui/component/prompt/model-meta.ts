import { normalizeThinkingDisplay } from "../../context/thinking"

function normalizeMetaLabel(value: string | undefined) {
  if (!value) return
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized === "default") return
  return normalizeThinkingDisplay(normalized)
}

export function resolveVisibleVariantLabel(thinkingLabel: string | undefined, variantLabel: string | undefined) {
  if (!variantLabel) return
  const normalizedVariant = normalizeMetaLabel(variantLabel)
  if (!normalizedVariant) return variantLabel
  return normalizedVariant === normalizeMetaLabel(thinkingLabel) ? undefined : variantLabel
}
