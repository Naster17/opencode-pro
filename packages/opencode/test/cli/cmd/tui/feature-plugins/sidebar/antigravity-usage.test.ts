import { describe, expect, test } from "bun:test"
import {
  bucketsFromGroups,
  formatBucket,
  formatResetDuration,
  getAntigravityUsage,
  clearAntigravityUsageCache,
  mergeUsageSnapshots,
} from "../../../../../../src/cli/cmd/tui/feature-plugins/sidebar/antigravity-usage"

describe("sidebar.antigravity-usage", () => {
  describe("formatResetDuration", () => {
    test("formats minutes only when under 1 hour", () => {
      const now = 1000_000_000
      const resetsAt = now + 45 * 60_000
      expect(formatResetDuration(resetsAt, now)).toBe("45m")
    })

    test("formats hours and minutes when between 1 hour and 24 hours", () => {
      const now = 1000_000_000
      const resetsAt = now + (4 * 60 + 40) * 60_000
      expect(formatResetDuration(resetsAt, now)).toBe("4h 40m")
    })

    test("formats days and hours when over 24 hours", () => {
      const now = 1000_000_000
      const resetsAt = now + (6 * 24 * 60 + 23 * 60) * 60_000
      expect(formatResetDuration(resetsAt, now)).toBe("6d 23h")
    })

    test("handles past or zero duration gracefully", () => {
      const now = 1000_000_000
      expect(formatResetDuration(now - 1000, now)).toBe("0m")
      expect(formatResetDuration(now, now)).toBe("0m")
    })
  })

  describe("formatBucket", () => {
    test("always renders 5h/weekly shape", () => {
      const now = 1000_000_000
      const fiveHour = { remainingPercent: 12.3, usedPercent: 87.7, resetsAt: now + 2 * 60 * 60_000 + 37 * 60_000 }
      const weekly = { remainingPercent: 84.5, usedPercent: 15.5, resetsAt: now + 6 * 24 * 60 * 60_000 }
      expect(formatBucket(fiveHour, weekly, now)).toBe("12.3%/84.5% (2h 37m)")
    })

    test("uses placeholder for missing side instead of changing shape", () => {
      const now = 1000_000_000
      const fiveHour = { remainingPercent: 80.6, usedPercent: 19.4, resetsAt: now + 2 * 60 * 60_000 + 38 * 60_000 }
      expect(formatBucket(fiveHour, undefined, now)).toBe("80.6%/— (2h 38m)")
      expect(formatBucket(undefined, undefined, now)).toBeUndefined()
    })

    test("omits reset suffix when reset time is unknown", () => {
      expect(formatBucket({ remainingPercent: 100, usedPercent: 0 }, undefined)).toBe("100%/—")
    })
  })

  describe("bucketsFromGroups", () => {
    test("parses 5h and weekly buckets for both families", () => {
      const groups = [
        {
          displayName: "Gemini",
          buckets: [
            { window: "5h", remainingFraction: 0.123, resetTime: "2026-09-24T10:00:00Z" },
            { window: "weekly", remainingFraction: 0.845, resetTime: "2026-09-30T10:00:00Z" },
          ],
        },
        {
          displayName: "Claude",
          buckets: [{ window: "5H", remainingFraction: 0.806, resetTime: "2026-09-24T10:00:00Z" }],
        },
      ]
      const out = bucketsFromGroups(groups)
      expect(out.gemini5h?.remainingPercent).toBe(12.3)
      expect(out.geminiWeekly?.remainingPercent).toBe(84.5)
      expect(out.claude5h?.remainingPercent).toBe(80.6)
      expect(out.claudeWeekly).toBeUndefined()
    })

    test("ignores non-numeric fractions and unknown groups", () => {
      const out = bucketsFromGroups([{ displayName: "Other", buckets: [{ window: "5h" }] }])
      expect(out.gemini5h).toBeUndefined()
      expect(out.claude5h).toBeUndefined()
      expect(bucketsFromGroups(undefined)).toEqual({
        gemini5h: undefined,
        geminiWeekly: undefined,
        claude5h: undefined,
        claudeWeekly: undefined,
      })
    })
  })

  describe("mergeUsageSnapshots", () => {
    test("carries over weekly buckets missing from fallback source", () => {
      const now = Date.now()
      const prev = {
        configured: true,
        gemini5h: { remainingPercent: 12.3, usedPercent: 87.7, resetsAt: now + 60_000 },
        geminiWeekly: { remainingPercent: 84.5, usedPercent: 15.5, resetsAt: now + 3600_000 },
        claude5h: { remainingPercent: 80, usedPercent: 20, resetsAt: now + 60_000 },
        claudeWeekly: { remainingPercent: 90, usedPercent: 10, resetsAt: now + 3600_000 },
      }
      const next = {
        configured: true,
        gemini5h: { remainingPercent: 12, usedPercent: 88, resetsAt: now + 60_000 },
        claude5h: { remainingPercent: 80.6, usedPercent: 19.4, resetsAt: now + 60_000 },
      }
      const merged = mergeUsageSnapshots(prev, next, now)
      expect(merged.gemini5h?.remainingPercent).toBe(12)
      expect(merged.geminiWeekly?.remainingPercent).toBe(84.5)
      expect(merged.claudeWeekly?.remainingPercent).toBe(90)
    })

    test("drops stale carried buckets past reset", () => {
      const now = Date.now()
      const prev = {
        configured: true,
        geminiWeekly: { remainingPercent: 84.5, usedPercent: 15.5, resetsAt: now - 1000 },
      }
      const merged = mergeUsageSnapshots(prev, { configured: true }, now)
      expect(merged.geminiWeekly).toBeUndefined()
    })
  })

  describe("getAntigravityUsage", () => {
    test("returns unconfigured snapshot when no credentials are present", async () => {
      clearAntigravityUsageCache()
      const usage = await getAntigravityUsage()
      expect(usage).toBeDefined()
      expect(typeof usage.configured).toBe("boolean")
      if (!usage.configured) return
      if (usage.email) expect(usage.email).toContain("@")

      for (const bucket of [usage.gemini5h, usage.claude5h, usage.geminiWeekly, usage.claudeWeekly]) {
        if (!bucket) continue
        expect(bucket.remainingPercent).toBeGreaterThanOrEqual(0)
        expect(bucket.remainingPercent).toBeLessThanOrEqual(100)
      }
    })
  })
})
