# Lane Design

This document defines the next routing abstraction for `llm-switcher`.

It builds on the current global/scoped session model in [multi-session-design.md](multi-session-design.md), the workflow pressure described in [local-session-scenarios.md](local-session-scenarios.md), and the routing-source constraints already captured in [statusline-design.md](statusline-design.md).

## Problem

The current design has user-facing sessions and a few scoped override mechanisms:

- a global active session
- per-chat binding for Claude Code
- per-request/per-connection scoped session overrides

That is enough for local multi-session workflows, but it is not yet a good internal model for agent-scoped routing.

The next design pressure is sub-agents and parallel agent workflows that may want different model families or providers under one broader task context.

The project needs an internal routing abstraction that:

- works for both root agents and subagents
- keeps the user-facing session model simple
- lets child agents express intent without exposing low-level session selection
- remains deterministic and debuggable

## Goals

1. Keep sessions as the user-managed backend/account objects.
2. Introduce an internal routing abstraction for root-agent and subagent lifetimes.
3. Let child agents express only `model` and `provider` intent.
4. Preserve parent inheritance by default.
5. Resolve routing once per lane and keep it stable for the lane lifetime.
6. Fail explicitly when routing hints cannot be satisfied.
7. Keep the system explainable through admin/debug surfaces.

## Non-Goals

- user-facing lane CRUD or lane selection commands
- dynamic mid-lane rebinding
- silent fallback to parent/default/global session when hints cannot be satisfied
- policy-engine scheduling or weighted routing
- multi-user tenancy
- automatic failover after lane creation in the first iteration

## Core Concepts

### Session

A session is a real configured backend/account target.

A session owns provider-specific execution details such as:

- provider
- token / OAuth credentials
- configured model override
- health / rate limits
- usage / observability

Users manage sessions directly.

### Lane

A lane is an internal routing context created automatically for the lifetime of a root agent or subagent.

A lane is not a user-managed object. It exists so the router can preserve stable execution context while keeping the user-facing model simple.

A lane may carry:

- parent context
- requested `model`
- requested `provider`
- inferred provider
- resolved session
- resolution reason

### Root lane

A root lane is created automatically for the root agent or top-level workflow.

### Child lane

A child lane is created automatically when a subagent starts. It inherits the parent lane's routing context by default.

### Hints

Child agents may request:

- `model`
- `provider`

Child agents may not request a session directly.

## Lifecycle and Inheritance

Every root agent gets a lane when its routing context is established.

Every subagent gets a child lane when it starts.

Default behavior:

- inherit the parent lane's routing context
- if no new hints are provided, keep using the parent session
- if hints are provided, evaluate them when the child lane is created

Once a lane resolves to a session, that binding remains fixed for the lifetime of the lane.

The lane should not silently drift to another session later because that would make agent behavior harder to understand.

## Resolution Algorithm

Recommended resolution order for a child lane:

1. Start from the parent lane's resolved routing context.
2. Apply explicit child hints:
   - `provider` if present
   - `model` if present
3. If `model` is present but `provider` is omitted:
   - infer provider from a built-in model/provider mapping
   - if exactly one provider matches, continue
   - if the mapping is ambiguous, fail and require explicit provider
4. Check whether the parent session is compatible with the resolved constraints.
5. If the parent session is compatible, keep using it.
6. If the parent session is not compatible, resolve a new session from the configured session pool.
7. If no matching session exists, fail explicitly.
8. Bind the selected session to the lane for the lane lifetime.

This keeps the common path simple:

- no hint -> inherit parent session
- compatible hint -> keep parent session
- incompatible hint -> resolve a different session once

## Built-in Model/Provider Mapping

`llm-switcher` should maintain a built-in model/provider mapping for provider inference.

Purpose:

- allow child agents to specify a model without always repeating provider
- keep provider inference deterministic
- support admin/debug explanation of how routing was derived

Rules:

- if a model maps unambiguously to one provider, the router may infer that provider
- if a model name is ambiguous, the router must fail and require explicit provider
- the router should not guess when multiple providers could plausibly match the same model name

This mapping should be inspectable through `llm-switcher` admin/debug interfaces so callers can understand what will resolve successfully.

## Failure Semantics

The lane model should prefer explicit failure over silent degradation.

Routing must fail when:

- a model implies multiple possible providers and no explicit provider was given
- a requested provider/model combination cannot be satisfied by any configured session
- the routing inputs are otherwise insufficient to resolve a deterministic session

When routing fails:

- lane creation should fail clearly
- the caller should be told what to specify explicitly
- the router must not silently fall back to the parent session, global default session, or another arbitrary session

This is especially important when a caller explicitly asked for a provider or model.

## Observability and Debugging

Lane routing should be explainable.

Admin/debug visibility should make it possible to inspect:

- lane id
- parent lane id
- owner type / owner id
- requested model
- requested provider
- inferred provider
- resolved session
- resolution reason
- creation and last-used timestamps
- explicit failure reason when resolution fails

The exact admin API shape can be designed separately, but the data should be available.

## Relationship to Existing Session Selection

This lane model is additive.

Current concepts still matter:

- global active session remains useful fallback context
- per-chat binding remains a user-facing mechanism for choosing a root routing context
- scoped request/connection overrides remain valid transport-level controls

The difference is that lanes become the internal routing abstraction for agent lifetimes.

In short:

- users manage sessions
- the system manages lanes
- lanes resolve to sessions

## Implementation Impact

Likely implementation touchpoints later include:

- routing state and selection logic in `src/proxy.ts`
- configured session data in `src/config.ts`
- lane/session visibility in admin endpoints
- tests in `src/proxy.test.ts`
- statusline or panel consumers that need to distinguish requested context from resolved execution

The design doc is intentionally ahead of implementation so the terminology and failure semantics are fixed first.

## Current Recommendation

Use lanes as an internal, agent-scoped routing scope.

The first implementation should keep the model narrow:

- automatic lane creation for root agents and subagents
- parent inheritance by default
- child hints limited to `model` and `provider`
- built-in model/provider inference when unambiguous
- explicit failure on ambiguity or unsatisfied constraints
- fixed lane-to-session binding for the lane lifetime

That is enough to support future subagent routing without turning lanes into a new user-facing object.
