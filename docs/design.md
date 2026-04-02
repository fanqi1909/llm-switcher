# llm-switcher — Technical Design

## Problem statement

Claude Code speaks the Anthropic Messages API exclusively. Codex CLI speaks the OpenAI Responses API over WebSocket. Neither supports swapping the underlying model provider without reconfiguration. The goal is a transparent local proxy that:

1. Lets Claude Code drive OpenAI GPT models by translating Anthropic → OpenAI in real-time.
2. Lets Codex CLI talk to its OpenAI backend through a single local endpoint that can be switched without restarting the client.
3. Preserves streaming behavior end-to-end so both clients see native SSE or WebSocket events.

---

## Architecture overview

```
┌─────────────────┐     HTTP POST /v1/messages      ┌──────────────────────────────┐
│   Claude Code   │ ───────────────────────────────► │                              │
└─────────────────┘                                  │       llm-switcher proxy     │
                                                     │       127.0.0.1:8411         │
┌─────────────────┐     WS ws://localhost/responses  │                              │
│   Codex CLI     │ ───────────────────────────────► │                              │
└─────────────────┘                                  └──────────────┬───────────────┘
                                                                    │
                          active session = anthropic                │
                          ──────────────────────────────────────────► HTTPS api.anthropic.com
                                                                    │   (passthrough + OAuth header inject)
                          active session = openai (Claude Code)     │
                          ──────────────────────────────────────────► WSS chatgpt.com/backend-api/codex/responses
                                                                    │   (translate request, stream back as SSE)
                          active session = openai (Codex CLI)       │
                          ──────────────────────────────────────────► WSS chatgpt.com/backend-api/codex/responses
                                                                        (transparent WS bridge)
```

The proxy is a Node.js HTTP server (`node:http`) with an attached `ws.WebSocketServer`. All logic lives in four modules:

| Module | Responsibility |
|---|---|
| `proxy.ts` | HTTP routing, WebSocket server, session dispatch, OAuth header injection |
| `translate.ts` | Anthropic ↔ OpenAI request/response translation, streaming state machine |
| `config.ts` | Session CRUD, `config.json` persistence |
| `codex.ts` | Codex-specific header construction, `~/.codex/auth.json` reader |
| `login.ts` | OAuth token sniffing via ephemeral HTTP server + `claude -p hi` |
| `cli.ts` | Commander CLI; talks to proxy admin API or falls back to direct config writes |

---

## Translation layer design

### Request mapping: Anthropic Messages → OpenAI Responses API

`translateRequest()` in `translate.ts` maps an Anthropic `POST /v1/messages` body to an OpenAI Responses API payload.

| Anthropic field | OpenAI field | Notes |
|---|---|---|
| `model` | (ignored) | `session.model_override` is always used |
| `system` (string or block array) | `instructions` | Billing header blocks filtered out; joined with `\n` |
| `messages` | `input` | See message mapping below |
| `tools[].name/description/input_schema` | `tools[].name/description/parameters` | `type` forced to `"function"` |
| `tool_choice "any"` | `"required"` | Other string values passed through |
| `tool_choice {type:"tool", name}` | `{type:"function", name}` | |
| `max_output_tokens`, `temperature`, `top_p` | (stripped) | Not supported by Codex backend |

**Message mapping** (`translateMessages`):

- `role: "user"`, string content → `{type:"message", role:"user", content: <string>}`
- `role: "user"`, array content:
  - `tool_result` blocks → `{type:"function_call_output", call_id, output}` items (emitted before any text)
  - `text` blocks → collapsed into a single `{type:"message", role:"user"}` item
  - `image` blocks → `{type:"input_image", image_url}` (base64 data URI or raw URL)
- `role: "assistant"`, array content:
  - `text` blocks → flushed as `{type:"message", role:"assistant"}` before any tool-use block
  - `tool_use` blocks → `{type:"function_call", id, call_id, name, arguments}` (ID prefix conversion applied)
  - `thinking` blocks → silently skipped

### ID prefix conversion

Anthropic uses `toolu_` prefixes for tool-use IDs; OpenAI uses `fc_` or `call_` prefixes. The proxy normalises in both directions:

