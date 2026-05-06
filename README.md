<p align="center">
  <a href="https://github.com/Naster17/opencode-pro">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@naster17/opencode-pro"><img alt="npm" src="https://img.shields.io/npm/v/%40naster17%2Fopencode-pro?style=flat-square" /></a>
  <a href="https://github.com/Naster17/opencode-pro/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/Naster17/opencode-pro/publish.yml?style=flat-square&branch=dev" /></a>
</p>

![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)

---

### Installation

```bash
npm i -g @naster17/opencode-pro@latest # or bun/pnpm/yarn
nix run github:Naster17/opencode-pro
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### PRO Features

| Feature                        | Description                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar Metrics                | Live session metrics in the sidebar with context usage, token totals, cache, tool calls, compactions, speed, and spend.           |
| `/usage` Dashboard             | Interactive usage analytics with Overview, Sessions, and Models views across Today, 7d, 30d, or all-time history.                 |
| Accurate Full-History Totals   | Usage and metrics are calculated across full session history, without the old 100-message cap skewing totals.                     |
| Smarter Thinking Controls      | Refined thinking mode UX with visible levels, cleaner variant labels, and faster cycling for reasoning-capable models.            |
| `Ctrl+T` Variant Flow          | `Ctrl+T` cycles model variants cleanly, while `Ctrl+Shift+T` or `F3` steps through supported thinking levels.                     |
| Better Local Reasoning Support | Improved handling for llama.cpp and OpenAI-compatible reasoning models, including toggle-style thinking providers.                |
| Privacy-First Hardening        | Telemetry is stripped back, session sharing is permanently disabled, and remote workspace sync cannot be re-enabled by env flags. |
| Lightweight `/help` Base       | A clean in-app help entrypoint is already wired in as the foundation for a fuller guided help experience next.                    |

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/Naster17/opencode-pro/releases).

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

### Documentation

For more info on configuration and behavior, inspect the docs sources in `packages/web/src/content/docs` and package READMEs in this repository.

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

Modded & maintained by Naster17 (not affiliated with OpenCode).

### FAQ

#### How is this different from Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. It can be used with Claude, OpenAI, Google, or local models.
- Built-in opt-in LSP support
- A focus on TUI.
- A client/server architecture. This, for example, can allow OpenCode to run on your computer while you drive it remotely from a mobile app, meaning that the TUI frontend is just one of the possible clients.
