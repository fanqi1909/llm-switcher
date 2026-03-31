# Multi-Session Design

This document proposes the next session model for `llm-switcher`.

It is driven by the workflow scenarios in [local-session-scenarios.md](local-session-scenarios.md), especially:

- quota failover without context loss
- multi-account rotation
- model-for-task switching
- multiple local sessions in parallel
- future sub-agent lanes using different model families

## Problem

The current design uses one **global active session** for the entire local proxy.

That works well for:

- one operator
- one main workflow
- one backend switch at a time

But it breaks down when the same operator runs multiple local sessions in parallel and wants them pinned differently.

Examples:

- Claude window A should stay on `claude-work`
- Claude window B should stay on `gpt-review`
- Codex session C should stay on `gpt-fast`

With the current model, switching any one of them changes the backend for all of them.

## Design Goals

1. Preserve the current simple global mode for users who only need one active session.
2. Allow multiple local sessions to run in parallel without backend coupling.
3. Stay local-first and single-operator oriented.
4. Avoid requiring major client-side changes for the default path.
5. Make the session-selection mechanism explicit and debuggable.

## Non-Goals

- Multi-user tenancy
- Distributed/shared proxy coordination
- Full policy engine for dynamic routing
- Automatic model scheduling across many parallel agents in the first iteration

## Design Options

### Option A: Keep global active session only

Pros:

- simplest implementation
- easiest mental model
- no protocol changes

Cons:

- does not solve parallel local sessions
- one local lane can unexpectedly affect another
- limits future sub-agent routing

Conclusion:

- good MVP
- not sufficient as the next step

### Option B: Per-request override

The client specifies the session name on every request.

Possible forms:

- HTTP header
- query parameter
- request field

Pros:

- simple routing model
- no server-side session binding state
- easy to observe and debug

Cons:

- noisy for repeated requests
- requires the client or wrapper to resend the selection every time
- less natural for long-lived WebSocket connections

Conclusion:

- useful as an override mechanism
- not ideal as the primary model for long-lived local sessions

### Option C: Per-connection binding

A connection is assigned a session once, then keeps using it until the connection closes or is explicitly rebound.

Possible forms:

- HTTP requests carry a stable session key or lane identifier
- WebSocket connection includes a session selection at connect time
- the proxy remembers the binding for that lane/connection

Pros:

- matches how local parallel sessions actually behave
- natural fit for long-lived Codex/Claude workflows
- avoids global interference

Cons:

- requires new binding semantics
- requires some notion of connection identity or lane identity
- more stateful than the current design

Conclusion:

- best long-term fit
- likely the right model to grow into

### Option D: Hybrid model

Keep the global active session as the default, but add optional scoped overrides.

Behavior:

- if no scoped session is provided, use the global active session
- if a scoped session is provided, use that for the request/connection

Pros:

- backward compatible
- preserves the current simple UX
- supports advanced local parallel workflows
- gives a clear migration path

Cons:

- two modes to explain
- requires careful status/debugging UX

Conclusion:

- best MVP direction

## Recommended MVP

Use the **hybrid model**.

### Default behavior

- keep the current global active session model unchanged

### New capability

- add an optional scoped session selection mechanism
- when present, it overrides the global active session for that request/connection

## Recommended Selection Mechanism

For the first iteration:

- **HTTP**: allow a request header such as `x-llm-switch-session: <name>`
- **WebSocket**: allow a query parameter such as `/responses?session=<name>`

Why this shape:

- simple to inspect in logs and debugging
- low implementation complexity
- does not require modifying request bodies
- works with the current local-proxy architecture

## Expected Semantics

### HTTP

- no session override: use global active session
- session override present: use the named session for that request only

### WebSocket

- no session override: bind the connection to the global active session at connect time
- session override present: bind the connection to the named session for the lifetime of that connection

This avoids surprising mid-connection backend flips.

## Admin / UX Implications

The current `switch` command should remain, but its meaning becomes:

- change the **default global session**

That is still useful for:

- simple workflows
- one-main-lane operation
- quick manual failover

But once scoped sessions exist, users also need visibility into:

- which sessions exist
- which one is the global default
- which clients/connections are explicitly pinned elsewhere

The first MVP does not need full connection introspection, but the design should leave room for it.

## Why This Is Worth Doing

This change is the natural next step because it unlocks:

- parallel local Claude/Codex sessions
- cleaner quota failover for only one active lane
- model specialization across simultaneous tasks
- future sub-agent lanes with different model assignments

without breaking the current simple usage model.

## Open Questions

1. Should HTTP scoped selection be header-only, or also support query params?
2. Should WebSocket binding happen only at connect time, or also allow explicit rebinding messages later?
3. How much visibility into active bindings is needed for debugging?
4. Should rate-limit tracking remain per session name, or also become connection-aware later?

## Recommended Next Step

Do not implement immediately.

First:

1. validate this design direction against real workflows
2. decide the exact scoped selection interface
3. then implement the smallest hybrid version

That smallest version is likely:

- global active session remains
- HTTP request header override
- WebSocket query-param override
- no advanced rebinding yet
