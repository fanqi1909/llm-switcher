# Statusline Design

This document defines a provider-agnostic statusline model for `llm-switcher`.

The immediate trigger is issue #9: once `llm-switcher` supports both a global default session and scoped session overrides, a statusline must stop treating the global default as if it were always the current window's actual backend.

The design here is intentionally **not Claude-only**. It should also leave room for future Codex statusline integration.

## Problem

There are now at least three distinct states that a UI may need to distinguish:

1. the proxy's **global default session**
2. the **current window's effective routed session**
3. a **direct / non-proxy** window that is not using `llm-switcher` at all

If a statusline reads only `/admin/status` or `active_session`, it can easily mislabel the current window.

That was tolerable when the proxy only had one global active session model. It is no longer acceptable once scoped overrides exist.

## Design Goals

1. Prefer the current window's real routing context over any shared global proxy state.
2. Keep the model generic enough to support both Claude Code and Codex.
3. Distinguish clearly between:
   - direct / non-proxy usage
   - proxy usage with a scoped session
   - proxy usage with only a global default
4. Avoid implying certainty when only fallback information is available.
5. Keep simple single-window workflows readable and backward compatible.

## Non-Goals

- Implementing a full statusline renderer in this document
- Baking Claude Code-specific naming into the shared model
- Inferring a window's actual backend from proxy-global state alone
- Solving multi-user tenancy

## Inputs

Any statusline integration should combine multiple signal sources instead of relying on one global value.

### 1. Client-specific runtime context

For Claude Code, the custom statusline command receives a JSON payload on stdin. Relevant examples include:

- `session_id`
- `session_name`
- `cwd`
- `agent_id`
- `agent_type`
- `model.id`
- `model.display_name`

This gives a reliable view of the current client session, but it does not appear to include a provider/backend field.

### 2. Process-level environment

This is the strongest signal for whether the current window is using the proxy at all.

Examples:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_CUSTOM_HEADERS`

These are per-process / per-window signals, not global proxy state.

### 3. Proxy-global fallback state

The proxy can expose shared information such as:

- current global default session
- available sessions
- rate limits

This is useful, but it must be treated as **fallback context**, not as proof of the current window's actual route.

## Recommended Shared Model

Statusline integrations should normalize their inputs into a provider-agnostic structure like this:

```ts
type RoutingSource =
  | "direct"
  | "scoped"
  | "proxy_default"
  | "unknown";

type StatuslineRoutingContext = {
  client: "claude" | "codex" | "unknown";
  uses_proxy: boolean;
  scoped_session?: string;
  proxy_default_session?: string;
  effective_session?: string;
  source: RoutingSource;
};
```

### Semantics

- `uses_proxy`
  - true only when the current window/process is explicitly configured to use `llm-switcher`
- `scoped_session`
  - the pinned session for this window if one is explicitly configured
- `proxy_default_session`
  - the proxy's current global default session, used only as fallback context
- `effective_session`
  - the best current guess for what this window is actually using
- `source`
  - how `effective_session` was derived

## Resolution Order

Any adapter should resolve state in this order:

1. **Scoped session**
   - if the current process/window explicitly sets a scoped session, use that
2. **Direct / non-proxy**
   - if the current process is not configured to use the local proxy, mark it as direct and do not show proxy-default state as if it were local truth
3. **Proxy default**
   - if the process is using the proxy but no scoped session is configured, fall back to the proxy global default
4. **Unknown**
   - if the adapter cannot determine the state confidently, say so

## Adapter Pattern

The key design decision is:

- **client adapters gather signals**
- **shared statusline logic renders the normalized model**

### Claude adapter

Inputs:

- stdin JSON payload from Claude Code
- process env
- optional proxy admin lookup

Responsibilities:

- detect whether the current Claude process is pointed at the local proxy
- detect a pinned session from custom headers
- only use proxy global default as fallback

### Future Codex adapter

Inputs may differ from Claude Code, but the adapter should still populate the same normalized structure.

That means the display layer should not assume:

- Anthropic-specific env names
- Claude-specific payload fields
- one fixed way of representing session selection

## Display Rules

The statusline should avoid implying more certainty than it actually has.

Recommended examples:

- scoped / pinned:
  - `proxy: gpt-work`
- proxy default only:
  - `proxy default: gpt-work`
- direct / non-proxy:
  - no proxy badge, or `direct`
- unknown:
  - `proxy: unknown`

What it should not do:

- show `gpt-5.4` by itself when that value really came from proxy-global fallback

## Why This Is Future-Proof

This model is flexible enough for:

- current Claude Code statusline integration
- future Codex statusline integration
- possible lane-based session routing later
- richer per-window or per-agent routing in the future

The important part is that the model encodes **source of truth**, not just the resolved label.

## Current Status

The first implementation slice now exists:

1. `llm-switcher statusline` acts as a Claude-oriented adapter
2. it reads stdin JSON from the current client session
3. it checks process-level proxy env first
4. it falls back to proxy-global default only when needed

This keeps the first implementation useful without locking the architecture to Claude-specific assumptions.

## Suggested Next Step

After validating the Claude flow:

1. refine display wording if needed
2. decide whether direct windows should render `direct` or stay visually quieter
3. add a Codex adapter that populates the same normalized model
