---
description: incrementally sync small upstream batches into this fork
subtask: true
---

Incrementally sync this fork from upstream in small safe batches.

Primary goal: bring in a small batch of upstream commits without breaking fork-specific behavior.

Treat local fork behavior as the source of truth for conflicts involving branding, release wiring, product behavior, PRO/custom features, repo/package names, or any fork-only functionality. Still preserve useful upstream fixes when they can be merged without breaking local behavior.

Default batch size is 2-3 commits. Prefer the next small upstream commits whose combined diff is roughly under 1000 changed lines. If `$ARGUMENTS` includes a clear override such as a commit count, SHA, range, or line budget, follow it.

This command is LLM-driven, not a fixed script. Decide the safest next batch dynamically from the real repository state at execution time.

Workflow:

1. Inspect the current git state first. If there are unrelated local changes, do not revert them. Work around them carefully.
2. Fetch `origin` and `upstream` explicitly.
3. Create a local backup branch before any non-trivial git write, for example `backup/sync-upstream-<timestamp>`.
4. Compare the current branch against `upstream/dev`. If `upstream/dev` does not exist, inspect upstream refs and use the closest equivalent branch.
5. Identify upstream commits not yet present locally. Prefer non-merge commits and process them oldest-first.
6. Inspect candidate commits before applying them. Prefer a batch of 2-3 commits with small combined size. Avoid huge refactors, broad file moves, or batches likely to exceed roughly 1000 changed lines.
7. Apply commits with `git cherry-pick -x`, one commit at a time.
8. If a cherry-pick conflicts:
   - keep local fork-specific behavior by default
   - manually merge upstream bug fixes when they fit cleanly
   - never drop local PRO/custom behavior just to make the sync easier
   - do not use destructive git commands
9. After the batch is applied, run verification:
   - `bun typecheck` from `packages/opencode`
   - `bun run test:ci` from `packages/opencode`
   - if the batch touches SDK generation inputs or SDK package code, also run `./packages/sdk/js/script/build.ts` from repo root
10. If verification fails, stop immediately. Do not push. Do not silently revert. Report:

- which commits were applied
- where it failed
- the key error output
- what likely needs manual intervention

11. If verification passes, summarize exactly what landed, which conflicts were resolved, and which upstream commits should be considered next.

Execution rules:

- Prefer automation. Do the work instead of only describing it.
- Use merge safety suitable for a shared fork: preserve fork-specific behavior by default.
- Do not push unless explicitly asked.
- Do not create a final commit unless the git operation itself requires it and the batch is valid.
- If no safe small batch can be identified, explain why and propose the next safest candidate commits.
- Keep the response focused on: selected commits, conflict decisions, test results, and next batch recommendation.
- Be extremely concise. Prefer fragments over prose.
- Do not write long explanations, introductions, retrospectives, or motivational text.
- Keep the final user-facing response under 8 short lines unless there is a blocker or test failure.
- Prefer this exact compact structure:
  - `picked:` `<sha>` `<sha>` ...
  - `conflicts:` `none` or a 1-line summary
  - `checks:` `typecheck ok/fail`, `tests ok/fail`, `sdk skipped/ok/fail`
  - `result:` `applied` or `stopped`
  - `next:` next candidate sha(s) or `manual intervention needed`
- If a command output is long, summarize only the deciding error, not the full log.

Useful git checks to perform:

- recent local status
- merge base with upstream
- commit count difference
- candidate upstream commits in chronological order
- `git show --stat --summary <sha>` for each candidate before selecting the batch

Your job is to complete one safe incremental upstream sync batch now, not to plan the entire 670-commit migration at once.
