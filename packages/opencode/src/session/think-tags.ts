const OPEN = "<think>"
const CLOSE = "</think>"
const TAG = /<\/?think>/gi

export type SplitState = {
  active: boolean
  pending: string
}

export type SplitPart = {
  type: "text" | "reasoning"
  text: string
}

export function strip(input: string) {
  return input.replace(TAG, "")
}

export function wrap(input: string) {
  return `<think>${strip(input)}</think>`
}

export function createStripper() {
  let pending = ""
  return {
    push(input: string) {
      const text = pending + input
      const hold = trailingTagPrefixLength(text)
      pending = hold ? text.slice(-hold) : ""
      return strip(hold ? text.slice(0, -hold) : text)
    },
    flush() {
      const result = strip(pending)
      pending = ""
      return result
    },
  }
}

export function split(state: SplitState, input: string): SplitPart[] {
  const text = state.pending + input
  const hold = trailingTagPrefixLength(text)
  state.pending = hold ? text.slice(-hold) : ""
  let remaining = hold ? text.slice(0, -hold) : text
  const result: SplitPart[] = []

  while (remaining.length > 0) {
    const next = nextTag(remaining)
    if (!next) {
      result.push({ type: state.active ? "reasoning" : "text", text: remaining })
      break
    }

    if (next.index > 0) {
      result.push({ type: state.active ? "reasoning" : "text", text: remaining.slice(0, next.index) })
    }

    state.active = next.tag === OPEN
    remaining = remaining.slice(next.index + next.tag.length)
  }

  return result.filter((part) => part.text.length > 0)
}

export function flushSplit(state: SplitState): SplitPart[] {
  const pending = state.pending
  state.pending = ""
  if (!pending) return []
  return [{ type: state.active ? "reasoning" : "text", text: pending }]
}

function nextTag(input: string) {
  const lower = input.toLowerCase()
  const open = lower.indexOf(OPEN)
  const close = lower.indexOf(CLOSE)
  if (open === -1 && close === -1) return
  if (open === -1) return { index: close, tag: CLOSE }
  if (close === -1) return { index: open, tag: OPEN }
  return open < close ? { index: open, tag: OPEN } : { index: close, tag: CLOSE }
}

function trailingTagPrefixLength(input: string) {
  const max = Math.min(input.length, CLOSE.length - 1)
  for (let length = max; length > 0; length--) {
    const suffix = input.slice(-length).toLowerCase()
    if (OPEN.startsWith(suffix) || CLOSE.startsWith(suffix)) return length
  }
  return 0
}

export * as ThinkTags from "./think-tags"
