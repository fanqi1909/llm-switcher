# CLAUDE.md

Follow [docs/agent-guidelines.md](docs/agent-guidelines.md) for repo-wide engineering guidance.

Claude Code-specific notes:

- `.claude/commands/llm-switch.md` is a local Claude helper for switching sessions through the proxy.
- If you introduce new repo guidance, keep shared rules in `docs/agent-guidelines.md` instead of duplicating them here.
- For Claude statusline work, keep using the provider-agnostic model in [docs/statusline-design.md](docs/statusline-design.md) rather than adding Claude-only assumptions to the shared logic.
- Unless explicitly asked otherwise, keep the primary repo directory on `main` and use `git worktree` for branch-based feature work.
