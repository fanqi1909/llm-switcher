# llm-switcher

[![Test](https://github.com/fanqi1909/llm-switcher/actions/workflows/test.yml/badge.svg?branch=main&event=push)](https://github.com/fanqi1909/llm-switcher/actions/workflows/test.yml)

Switch Claude Code and Codex CLI backends locally without losing session context.

`llm-switcher` is a local proxy for Claude Code and Codex CLI that switches between Anthropic and OpenAI-backed sessions without forcing you to restart the client or split work across multiple terminals.

It gives you one local endpoint on `localhost:8411` and preserves **context continuity** while you rotate between:

- multiple Claude accounts
- Claude Code and OpenAI-backed sessions
- different Codex/OpenAI accounts

When you switch, the next backend still sees the same conversation, tool results, and file context already held by the client.

## Status

`llm-switcher` is currently an **experimental but working prototype**.

- Core flows are working for Claude Code -> OpenAI, Claude Code -> Anthropic, and Codex CLI -> OpenAI
- The project is usable for real workflows, but it is **not production-hardened**
- Protocol compatibility may need maintenance as Claude Code, Codex CLI, and upstream backends evolve

## Tested Setup

The current repo has been tested with:

- Node.js `v25.8.1`
- Claude Code `2.1.88`
- Codex CLI `0.117.0`

## What It Does Today

### Primary use cases

- **Claude Code -> Anthropic**: passthrough, including Claude OAuth sessions
- **Claude Code -> OpenAI**: Anthropic Messages requests are translated to OpenAI Responses traffic
- **Claude Code -> GLM Coding Plan**: Anthropic-compatible passthrough via the GLM Claude endpoint
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
| Claude Code | GLM Coding Plan | Experimental | Anthropic-compatible endpoint |
| Codex CLI | OpenAI | Supported | Transparent WebSocket bridge |
| Codex CLI | Anthropic | Not yet | Reverse translation not implemented |

### Why not point Claude directly at GLM/Z.AI?

GLM and Z.AI both expose Claude-compatible endpoints, but their direct Claude setup typically maps Claude-facing model slots such as Opus, Sonnet, and Haiku onto provider-defined backend models.

`llm-switcher` intentionally keeps that control in the local session layer instead:

- provider choice stays explicit
- `model_override` stays explicit
- GLM remains one backend among many
- switching between GLM, GPT, and real Claude sessions still happens locally through the same workflow

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

## For Early Users

If you are one of the first external users, the easiest setup today is still source install:

```bash
git clone git@github.com:fanqi1909/llm-switcher.git
cd llm-switcher
npm install
npm run build
npm link
```

Then do the minimal first-run flow:

```bash
llm-switcher login claude
llm-switcher codex-login gpt-work
llm-switcher add glm-work --provider glm --token <GLM_API_KEY>
llm-switcher set-model claude claude-sonnet-4-5
llm-switcher set-model gpt-work gpt-5.4
llm-switcher set-model glm-work glm-4.7
llm-switcher serve
```

If you want Claude to expose `/llm-switch` outside this repo:

```bash
llm-switcher install-claude-command
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

Optional: install `/llm-switch` as a global Claude command so it is available outside this repo:

```bash
llm-switcher install-claude-command
```

### 4. Switch sessions

```bash
llm-switcher list
llm-switcher models claude-work
llm-switcher models gpt-work
llm-switcher set-model claude-work claude-sonnet-4-5
llm-switcher set-model gpt-work gpt-5.4
llm-switcher model claude-work
llm-switcher model gpt-work
llm-switcher switch claude-work
llm-switcher switch gpt-work
llm-switcher status
```

## Manual Session Setup

If you do not want to import OAuth sessions, you can also add sessions manually:

```bash
llm-switcher add claude-work --provider anthropic --token sk-ant-...
llm-switcher add gpt-work --provider openai --token sk-...
llm-switcher add glm-work --provider glm --token <GLM_API_KEY>
llm-switcher set-model gpt-work gpt-5.4
llm-switcher set-model glm-work glm-4.7
```

## CLI Commands

| Command | Description |
|---|---|
| `serve [-p port]` | Start the proxy server |
| `login [name]` | Capture a fresh Claude Code OAuth token and save it as a session |
| `codex-login [name]` | Import Codex CLI OAuth token from `~/.codex/auth.json` |
| `add <name> -p <provider> -t <token> [-b url] [-m model]` | Add a session manually (`provider`: `anthropic`, `openai`, or `glm`) |
| `remove <name>` | Remove a session |
| `list` | List all configured sessions |
| `models [name]` | List available models for the active or named session |
| `model [name]` | Show the configured model for the active or named session |
| `set-model <name> <model>` | Set the configured model for a session |
| `switch <name>` | Set the active session |
| `status` | Show the active session and latest quota info |
| `statusline [--json]` | Render provider-aware statusline text from Claude-style stdin JSON |
| `install-claude-command [--dir path]` | Install `/llm-switch` into Claude's commands directory |

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
    },
    "glm-work": {
      "provider": "glm",
      "token": "<glm api key>",
      "base_url": "https://open.bigmodel.cn/api/anthropic",
      "model_override": "glm-4.7"
    }
  }
}
```

| Field | Meaning |
|---|---|
| `provider` | `anthropic`, `openai`, or `glm` |
| `token` | API key or OAuth access token |
| `base_url` | Upstream base URL |
| `model_override` | Model currently pinned for that session |
| `account_id` | Required for Codex OAuth sessions |

The first session you add becomes active by default. You can hot-swap the active session at any time.

Session identity and model selection are intentionally separate:

- use `login`, `codex-login`, or `add` to create the session
- use `models [name]` to inspect the provider's available models
- use `set-model <name> <model>` to pin one model for that session
- use `model [name]` to check the current pinned model

If a provider blocks model listing for your current token, `models [name]` falls back to a built-in provider-specific suggestion list instead of failing silently.

For GLM Coding Plan, `glm` sessions use the Anthropic-compatible Claude endpoint by default:

```text
https://open.bigmodel.cn/api/anthropic
```

By default, `llm-switcher` uses a **global active session** model: one local switch affects all clients connected to the proxy.

For more advanced local workflows, you can also override the default session per request or per WebSocket connection.

### Scoped Session Selection

Use a scoped override when you want one local lane pinned differently from the global default.

For HTTP requests:

```http
x-llm-session: gpt-work
```

For Codex WebSocket connections:

```text
/responses?session=gpt-work
```

If no scoped session is provided, the proxy uses the current global active session.

`x-llm-switch-session` is still accepted as a compatibility alias, but `x-llm-session` is the preferred header going forward.

For proxied HTTP requests, the response includes:

```http
x-llm-session-used: <session-name>
```

This makes it easy to verify which session actually handled a request when you are using scoped overrides.

For Claude Code custom statusline integration, `llm-switcher statusline` reads the statusline JSON payload on stdin and resolves proxy state from the current process env before falling back to proxy-global defaults.

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

For implementation details, protocol mapping, and event flow, see [docs/design.md](docs/design.md). For statusline-specific design notes, see [docs/statusline-design.md](docs/statusline-design.md).

## Current Limitations

- **Codex CLI -> Anthropic is not implemented**
- **The default session is still global.** Scoped overrides exist, but the main `switch` command still changes the default backend for all clients that do not explicitly pin a session.
- **Claude Code -> OpenAI is a translation layer**, so some Anthropic-native features do not map perfectly
- **`max_output_tokens`, `temperature`, and `top_p` are stripped** for the Codex backend because that backend does not support them
- **OAuth tokens expire**, so `login` / `codex-login` may need to be re-run

## Related Docs

- [docs/design.md](docs/design.md) — technical design and protocol details
- [docs/agent-guidelines.md](docs/agent-guidelines.md) — repo-wide guidance for coding agents
- [docs/statusline-design.md](docs/statusline-design.md) — provider-agnostic statusline design for Claude/Codex
- [docs/comparison.md](docs/comparison.md) — comparison with multiple terminals and `codex-plugin-cc`
- [docs/oauth-api-discovery.md](docs/oauth-api-discovery.md) — notes on the Codex backend endpoint
