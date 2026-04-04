# Agent Guidelines

This document defines repo-wide guidance for coding agents working in `llm-switcher`.

It is intentionally tool-neutral. Claude Code, Codex, and other GPT-style agents should all be able to follow it.

## Project Context

`llm-switcher` is a local proxy for preserving session continuity while switching backend sessions across Claude Code and Codex CLI.

Current implemented focus:

- Claude Code -> Anthropic
- Claude Code -> OpenAI
- Codex CLI -> OpenAI
- local multi-session overrides
- basic session observability
- provider-aware Claude-oriented statusline context

Current major gap:

- Codex CLI -> Anthropic reverse translation is not implemented

## Change Philosophy

- Prefer the smallest coherent change that solves the current problem.
- Do not mix unrelated cleanup into functional work.
- Preserve backward compatibility unless the change is explicitly intended to break an interface.
- Prefer additive observability and documentation over speculative abstraction.
- Avoid turning the project into a generic multi-user orchestration platform.

## Workflow Expectations

- For non-trivial work, prefer issue-first or design-first workflow.
- If a change is design-heavy, capture the design in `docs/` before or alongside implementation.
- Keep PRs narrow and tied to one issue or one decision when possible.
- Do not create commits unless explicitly asked by the user/operator.
- Keep the primary repo directory on `main` for local service runs and manual testing.
- For feature work, prefer `git worktree` instead of switching branches in the primary repo directory.
- Remove feature worktrees after merge when they are no longer needed.

## Testing Expectations

- Any behavior change should come with tests if the path is testable.
- Prefer extending the existing `src/*.test.ts` coverage rather than adding unintegrated ad hoc scripts.
- When changing proxy behavior, verify both:
  - route behavior
  - error / fallback behavior

Minimum validation for normal code changes:

- `npm run test`

When touching CLI entrypoints or packaging-related code, also verify:

- `npm run build`

## Documentation Expectations

- Update README when a user-facing command, header, route, or workflow changes.
- Update `docs/design.md` when the communication or session model changes.
- Add or update targeted docs in `docs/` when a new design area emerges.
- Avoid leaving stale technical claims in docs after implementation changes.

## Security And Token Handling

- Never log or print full tokens unless the user explicitly needs that behavior.
- Treat OAuth tokens and API keys as sensitive even in local workflows.
- Prefer describing token sources and formats over pasting live credential values into docs or outputs.
- Be careful not to weaken current token-handling paths when refactoring.

## Session Model Guidance

- The global active session is still a real concept, but it is no longer the same thing as every window's effective route.
- Scoped session selection should prefer per-request or per-connection semantics over new global state.
- Global default state may be used as fallback context, but should not be mislabeled as current window truth.

## Statusline Guidance

- Statusline integrations should prefer current window/process context first.
- Proxy-global state should only be fallback and should be labeled as such.
- New statusline work should stay provider-agnostic where possible so Claude and Codex can share the same internal model.

Relevant design note:

- [statusline-design.md](statusline-design.md)

## Communication Style

- Keep responses concise and high-signal.
- State tradeoffs clearly instead of hiding them behind vague language.
- If something is a design question rather than a bug, say so explicitly.
- When uncertain, prefer clarifying the current boundary over over-claiming support.
