# llm-switcher

`llm-switcher` is a local proxy for Claude Code and Codex CLI.

It gives you one local endpoint on `localhost:8411` and lets you switch the active backend session without restarting your client. The main use case is keeping one live coding session while rotating between:

- multiple Claude accounts
- Claude Code and OpenAI-backed sessions
- different Codex/OpenAI accounts

The point is **context continuity**: when you switch, the next model sees the same conversation, tool results, and file context already held by the client.

## What It Does Today

### Primary use cases

- **Claude Code -> Anthropic**: passthrough, including Claude OAuth sessions
- **Claude Code -> OpenAI**: Anthropic Messages requests are translated to OpenAI Responses traffic
- **Multiple Claude accounts**: switch between accounts without opening another terminal
- **Codex CLI -> OpenAI**: WebSocket bridge through the same local proxy endpoint

### Not supported yet

- **Codex CLI -> Anthropic**

That reverse translation path is not implemented yet. If you point Codex CLI at `llm-switcher`, the active session still needs to be an OpenAI/Codex-compatible one.

## Support Matrix

| Client | Backend | Status | Notes |
|---|---|---|---|
| Claude Code | Anthropic | Supported | Native passthrough |
| Claude Code | OpenAI | Supported | Translated Anthropic -> OpenAI |
| Codex CLI | OpenAI | Supported | Transparent WebSocket bridge |
| Codex CLI | Anthropic | Not yet | Reverse translation not implemented |

## Why Use This

- **Keep one session alive across switches** instead of re-explaining context in another terminal
- **Rotate Claude Pro accounts** when quota is exhausted
- **Compare models inside one workflow** by switching the backend instead of switching tools
- **Keep one local endpoint** for scripts, slash commands, and client config

If you just want Claude Code to delegate tasks to Codex, a plugin-style workflow such as [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) is simpler. `llm-switcher` is for the stronger requirement: transport-level switching while preserving the client session. See [docs/comparison.md](docs/comparison.md).

## Installation

`llm-switcher` is currently distributed as a Node.js CLI, not a standalone binary.

Requirements:

- Node.js 18 or later
- Claude Code for Claude OAuth import
- Codex CLI for Codex OAuth import

Install from source:

```bash
npm install
npm run build
npm link
```

Or run directly in the repo:

```bash
npx tsx src/cli.ts <command>
```

## Quick Start

### 1. Add sessions

Import a Claude Code OAuth session:

```bash
llm-switcher login
```

Import a Codex OAuth session:

```bash
codex
llm-switcher codex-login
llm-switcher switch codex
```

Add sessions manually with API keys:

```bash
llm-switcher add claude-work --provider anthropic --token sk-ant-...
llm-switcher add gpt-work --provider openai --token sk-... --model gpt-5.4
```

### 2. Start the proxy

```bash
llm-switcher serve
```

By default it listens on `127.0.0.1:8411`.

### 3. Point your client at the proxy

For Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8411
claude
```

For Codex CLI, add this to `~/.codex/config.toml`:

```toml
[model]
provider = "openai"
name = "gpt-5.4"

[model.openai_compatible]
base_url = "http://localhost:8411"
```

### 4. Switch sessions without restarting the client

```bash
llm-switcher list
llm-switcher switch claude-work
llm-switcher switch gpt-work
llm-switcher status
```

## CLI Commands

| Command | Description |
|---|---|
| `serve [-p port]` | Start the proxy server |
| `login [name]` | Capture a fresh Claude Code OAuth token and save it as a session |
| `codex-login [name]` | Import Codex CLI OAuth token from `~/.codex/auth.json` |
| `add <name> -p <provider> -t <token> [-b url] [-m model]` | Add a session manually |
| `remove <name>` | Remove a session |
| `list` | List all configured sessions |
| `switch <name>` | Set the active session |
| `status` | Show the active session and latest quota info |

When the proxy is running, management commands go through `http://localhost:8411/admin/*`. If it is not running, the CLI falls back to editing local config directly.

## How Sessions Work

`llm-switcher` keeps a local `config.json` in the repo directory:

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
| `base_url` | Upstream base URL |
| `model_override` | OpenAI model to send upstream |
| `account_id` | Required for Codex OAuth sessions |

The first session you add becomes active by default. You can hot-swap the active session at any time.

## Architecture

At a high level:

```text
Claude Code --HTTP /v1/messages--> llm-switcher --HTTPS--> Anthropic
Claude Code --HTTP /v1/messages--> llm-switcher --WS-----> chatgpt.com/backend-api/codex/responses
Codex CLI   --WS /responses-------> llm-switcher --WS-----> chatgpt.com/backend-api/codex/responses
```

Two important details:

- When the active session is **Anthropic**, Claude Code traffic is passed through with minimal changes.
- When the active session is **OpenAI**, Claude Code still speaks Anthropic to the proxy, and the proxy translates the request/streaming response to the OpenAI side.

For implementation details, protocol mapping, and event flow, see [docs/design.md](docs/design.md).

## Current Limitations

- **Codex CLI -> Anthropic is not implemented**
- **Claude Code -> OpenAI is a translation layer**, so some Anthropic-native features do not map perfectly
- **`max_output_tokens`, `temperature`, and `top_p` are stripped** for the Codex backend because that backend does not support them
- **OAuth tokens expire**, so `login` / `codex-login` may need to be re-run

## Related Docs

- [docs/design.md](docs/design.md) — technical design and protocol details
- [docs/comparison.md](docs/comparison.md) — comparison with multiple terminals and `codex-plugin-cc`
- [docs/oauth-api-discovery.md](docs/oauth-api-discovery.md) — notes on the Codex backend endpoint
