import { describe, expect, test } from "bun:test"
import { formatResetDuration, resolveCodexUsage } from "../../../../../../src/cli/cmd/tui/feature-plugins/sidebar/codex-usage"

describe("codex usage sidebar", () => {
  test("formats reset countdown in days hours minutes", () => {
    expect(formatResetDuration(1_000, 0)).toBe("0d 0h 16m")
    expect(formatResetDuration(10_000, 7_200_000)).toBe("0d 0h 46m")
  })

  test("prefers the codex-specific rate limit bucket", () => {
    expect(
      resolveCodexUsage(
        {
          account: { type: "chatgpt", email: "some_name@gmail.com" },
        },
        {
          rateLimits: {
            primary: { usedPercent: 12, resetsAt: 100 },
          },
          rateLimitsByLimitId: {
            codex: {
              primary: { usedPercent: 34, resetsAt: 200 },
            },
          },
        },
      ),
    ).toEqual({
      configured: true,
      email: "some_name@gmail.com",
      usedPercent: 34,
      resetsAt: 200,
    })
  })
})
