---
name: Codex OAuth endpoint discovery
description: Codex CLI OAuth tokens only work with chatgpt.com/backend-api/codex/responses, not api.openai.com
type: reference
---

Codex CLI OAuth tokens (JWT from auth.openai.com) have scopes `api.connectors.read, api.connectors.invoke` — they do NOT have `api.responses.write`.

This means:
- `api.openai.com/v1/responses` returns 500 (WS) or 401 (HTTP)
- `api.openai.com/v1/chat/completions` returns 500
- The correct endpoint is `wss://chatgpt.com/backend-api/codex/responses`

The WS message format is `{type: "response.create", model: "...", instructions: "...", input: [...]}` — all fields at top level alongside `type`, NOT nested in a `response` object.

Parameters NOT supported by this backend: `max_output_tokens`, `temperature`, `top_p`.

Codex CLI connects to path `/responses` (not `/v1/responses`).
