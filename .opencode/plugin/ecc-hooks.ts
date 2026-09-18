/**
 * ECC Plugin Hooks for OpenCode
 *
 * This plugin translates Claude Code hooks to OpenCode's plugin system.
 * OpenCode's plugin system is MORE sophisticated than Claude Code with 20+ events
 * compared to Claude Code's 3 phases (PreToolUse, PostToolUse, Stop).
 *
 * Hook Event Mapping:
 * - PreToolUse → tool.execute.before
 * - PostToolUse → tool.execute.after
 * - Stop → session.idle / session.status
 * - SessionStart → session.created
 * - SessionEnd → session.deleted
 */

import type { PluginInput } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"
import changedFilesTool from "../tool/ecc-changed-files.js"
import dependencyAnalyzerTool from "../tool/ecc-dependency-analyzer.js"

/**
 * Type definitions for better type safety
 */
interface ToolArgs {
  filePath?: string
  file_path?: string
  path?: string
  command?: string
  [key: string]: unknown
}

interface ToolInput {
  tool: string
  callID?: string
  args?: ToolArgs
}

interface FileEvent {
  path: string
  type?: string
}

interface TodoEvent {
  todos: Array<{ text: string; done: boolean }>
}

/**
 * Read ECC version from package.json
 * Falls back to a default if package.json cannot be read
 */
function getECCVersion(): string {
  try {
    const packageJsonPath = path.resolve(__dirname, "../../package.json")
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"))
    return packageJson.version || "2.2.1"
  } catch {
    return "2.2.1"
  }
}

type ECCHooksPluginFn = (input: PluginInput) => Promise<Record<string, unknown>>