- **To OpenAI:** `toFcId(id)` — if `id` does not start with `fc_`, prepend it: `fc_<original>`. A per-request `idMap` caches mappings so `tool_result` blocks referencing the same call can resolve correctly.
- **From OpenAI:** `toToolUseId(id)` — strips `call_` prefix if present, then prepends `toolu_`.

### Response mapping: OpenAI Responses → Anthropic Messages

`translateResponse()` maps a complete `response.completed` event payload:

| OpenAI field | Anthropic field | Notes |
|---|---|---|
| `output[].type=="message"` content parts with `type=="output_text"` | `content[].{type:"text", text}` | |
| `output[].type=="function_call"` | `content[].{type:"tool_use", id, name, input}` | `call_id` → `toolu_` prefix |
| `status` | `stop_reason` | `"completed"` → `"end_turn"`, `"incomplete"` → `"max_tokens"` |
| `usage.input_tokens` / `usage.output_tokens` | `usage.input_tokens` / `usage.output_tokens` | |
| `id` | `id` prefixed with `msg_` | |

### Streaming: WebSocket events → Anthropic SSE

`createWsEventProcessor()` returns a stateful function that maps OpenAI Responses API WebSocket events to Anthropic SSE events. It is called once per request; state is local to that call.

**State machine fields:**

```typescript
interface StreamState {
  started: boolean;
  messageId: string;
  model: string;
  contentBlockIndex: number;         // monotonically increasing Anthropic block index
  textBlockOpen: boolean;            // whether a text content_block is currently open
  toolBlockByOutputIndex: Map<       // output_index (OpenAI) → {blockIdx, callId}
    number,
    { blockIdx: number; callId: string }
  >;
  inputTokens: number;
  outputTokens: number;
}
```

**Event mapping:**

| OpenAI WS event | Anthropic SSE event(s) emitted |
|---|---|
| `response.created` | `message_start` |
| `response.content_part.added` | `content_block_start {type:"text"}` (if not already open) |
| `response.output_item.added` (message) | (no-op; text deltas follow) |
| `response.output_item.added` (function_call) | Close open text block if any; `content_block_start {type:"tool_use"}` |
| `response.output_text.delta` | `content_block_delta {type:"text_delta"}` (auto-opens text block if needed) |
| `response.output_text.done` | `content_block_stop` for the text block |
| `response.function_call_arguments.delta` | `content_block_delta {type:"input_json_delta"}` |
| `response.function_call_arguments.done` | `content_block_stop` for the tool block |
| `response.completed` | Close all open blocks; `message_delta` with `stop_reason` and token counts |
| `{type:"_finish"}` (internal sentinel) | `message_stop` |
| `error` | Terminate with 502 |

The `_finish` sentinel is injected by `handleOpenAIProxy` after `response.completed` is received to ensure `message_stop` is always the final SSE event.

---

## Key discovery: Codex OAuth endpoint

Codex CLI OAuth tokens (JWT, issued by `auth.openai.com`) do **not** work against `api.openai.com`. The actual endpoint is:

```
wss://chatgpt.com/backend-api/codex/responses
```

Required headers (constructed by `buildCodexHeaders()`):

```
authorization: Bearer <access_token>
chatgpt-account-id: <account_id from auth.json>
originator: codex_exec
version: 0.117.0
user-agent: codex_exec/0.117.0
```

The `account_id` is extracted from `~/.codex/auth.json` at `tokens.account_id` during `codex-login` and stored in the session record.

---

## WebSocket bridge (Codex CLI passthrough)

When the active session is `openai` and Codex CLI connects to `ws://localhost:8411/responses`, the proxy creates a second WebSocket to `wss://chatgpt.com/backend-api/codex/responses` and bridges the two connections transparently.

Design decisions:

- **Frame type preserved.** Messages are forwarded as text or binary frames matching what the sender used. This avoids re-encoding issues with binary protocol extensions.
- **Buffering during upstream handshake.** Client messages arriving before the upstream WebSocket opens are queued in `buffered[]` and flushed on `upstreamWs.on("open")`.
- **Symmetric close propagation.** Each side's `close` event triggers `close()` on the other side. Each side's `error` event logs and then closes the peer.
- **No translation.** The Codex CLI speaks the OpenAI Responses WebSocket protocol natively; the proxy does not inspect or modify the frames.

---

## HTTP → WebSocket bridge (Claude Code → OpenAI)

When Claude Code sends a `POST /v1/messages` to the proxy and the active session is `openai`, the flow is:

