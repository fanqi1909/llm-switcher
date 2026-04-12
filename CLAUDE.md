# CLAUDE.md

Follow [docs/agent-guidelines.md](docs/agent-guidelines.md) for repo-wide engineering guidance.

Claude Code-specific notes:

- `.claude/commands/llm-switch.md` is a local Claude helper for switching sessions through the proxy.
- If you introduce new repo guidance, keep shared rules in `docs/agent-guidelines.md` instead of duplicating them here.
- For Claude statusline work, keep using the provider-agnostic model in [docs/statusline-design.md](docs/statusline-design.md) rather than adding Claude-only assumptions to the shared logic.
- Unless explicitly asked otherwise, keep the primary repo directory on `main` and use `git worktree` for branch-based feature work.
- Before starting a new feature branch or splitting work into a separate PR, always `git fetch` and fast-forward `main` to the latest `origin/main` first. Do not judge whether work is already upstream from a stale local `main`.
- Prefer one worktree per distinct requirement / PR. Before opening or splitting a PR, confirm there is still real diff against `origin/main` with `git diff --stat origin/main...HEAD` and `git log --oneline origin/main...HEAD`.
- When a change already exists as a clean commit, prefer creating a fresh branch from updated `origin/main` and `git cherry-pick`ing that commit instead of re-splitting changes manually in a mixed worktree.
