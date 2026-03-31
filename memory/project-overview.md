---
name: Project overview
description: llm-switcher is a local proxy that translates between Anthropic and OpenAI API formats, enabling model/account switching in Claude Code and Codex CLI
type: project
---

llm-switcher is a TypeScript Node.js proxy on localhost:8411 that:
- Lets Claude Code use OpenAI models (Anthropic Messages → OpenAI Responses API via WebSocket)
- Lets Codex CLI route through the same proxy (WS passthrough)
- Supports multiple Claude Pro accounts for quota rotation (pure passthrough)
- Manages sessions via CLI and admin HTTP API

**Why:** Context continuity across model/account switches — the next model sees full conversation history. Key use case is quota failover without losing context.

**How to apply:** All code is in `src/`. Translation logic in `translate.ts`, proxy routing in `proxy.ts`, session management in `config.ts`. Tests in `translate.test.ts` (48 tests). Docs in `docs/`.
