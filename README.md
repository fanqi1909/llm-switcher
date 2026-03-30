# llm-switcher

A local proxy that lets you use **Claude Code with OpenAI models** and **Codex CLI with Anthropic models** by translating between API formats in real-time. Run it as a sidecar on `localhost:8411`; point Claude Code or Codex CLI at it instead of their respective upstream APIs. The proxy inspects the active session, translates Anthropic Messages API requests into OpenAI Responses API calls (and vice versa), then streams the results back in the format the client expects.

---

## Quick start

### 1. Install

```bash
npm install
npm run build
npm link          # makes `llm-switcher` available on PATH
```

Or run directly with tsx:

```bash
npx tsx src/cli.ts <command>
```

### 2. Add a session

**Anthropic OAuth (Claude Code account):**

```bash
llm-switcher login          # spawns a silent `claude` request to sniff the OAuth token
```

**Codex CLI OAuth:**

```bash
codex                       # log in once with the Codex CLI to populate ~/.codex/auth.json
llm-switcher codex-login    # imports the token into llm-switcher
llm-switcher switch codex   # activate the session
```

**Manual API key:**

```bash
llm-switcher add my-key --provider anthropic --token sk-ant-...
llm-switcher add gpt-key  --provider openai   --token sk-...   --model gpt-5.4
```

### 3. Start the proxy

```bash
llm-switcher serve          # listens on 127.0.0.1:8411
llm-switcher serve -p 9000  # custom port
```

### 4. Configure clients

**Claude Code** — redirect all Anthropic API calls through the proxy:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8411
claude
```

Or set it permanently in your shell profile. The proxy forwards requests to the upstream configured in the active session (Anthropic API key, Anthropic OAuth, or translates to OpenAI).

**Codex CLI** — add to `~/.codex/config.toml`:

```toml
[model]
provider = "openai"
name = "gpt-5.4"

[model.openai_compatible]
base_url = "http://localhost:8411"
```

Codex CLI uses a WebSocket connection; the proxy bridges it to `wss://chatgpt.com/backend-api/codex/responses`.

---

## CLI commands

| Command | Description |
|---|---|
| `serve [-p port]` | Start the proxy server (default port 8411) |
| `login [name]` | Capture a fresh Claude Code OAuth token and register it as a session |
| `codex-login [name]` | Import Codex CLI OAuth token from `~/.codex/auth.json` |
| `add <name> -p <provider> -t <token> [-b url] [-m model]` | Register a session manually |
| `remove <name>` | Delete a session |
| `list` | Show all sessions; active session is highlighted |
| `switch <name>` | Make a session active (hot-swap while proxy is running) |
| `status` | Show active session and latest rate-limit data |

CLI commands prefer talking to the running proxy over HTTP (`localhost:8411/admin/*`) and fall back to editing `config.json` directly when the proxy is not running.

---

## Claude Code integration

### ANTHROPIC_BASE_URL

Set before launching Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8411
```

Claude Code sends a `HEAD /` health-check before every session; the proxy responds with `200 OK`.

### /llm-switch slash command

The file `.claude/commands/llm-switch.md` registers a `/llm-switch` command inside Claude Code:

- `/llm-switch` — lists sessions and asks which to switch to
- `/llm-switch codex-1` — immediately switches to the named session

The command uses `curl` to call the proxy's admin API, so the proxy must be running.

### Status line

Use `llm-switcher status` from a terminal pane to check which session is active and view remaining quota.

---

## Codex CLI integration

The proxy exposes two endpoints that Codex CLI uses:

- `GET /v1/models` — proxied to `https://api.openai.com/v1/models` with Codex OAuth headers
- `ws://localhost:8411/responses` — WebSocket bridge to `wss://chatgpt.com/backend-api/codex/responses`

Available models confirmed to work with Codex OAuth:

- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.3-codex`
- `gpt-5.2-codex`
- `gpt-5.2`
- `gpt-5.1-codex-max`
- `gpt-5.1-codex-mini`

---

## How it works

The proxy sits between the client and the upstream API. On each request it checks the active session's `provider` field:

- **provider = anthropic** — the request is forwarded as-is to the Anthropic Messages API (supports both API keys and OAuth tokens; OAuth requests get the required billing header injected automatically).
- **provider = openai** — the Anthropic Messages request is translated to an OpenAI Responses API call, sent over WebSocket to `wss://chatgpt.com/backend-api/codex/responses`, and the streaming WebSocket events are translated back to Anthropic SSE events before being written to the client.

Sessions can be switched at any time without restarting the proxy.

### Architecture

```
Claude Code ──HTTP POST /v1/messages──► Proxy ──WS──► wss://chatgpt.com/backend-api/codex/responses
                                         │              (OpenAI Responses API, translate request/response)
                                         │
Claude Code ──HTTP POST /v1/messages──► Proxy ──HTTPS──► https://api.anthropic.com/v1/messages
                                         │               (passthrough, OAuth header injection)
                                         │
Codex CLI   ──WS /responses──────────► Proxy ──WS──► wss://chatgpt.com/backend-api/codex/responses
                                                      (transparent frame-level bridge)
```

---

## Session configuration

`config.json` (auto-created, mode 0600):

```json
{
  "active_session": "codex-1",
  "sessions": {
    "codex-1": {
      "provider": "openai",
      "token": "<Codex OAuth access token>",
      "base_url": "https://api.openai.com",
      "model_override": "gpt-5.4",
      "account_id": "<chatgpt_account_id from auth.json>"
    },
    "claude-pro": {
      "provider": "anthropic",
      "token": "sk-ant-oat01-...",
      "base_url": "https://api.anthropic.com"
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `provider` | yes | `anthropic` or `openai` |
| `token` | yes | API key or OAuth access token |
| `base_url` | yes | Upstream API base URL |
| `model_override` | openai only | Model name sent to OpenAI (required for OpenAI sessions) |
| `account_id` | openai only | ChatGPT account ID required for Codex OAuth (`chatgpt-account-id` header) |

---

## Known limitations

- **GPT tool compatibility with Claude Code is imperfect.** Claude Code issues tool calls using the Anthropic tool-use format; the proxy translates them to OpenAI `function_call` items. Edge cases around multi-turn tool loops and parallel tool calls may produce unexpected results.
- **No Codex-to-Anthropic reverse translation yet.** When a Codex CLI session is active, traffic from Codex CLI is bridged directly to OpenAI's backend. Using an Anthropic model as the backend for Codex CLI is not yet implemented.
- **Unsupported parameters stripped.** `max_output_tokens`, `temperature`, and `top_p` are silently dropped when translating to the `chatgpt.com/backend-api/codex` backend, which does not support them.
- **OAuth tokens expire.** Re-run `llm-switcher login` or `llm-switcher codex-login` after a token expires.
