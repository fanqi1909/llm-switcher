---
name: Translation quirks
description: Key gotchas discovered during Anthropic ↔ OpenAI API translation implementation
type: project
---

Issues discovered during implementation (all resolved):

1. **URL matching** — Claude Code sends `/v1/messages?beta=true` for OAuth, proxy must match with startsWith not exact equality
2. **ID prefix mismatch** — Anthropic uses `toolu_`, OpenAI uses `fc_` and `call_`. Must convert in both directions. `response.output_item.added` uses `call_id`, but `response.function_call_arguments.delta` uses `item_id` (a different ID). Use `output_index` for matching instead.
3. **WS text vs binary frames** — `ws` library sends Buffer as binary by default. Codex CLI expects text frames. Must check `isBinary` flag and convert accordingly.
4. **Instructions required** — chatgpt.com backend requires non-empty `instructions` field. Fall back to "You are a helpful assistant." if system prompt is empty.
5. **WS message wrapping** — OpenAI Responses WS expects `{type: "response.create", ...body}` (spread at top level), not `{type: "response.create", response: body}`.

**How to apply:** When debugging translation issues, check these patterns first. They're the most common failure modes.
