# llm-switcher

[![Test](https://github.com/fanqi1909/llm-switcher/actions/workflows/test.yml/badge.svg?branch=main&event=push)](https://github.com/fanqi1909/llm-switcher/actions/workflows/test.yml)
&nbsp;[中文](README.zh.md)

Switch Claude Code and Codex CLI backends locally without losing session context.

`llm-switcher` is a local proxy that sits between your AI client and the upstream provider. It gives you one local endpoint on `localhost:8411` and lets you hot-swap between Anthropic and OpenAI-backed sessions — without restarting the client or re-explaining context in a new terminal.

## What It Does

| Client | Backend | Status | Notes |
|---|---|---|---|
| Claude Code | Anthropic | Supported | Native passthrough, including OAuth |
| Claude Code | OpenAI | Supported | Translated Anthropic → OpenAI |
| Codex CLI | OpenAI | Supported | Transparent WebSocket bridge |
| Codex CLI | Anthropic | Not yet | Reverse translation not implemented |

## Why Use This

- **Keep one session alive across switches** — the next backend sees the same conversation, tool results, and file context
- **Rotate Claude Pro accounts** when quota is exhausted without breaking your workflow
- **Compare models inside one workflow** by switching the backend instead of switching tools
- **Keep one local endpoint** for scripts, slash commands, and client config

If you just want Claude Code to delegate tasks to Codex, a plugin-style workflow such as [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) is simpler. `llm-switcher` is for transport-level switching that preserves the client session. See [docs/comparison.md](docs/comparison.md).

## Status

`llm-switcher` is an **experimental but working prototype**. It is usable for real workflows but not production-hardened. Protocol compatibility may need maintenance as Claude Code, Codex CLI, and upstream backends evolve.

Tested with: Node.js `v25.8.1` · Claude Code `2.1.88` · Codex CLI `0.117.0`

## Installation

Requirements: Node.js 18+, Claude Code (for OAuth import), Codex CLI (for Codex OAuth import).

```bash
git clone git@github.com:fanqi1909/llm-switcher.git
cd llm-switcher
npm install && npm run build && npm link
```

## Quick Start

**1. Add sessions**

```bash
llm-switcher login              # import Claude Code OAuth session
llm-switcher codex-login        # import Codex OAuth session (run `codex` first)
```

Or add a session manually with an API key:

```bash
llm-switcher add claude-work --provider anthropic --token sk-ant-...
llm-switcher add gpt-work --provider openai --token sk-...
```

**2. Pin models and start**

```bash
llm-switcher set-model claude-work claude-sonnet-4-5
llm-switcher set-model gpt-work gpt-5.4
llm-switcher serve
```

**3. Point your client at the proxy**

For Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8411
claude
```

For Codex CLI, add to `~/.codex/config.toml`:

```toml
[model]
provider = "openai"
name = "gpt-5.4"

[model.openai_compatible]
base_url = "http://localhost:8411"
```

**4. Switch sessions**

```bash
llm-switcher switch claude-work
llm-switcher switch gpt-work
llm-switcher status
```

Or use the `/llm-switch` command inside any Claude Code chat window to bind just that window to a session:

```
/llm-switch gpt-work
```

Install it globally so it works outside this repo:

```bash
llm-switcher install-claude-command
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
| `models [name]` | List available models for the active or named session |
| `model [name]` | Show the configured model for the active or named session |
| `set-model <name> <model>` | Set the configured model for a session |
| `statusline [--json]` | Render provider-aware statusline text from Claude-style stdin JSON |
| `install-claude-command [--dir path]` | Install `/llm-switch` into Claude's commands directory |

When the proxy is running, management commands go through `http://localhost:8411/admin/*`. If not running, the CLI edits local config directly.

## Go Further

- [docs/sessions.md](docs/sessions.md) — session config, per-chat binding, routing priority, token refresh
- [docs/design.md](docs/design.md) — architecture, protocol mapping, and event flow
- [docs/comparison.md](docs/comparison.md) — comparison with multiple terminals and `codex-plugin-cc`
- [docs/statusline-design.md](docs/statusline-design.md) — provider-agnostic statusline integration