1. `handleOpenAIProxy` translates the request body with `translateRequest()`.
2. A WebSocket is opened to `wss://chatgpt.com/backend-api/codex/responses`.
3. On `open`, a `response.create` message is sent carrying the translated body.
4. Incoming WS messages are fed to `createWsEventProcessor()`.
   - If the original request had `stream: true`, SSE events are written to the HTTP response immediately.
   - If `stream: false`, events are buffered; on `response.completed` the entire response is assembled by `translateResponse()` and returned as a single JSON body.
5. On `response.completed` (streaming case), the `_finish` sentinel is injected to emit `message_stop`, then the HTTP response is closed and the WebSocket is terminated.

Error paths: a WS `error` event or an early `close` returns `502` to the HTTP client (if the response has not already been committed).

---

## Unsupported parameters

The `chatgpt.com/backend-api/codex` backend rejects or ignores several Anthropic parameters. The proxy silently strips them before building the OpenAI request body:

- `max_output_tokens`
- `temperature`
- `top_p`

No warning is emitted to the client. If these parameters are critical, use an Anthropic session instead.

---

## Admin API

The proxy exposes a lightweight admin API on the same port:

| Method | Path | Description |
|---|---|---|
| GET/HEAD | `/` | Health check |
| GET | `/admin/sessions` | List all sessions (tokens redacted in status endpoint, not here) |
| POST | `/admin/sessions` | Add a session (`name`, `provider`, `token` required) |
| DELETE | `/admin/sessions/:name` | Remove a session |
| POST | `/admin/switch/:name` | Change the active session |
| GET | `/admin/status` | Active session (token omitted) and last-seen rate-limit headers |
| GET | `/v1/models` | Proxy to OpenAI models endpoint with Codex headers |

Rate-limit headers (`x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`) from Anthropic responses are cached per session name and surfaced through `/admin/status`.

---

## Session Selection Model

The proxy now has two session-selection modes:

- **global default session** — used when no scoped override is provided
- **scoped session override** — used for one request or one WebSocket connection

Scoped selection currently works as follows:

- **HTTP**: `x-llm-session: <name>` (preferred; `x-llm-switch-session` remains a compatibility alias)
- **WebSocket**: `/responses?session=<name>`

Semantics:

- HTTP overrides apply only to that request
- WebSocket overrides apply for the lifetime of that connection
- if no scoped session is present, the proxy uses the global active session

This preserves backward compatibility while allowing multiple local sessions to be pinned differently.

---

## OAuth token capture (`login` command)

`sniffOAuthToken()` automates token capture without requiring the user to intercept network traffic:

1. An ephemeral HTTP server is started on a random loopback port.
2. `claude -p hi --output-format json --max-turns 1` is spawned with `ANTHROPIC_BASE_URL` pointed at the ephemeral server.
3. Claude Code sends a `POST /v1/messages` with an `Authorization: Bearer sk-ant-oat01-...` header.
4. The server captures the token from the header, returns a synthetic `529 overloaded_error` (causing `claude` to exit cleanly), and resolves the promise.
5. The token is stored in a new `anthropic` session.

---

## Future work

- **Reverse translation (OpenAI → Anthropic) for Codex CLI.** When a Codex CLI client connects and the operator wants to use an Anthropic model as the backend, the proxy would need to translate OpenAI Responses API WebSocket frames into Anthropic Messages API calls and stream results back as OpenAI events. This is the inverse of the current Claude Code → OpenAI path and is not yet implemented.
- **Token refresh.** Both Claude Code OAuth and Codex OAuth tokens have expiry times. Automatic refresh using `refresh_token` from `~/.codex/auth.json` (or the Claude Code keychain) would eliminate the need to re-run `login` commands.
- **Richer connection-aware session management.** The first scoped-selection layer now exists, but there is still no visibility into pinned connections, no rebinding flow, and no higher-level lane model for sub-agents or parallel task routing.
- **Statusline context abstraction.** The proxy now has enough routing modes that UI integrations should no longer treat `active_session` as if it were always the current window's effective backend. See [statusline-design.md](statusline-design.md) for the provider-agnostic model.
- **Tool call result validation.** The proxy does not validate that tool result IDs correspond to previously issued tool calls. Stricter ID tracking would improve error messages for multi-turn tool loops.