export const ECCHooksPlugin: ECCHooksPluginFn = async ({
  client,
  $,
  directory,
  worktree,
}: PluginInput) => {
  type HookProfile = "minimal" | "standard" | "strict"

  const worktreePath = worktree || directory

  const editedFiles = new Set<string>()

  function resolvePath(p: string): string {
    if (path.isAbsolute(p)) return p
    return path.join(worktreePath, p)
  }

  function hasProjectFile(relativePath: string): boolean {
    try {
      return fs.statSync(resolvePath(relativePath)).isFile()
    } catch {
      return false
    }
  }

  const pendingToolChanges = new Map<string, { path: string; type: "added" | "modified" }>()
  let writeCounter = 0

  function getFilePath(args: ToolArgs | undefined): string | null {
    if (!args) return null
    const p = (args.filePath ?? args.file_path ?? args.path) as string | undefined
    return typeof p === "string" && p.trim() ? p : null
  }

  // Helper to call the SDK's log API with correct signature
  const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service: "ecc", level, message } })

  // Loaded lazily (instead of via a top-level import) so that a missing or
  // partially-installed `~/.opencode/plugins/lib` directory (e.g. an
  // interrupted or partial ECC install on Termux/Android) only disables
  // changed-files tracking, rather than throwing during module evaluation.
  // This plugin is OpenCode's startup entry point, so a static import
  // failure here previously crashed the whole plugin -- and with it, the
  // entire OpenCode session -- before any hooks could load (see #2530).
  let changedFilesStore: typeof import("./ecc-lib/changed-files-store.js") | undefined
  try {
    const store = await import("./ecc-lib/changed-files-store.js")
    store.initStore(worktreePath)
    changedFilesStore = store
  } catch {
    // Best-effort diagnostic only: deferred via .then() (rather than
    // Promise.resolve(log(...))) so that even a *synchronous* throw inside
    // log() -- not just an async rejection -- is caught here instead of
    // escaping this catch block. The raw loader error is intentionally not
    // included in the message since it can contain absolute filesystem
    // paths; this whole block exists to guarantee startup resilience even
    // when things go wrong.
    Promise.resolve()
      .then(() =>
        log(
          "warn",
          "[ECC] changed-files tracking disabled: could not load the changed-files store. " +
            "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
        )
      )
      .catch(() => {})
  }

  const normalizeProfile = (value: string | undefined): HookProfile => {
    if (value === "minimal" || value === "strict") return value
    return "standard"
  }

  const currentProfile = normalizeProfile(process.env.ECC_HOOK_PROFILE)
  const disabledHooks = new Set(
    (process.env.ECC_DISABLED_HOOKS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )

  const profileOrder: Record<HookProfile, number> = {
    minimal: 0,
    standard: 1,
    strict: 2,
  }

  const profileAllowed = (required: HookProfile | HookProfile[]): boolean => {
    if (Array.isArray(required)) {
      return required.some((entry) => profileOrder[currentProfile] >= profileOrder[entry])
    }
    return profileOrder[currentProfile] >= profileOrder[required]
  }

  const hookEnabled = (
    hookId: string,
    requiredProfile: HookProfile | HookProfile[] = "standard"
  ): boolean => {
    if (disabledHooks.has(hookId)) return false
    return profileAllowed(requiredProfile)
  }

  const on_file_edited = async (event: { path: string }) => {
    editedFiles.add(event.path)
    changedFilesStore?.recordChange(event.path, "modified")

    // Auto-format JS/TS files
    if (hookEnabled("post:edit:format", ["strict"]) && event.path.match(/\.(ts|tsx|js|jsx)$/)) {
      try {
        await $`prettier --write ${event.path} 2>/dev/null`
        log("info", `[ECC] Formatted: ${event.path}`)
      } catch (error: unknown) {
        // Prettier not installed or failed - log but continue
        const errorMessage = error instanceof Error ? error.message : String(error)
        log("debug", `[ECC] Prettier formatting failed for ${event.path}: ${errorMessage}`)
      }
    }

    // Console.log warning check
    if (hookEnabled("post:edit:console-warn", ["standard", "strict"]) && event.path.match(/\.(ts|tsx|js|jsx)$/)) {
      try {
        const result = await $`grep -n "console\\.log" ${event.path} 2>/dev/null`.text()
        if (result.trim()) {
          const lines = result.trim().split("\n").length
          log(
            "warn",
            `[ECC] console.log found in ${event.path} (${lines} occurrence${lines > 1 ? "s" : ""})`
          )
        }
      } catch {
        // No console.log found (grep returns non-zero) - this is good
      }
    }
  }
  const on_session_created = async () => {
    if (!hookEnabled("session:start", ["minimal", "standard", "strict"])) return

    log("info", `[ECC] Session started - profile=${currentProfile}`)

    // Check for project-specific context files
    if (hasProjectFile("CLAUDE.md")) {
      log("info", "[ECC] Found CLAUDE.md - loading project context")
    }
  }
  const on_session_idle = async () => {
    if (!hookEnabled("stop:check-console-log", ["minimal", "standard", "strict"])) return
    if (editedFiles.size === 0) return

    log("info", "[ECC] Session idle - running console.log audit")

    let totalConsoleLogCount = 0
    const filesWithConsoleLogs: string[] = []

    for (const file of editedFiles) {
      if (!file.match(/\.(ts|tsx|js|jsx)$/)) continue

      try {
        const result = await $`grep -c "console\\.log" ${file} 2>/dev/null`.text()
        const count = parseInt(result.trim(), 10)
        if (count > 0) {
          totalConsoleLogCount += count
          filesWithConsoleLogs.push(file)
        }
      } catch {
        // No console.log found
      }
    }

    if (totalConsoleLogCount > 0) {
      log(
        "warn",
        `[ECC] Audit: ${totalConsoleLogCount} console.log statement(s) in ${filesWithConsoleLogs.length} file(s)`
      )
      filesWithConsoleLogs.forEach((f) =>
        log("warn", `  - ${f}`)
      )
      log("warn", "[ECC] Remove console.log statements before committing")
    } else {
      log("info", "[ECC] Audit passed: No console.log statements found")
    }

    // Desktop notification (cross-platform)
    try {
      if (process.platform === "darwin") {
        // macOS
        await $`osascript -e 'display notification "Task completed!" with title "OpenCode ECC"' 2>/dev/null`
      } else if (process.platform === "win32") {
        // Windows - PowerShell notification
        await $`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Task completed!', 'OpenCode ECC', 'OK', 'Information')" 2>/dev/null`
      } else if (process.platform === "linux") {
        // Linux - notify-send (requires libnotify)
        await $`notify-send "OpenCode ECC" "Task completed!" 2>/dev/null`
      }
    } catch (error: unknown) {
      // Notification not supported or failed - log but continue
      const errorMessage = error instanceof Error ? error.message : String(error)
      log("debug", `[ECC] Desktop notification failed: ${errorMessage}`)
    }

    // Clear tracked files for next task
    editedFiles.clear()
  }
  const on_session_deleted = async () => {
    if (!hookEnabled("session:end-marker", ["minimal", "standard", "strict"])) return
    log("info", "[ECC] Session ended - cleaning up")
    editedFiles.clear()
    changedFilesStore?.clearChanges()
    pendingToolChanges.clear()
  }
  const on_file_watcher_updated = async (event: { path: string; type: string }) => {
    let changeType: "added" | "modified" | "deleted" = "modified"
    if (event.type === "create" || event.type === "add") changeType = "added"
    else if (event.type === "delete" || event.type === "remove") changeType = "deleted"
    changedFilesStore?.recordChange(event.path, changeType)
    if (event.type === "change" && event.path.match(/\.(ts|tsx|js|jsx)$/)) {
      editedFiles.add(event.path)
    }
  }
  const on_todo_updated = async (event: { todos: Array<{ text: string; done: boolean }> }) => {
    const completed = event.todos.filter((t) => t.done).length
    const total = event.todos.length
    if (total > 0) {
      log("info", `[ECC] Progress: ${completed}/${total} tasks completed`)
    }
  }

  return {
    event: async ({ event }: { event: { type: string; properties: Record<string, unknown> } }) => {
      const t = event.type
      const p = event.properties as Record<string, unknown>
      const todos = p.todos as Array<{ content: string; status: string }> | undefined
      if (t === "file.edited" && typeof p.file === "string") await on_file_edited({ path: p.file })
      else if (t === "session.created") await on_session_created()
      else if (t === "session.idle") await on_session_idle()
      else if (t === "session.deleted") await on_session_deleted()
      else if (t === "file.watcher.updated")
        await on_file_watcher_updated({
          path: typeof p.path === "string" ? p.path : "",
          type: typeof p.type === "string" ? p.type : "change",
        })
      else if (t === "todo.updated" && Array.isArray(todos))
        await on_todo_updated({
          todos: todos.map((x) => ({ text: x.content, done: x.status === "completed" })),
        })
    },
    "tool.execute.after": async (
      input: ToolInput,
      output: unknown
    ) => {
      const filePath = getFilePath(input.args)
      if (input.tool === "edit" && filePath) {
        changedFilesStore?.recordChange(filePath, "modified")
      }
      if (input.tool === "write" && filePath) {
        const key = input.callID ?? `write-${++writeCounter}-${filePath}`
        const pending = pendingToolChanges.get(key)
        if (pending) {
          changedFilesStore?.recordChange(pending.path, pending.type)
          pendingToolChanges.delete(key)
        } else {
          changedFilesStore?.recordChange(filePath, "modified")
        }
      }

      // Check if a TypeScript file was edited
      if (
        hookEnabled("post:edit:typecheck", ["strict"]) &&
        input.tool === "edit" &&
        input.args?.filePath?.match(/\.tsx?$/)
      ) {
        try {
          await $`npx tsc --noEmit 2>&1`
          log("info", "[ECC] TypeScript check passed")
        } catch (error: unknown) {
          const err = error as { stdout?: string }
          log("warn", "[ECC] TypeScript errors detected:")
          if (err.stdout) {
            // Log first few errors
            const errors = err.stdout.split("\n").slice(0, 5)
            errors.forEach((line: string) => log("warn", `  ${line}`))
          }
        }
      }

      // PR creation logging
      if (
        hookEnabled("post:bash:pr-created", ["standard", "strict"]) &&
        input.tool === "bash" &&
        input.args?.toString().includes("gh pr create")
      ) {
        log("info", "[ECC] PR created - check GitHub Actions status")
      }
    },
    "tool.execute.before": async (
      input: ToolInput
    ) => {
      if (input.tool === "write") {
        const filePath = getFilePath(input.args)
        if (filePath) {
          const absPath = resolvePath(filePath)
          let type: "added" | "modified" = "modified"
          try {
            if (typeof fs.existsSync === "function") {
              type = fs.existsSync(absPath) ? "modified" : "added"
            }
          } catch {
            type = "modified"
          }
          const key = input.callID ?? `write-${++writeCounter}-${filePath}`
          pendingToolChanges.set(key, { path: filePath, type })
        }
      }

      // Git push review reminder
      if (
        hookEnabled("pre:bash:git-push-reminder", "strict") &&
        input.tool === "bash" &&
        input.args?.toString().includes("git push")
      ) {
        log(
          "info",
          "[ECC] Remember to review changes before pushing: git diff origin/main...HEAD"
        )
      }

      // Block creation of unnecessary documentation files
      if (
        hookEnabled("pre:write:doc-file-warning", ["standard", "strict"]) &&
        input.tool === "write" &&
        input.args?.filePath &&
        typeof input.args.filePath === "string"
      ) {
        const filePath = input.args.filePath
        if (
          filePath.match(/\.(md|txt)$/i) &&
          !filePath.includes("README") &&
          !filePath.includes("CHANGELOG") &&
          !filePath.includes("LICENSE") &&
          !filePath.includes("CONTRIBUTING")
        ) {
          log(
            "warn",
            `[ECC] Creating ${filePath} - consider if this documentation is necessary`
          )
        }
      }

      // Long-running command reminder
      if (hookEnabled("pre:bash:tmux-reminder", "strict") && input.tool === "bash") {
        const cmd = String(input.args?.command || input.args || "")
        if (
          cmd.match(/^(npm|pnpm|yarn|bun)\s+(install|build|test|run)/) ||
          cmd.match(/^cargo\s+(build|test|run)/) ||
          cmd.match(/^go\s+(build|test|run)/)
        ) {
          log(
            "info",
            "[ECC] Long-running command detected - consider using background execution"
          )
        }
      }
    },
    "shell.env": async () => {
      const env: Record<string, string> = {
        ECC_VERSION: getECCVersion(),
        ECC_PLUGIN: "true",
        ECC_HOOK_PROFILE: currentProfile,
        ECC_DISABLED_HOOKS: process.env.ECC_DISABLED_HOOKS || "",
        PROJECT_ROOT: worktreePath,
      }

      // Detect package manager
      const lockfiles: Record<string, string> = {
        "bun.lockb": "bun",
        "pnpm-lock.yaml": "pnpm",
        "yarn.lock": "yarn",
        "package-lock.json": "npm",
      }
      for (const [lockfile, pm] of Object.entries(lockfiles)) {
        if (hasProjectFile(lockfile)) {
          env.PACKAGE_MANAGER = pm
          break
        }
      }

      // Detect languages
      const langDetectors: Record<string, string> = {
        "tsconfig.json": "typescript",
        "go.mod": "go",
        "pyproject.toml": "python",
        "Cargo.toml": "rust",
        "Package.swift": "swift",
      }
      const detected: string[] = []
      for (const [file, lang] of Object.entries(langDetectors)) {
        if (hasProjectFile(file)) {
          detected.push(lang)
        }
      }
      if (detected.length > 0) {
        env.DETECTED_LANGUAGES = detected.join(",")
        env.PRIMARY_LANGUAGE = detected[0]
      }

      return env
    },
    "experimental.session.compacting": async () => {
      const contextBlock = [
        "# ECC Context (preserve across compaction)",
        "",
        "## Active Plugin: ECC v2.2.1",
        "- Hooks: file.edited, tool.execute.before/after, session.created/idle/deleted, shell.env, compacting",
        "- Tools: run-tests, check-coverage, security-audit, format-code, lint-check, git-summary, changed-files",
        "- Agents: 13 specialized (planner, architect, tdd-guide, code-reviewer, security-reviewer, build-error-resolver, e2e-runner, refactor-cleaner, doc-updater, go-reviewer, go-build-resolver, database-reviewer, python-reviewer)",
        "",
        "## Key Principles",
        "- TDD: write tests first, 80%+ coverage",
        "- Immutability: never mutate, always return new copies",
        "- Security: validate inputs, no hardcoded secrets",
        "",
      ]

      // Include recently edited files
      if (editedFiles.size > 0) {
        contextBlock.push("## Recently Edited Files")
        for (const f of editedFiles) {
          contextBlock.push(`- ${f}`)
        }
        contextBlock.push("")
      }

      return {
        context: contextBlock.join("\n"),
      }
    },
    tool: {
      "ecc-changed-files": changedFilesTool,
      "ecc-dependency-analyzer": dependencyAnalyzerTool,
    },
  }
}

export default ECCHooksPlugin
