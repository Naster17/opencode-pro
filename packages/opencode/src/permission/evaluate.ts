import { Wildcard } from "@/util/wildcard"

type Rule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

export function normalize(permission: string) {
  return permission === "bash" ? "shell" : permission
}

export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const normalized = normalize(permission)
  const rules = rulesets.flat()
  const match = rules.findLast(
    (rule) => Wildcard.match(normalized, normalize(rule.permission)) && Wildcard.match(pattern, rule.pattern),
  )
  return match ? { ...match, permission: normalized } : { action: "ask", permission: normalized, pattern: "*" }
}
