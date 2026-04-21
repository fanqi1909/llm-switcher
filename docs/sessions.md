# Sessions

This document covers session configuration, lifecycle, and routing in `llm-switcher`.

## Config File

`llm-switcher` keeps a local `config.json` in the repo directory (or the path set by `LLM_SWITCHER_CONFIG_PATH`):

```json
{
  "active_session": "codex",
  "sessions": {
    "codex": {
      "provider": "openai",
      "token": "<access token>",
      "base_url": "https://api.openai.com",
      "model_override": "gpt-5.4",
      "account_id": "<chatgpt account id>"
    },
    "claude-work": {
      "provider": "anthropic",
      "token": "<access token>",
      "base_url": "https://api.anthropic.com"
    }
  }
}
```

| Field | Meaning |
|---|---|
| `provider` | `anthropic` or `openai` |
| `token` | API key or OAuth access token |
| `base_url` | Upstream base URL (optional, defaults to provider default) |
| `model_override` | Model pinned for that session |
| `account_id` | Required for Codex OAuth sessions |

The file is written atomically (write to `.tmp` then rename) and all mutations are serialized in-process, so it is safe to run a single proxy instance against it.

## Session Lifecycle

### Adding sessions

Import a Claude Code OAuth session (spawns a `claude -p hi` subprocess to capture the token):

```bash
llm-switcher login [name]
```

Import a Codex OAuth session from `~/.codex/auth.json`:

```bash
codex                       # authenticate with Codex CLI first
llm-switcher codex-login [name]
```

Add a session manually with an API key:

```bash
llm-switcher add <name> --provider anthropic --token sk-ant-...
llm-switcher add <name> --provider openai --token sk-...
```

The first session added becomes the active session automatically.

### Switching the active session

```bash
llm-switcher switch <name>
llm-switcher status          # confirm the active session
```

### Pinning a model

```bash
llm-switcher models [name]       # list available models for the session
llm-switcher set-model <name> <model>
llm-switcher model [name]        # show the current pinned model
```

Session identity and model selection are intentionally separate. Switching sessions does not reset the model, and changing a model does not switch sessions.

If a provider blocks model listing for your current token, `models [name]` falls back to a built-in provider-specific suggestion list instead of failing silently.

### Removing a session

```bash
llm-switcher remove <name>
```

## Token Refresh

**Anthropic OAuth sessions** (`sk-ant-oat01-*`): when the proxy receives a 401, it automatically re-runs `claude -p hi` to sniff a fresh token and retries the request once. If the re-sniff fails, the proxy returns 502 with `type: oauth_token_refresh_failed`.

**OpenAI / Codex sessions**: when the proxy receives a 401 on a WebSocket connection, it uses the stored `refresh_token` (or reads it from `~/.codex/auth.json`) to call the Codex token refresh endpoint and reconnects. Concurrent refresh calls for the same session are deduplicated.

If automatic refresh is not possible, run `llm-switcher login` or `llm-switcher codex-login` to manually import a fresh token.

## Routing

By default `llm-switcher` uses a **global active session**: every client connected to the proxy shares the same backend.

### Session resolution order

For each incoming request, the proxy resolves the session in this priority order:

| Priority | Mechanism | How to use |
|---|---|---|
| 1 | `x-llm-session` header | Set on individual HTTP requests |
| 2 | `x-llm-switch-session` header | Compatibility alias for `x-llm-session` |
| 3 | Per-chat binding | Set via `/llm-switch` command or `POST /admin/chat-bind/` |
| 4 | `model_override` exact match | Request body `model` matches a session's pinned model |
| 5 | Session name alias | Request body `model` matches a session name exactly |
| 6 | Global active session | The current `active_session` in config |
| 7 | Provider inference | Request body `model` prefix matches a provider |

The resolved session name is returned in the `x-llm-session-used` response header so you can verify which session handled each request.

### Per-Chat Session Binding (Claude Code)

Each Claude Code chat window carries a unique `x-claude-code-session-id` on every request. The proxy uses this to let you bind individual windows to different sessions — so Chat A can run Opus while Chat B runs GPT, without affecting each other.

Use the `/llm-switch` Claude command inside any chat window:

```
/llm-switch claude-work
/llm-switch gpt-work
```

This binds only the current window. Other windows keep whatever session they are already using.

To install `/llm-switch` as a global Claude command (available outside this repo):

```bash
llm-switcher install-claude-command
```

The binding persists in memory for the lifetime of the proxy process. It is cleared when the proxy restarts.

### Scoped Session Selection (per-request)

For direct HTTP requests, pin a session for a single request with a header:

```http
x-llm-session: gpt-work
```

For Codex WebSocket connections, pass the session in the query string:

```
/responses?session=gpt-work
```

## Current Limitations

- **Codex CLI → Anthropic is not implemented.** If you point Codex CLI at `llm-switcher`, the active session must be an OpenAI/Codex-compatible one.
- **The global active session is shared** across all clients that do not have an explicit per-chat binding or `x-llm-session` header.
- **Claude Code → OpenAI is a translation layer**, so some Anthropic-native features do not map perfectly.
- **`max_output_tokens`, `temperature`, and `top_p` are stripped** for the Codex backend because that backend does not support them.
- **OAuth tokens expire**, so `login` / `codex-login` may need to be re-run when automatic refresh is unavailable.
