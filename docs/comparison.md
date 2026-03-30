# LLM Switcher vs. Multiple Terminal Sessions

## Why use a proxy instead of just opening two terminals?

### Advantages

- **Context preserved across switches** — Claude Code maintains the full conversation history locally. When you switch from Claude to GPT (or to another Claude account), the next model sees everything: prior dialogue, tool call results, file contents. No copy-paste, no context loss.
- **Seamless quota failover** — When one account hits its rate limit, switch to another account or a different model and keep working in the same session.
- **Multiple accounts of the same provider** — Run several Claude Pro accounts and rotate between them. This is pure passthrough with zero translation overhead — no downsides at all.
- **Single terminal, shared tooling** — One window, one set of MCP servers, hooks, skills, and permissions. No duplicating configuration across sessions.
- **Cross-model collaboration** — Write code with Claude, switch to GPT for a second opinion or review, then switch back. The reviewing model has full context of what was done.
- **Real-time statusline** — Always know which model/account is active without checking manually.
- **Scriptable and automatable** — Session switching is an HTTP API call. Future potential for automatic failover on rate limits.

### Disadvantages (cross-provider only)

These only apply when switching between Anthropic and OpenAI:

- **Slight proxy latency** — One extra hop through localhost. Negligible in practice (sub-millisecond for local proxy, plus one WebSocket connection to upstream).
- **Feature gap** — Some Anthropic-specific features (`thinking`, `cache_control`, `ephemeral` metadata) cannot be mapped to OpenAI and are silently dropped when the active session is OpenAI.

### Same-provider switching (e.g. multiple Claude Pro accounts)

**No disadvantages.** Requests are passed through to the upstream API without any translation. You get all the advantages above with zero trade-offs.

## Comparison table

| Scenario | LLM Switcher | Two separate terminals |
|---|---|---|
| Context continuity | Full history preserved across switches | Manual copy-paste between sessions |
| Quota management | Switch account in 1 command, keep working | Close terminal, open new one, re-explain context |
| Tool configuration | Shared (MCP, hooks, skills) | Must configure separately in each session |
| Multiple Claude accounts | Seamless rotation, zero overhead | Separate terminals, separate contexts |
| Cross-model review | Same session, full context | Copy code between terminals |
| Setup complexity | Proxy must be running | None |
| Feature fidelity (cross-provider) | Minor gaps (thinking, cache_control) | Native experience per model |
