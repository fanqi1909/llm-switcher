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

## Current Claude Code Constraint

Claude Code does not currently expose agent lineage to the proxy HTTP layer.

The proxy can observe transport-level request data such as:

- `x-llm-session`
- `x-claude-code-session-id`
- request `body.model`

But it does **not** currently receive Claude Code internal fields such as:

- `agent_id`
- `parent_agent_id`
- `agent_type`

That means the proxy cannot yet create or manage true root-agent and subagent lane lifecycle state directly from current Claude Code request metadata.

As a result, the full lane model in this document should be read as the target architecture, while the first practical implementation step must be based on the request-level signals the proxy can actually observe today.

## Target Architecture

The intended long-term model is still an internal lane abstraction with:

- root lanes
- child lane inheritance
- fixed lane-to-session binding
- explainable admin/debug visibility

That architecture remains the goal, but it cannot be fully implemented until the client exposes a stable, proxy-visible way to distinguish root-agent and subagent request identity.

## Phased Implementation

### Phase 1: per-request model-based session resolution

The first practical step should not try to invent hidden lane lifecycle state that the proxy cannot observe.

Instead, phase 1 should route Claude Code requests using the only per-request differentiator that is currently available to the proxy: `body.model`.

Recommended phase-1 behavior:

1. keep explicit `x-llm-session` as the highest-priority override
2. if no explicit session override exists, inspect `body.model` for exact `model_override` or session-name matches
3. if no exact model-based match exists, prefer the current global active session
4. if there is no active session, fall back to existing per-chat binding
5. only then infer provider from built-in model/provider mapping and resolve a compatible session from the configured session pool
6. keep this deterministic and avoid health-based failover in the first step

This is not true lane identity. It is a request-scoped routing step that approximates stable subagent routing when a subagent keeps the same model for its lifetime.

### Phase 2+: true lane lifecycle

If Claude Code later exposes stable agent or lane identity to the proxy layer, or if another reliable lane key becomes available, the full lane model in this document becomes implementable:

- automatic root/child lane creation
- parent inheritance
- fixed lane lifetime binding
- lane-aware admin/debug introspection

Until then, phase 1 should be treated as a stepping stone toward the target architecture, not as a claim that the proxy already has true lane lifecycle awareness.

## Goals

1. Keep sessions as the user-managed backend/account objects.
2. Introduce an internal routing abstraction for root-agent and subagent lifetimes.
3. Let child agents express only `model` and `provider` intent.
4. Preserve parent inheritance by default.
5. Resolve routing once per lane and keep it stable for the lane lifetime.
6. Fail explicitly when routing hints cannot be satisfied.
7. Keep the system explainable through admin/debug surfaces.
8. Keep the first implementation grounded in signals the proxy can actually observe today.

## Non-Goals

- user-facing lane CRUD or lane selection commands
- dynamic mid-lane rebinding
- silent fallback to parent/default/global session when hints cannot be satisfied
- policy-engine scheduling or weighted routing
- multi-user tenancy
- automatic failover after lane creation in the first iteration
- pretending the current proxy can already observe Claude agent lineage when it cannot

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

This section describes the target architecture, not what phase 1 can implement from current Claude Code HTTP metadata alone.

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

This algorithm describes the target lane-aware model. Phase 1 should instead use request `body.model` as the only currently available routing hint that varies across Claude Code subagent requests.

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

In phase 1, this mapping is also the key mechanism for per-request model-based session resolution.

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

For phase 1, the same rule applies to request-level model-based session resolution: failure should be explicit when deterministic model/provider resolution is not possible.

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

Phase 1 should not overclaim lane lifecycle visibility, but it should still make request resolution explainable, for example by exposing when a request was resolved by explicit session override versus model-based selection.

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

In phase 1, request `body.model` acts as the first proxy-visible routing hint that can approximate subagent-specific routing before true lane identity exists.

## Implementation Impact

Likely implementation touchpoints later include:

- routing state and selection logic in `src/proxy.ts`
- configured session data in `src/config.ts`
- lane/session visibility in admin endpoints
- tests in `src/proxy.test.ts`
- statusline or panel consumers that need to distinguish requested context from resolved execution

Near-term implementation should begin with per-request model-based resolution in `src/proxy.ts`, because that code already parses `body.model` early and already contains the existing session-selection path:

- explicit `x-llm-session`
- per-chat binding via `x-claude-code-session-id`
- global active session

The design doc is intentionally ahead of implementation so the terminology and failure semantics are fixed first.

## Current Recommendation

Use lanes as the target internal, agent-scoped routing scope.

But implement the first step as request-scoped model-based session resolution, because that is what current Claude Code request metadata actually supports.

That first implementation should keep the model narrow:

- explicit session override remains highest priority
- request `body.model` becomes the first lane-related routing hint
- built-in model/provider inference remains deterministic
- explicit failure on ambiguity or unsatisfied constraints
- no health-based failover in the first step
- full lane lifecycle remains future work contingent on proxy-visible lane identity

That keeps the architecture honest while still moving toward future subagent routing.
