const kinds = ["bash", "pwsh", "powershell", "cmd"] as const
export type Kind = (typeof kinds)[number]

const shellKinds = new Set<string>(kinds)

function isKind(value: string): value is Kind {
  return shellKinds.has(value)
}

export function toKind(value: string): Kind {
  return isKind(value) ? value : "bash"
}

export const ToolID = "shell"
export type ToolID = typeof ToolID

export * as ShellID from "./id"
