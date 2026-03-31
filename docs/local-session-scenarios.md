# Local Session Scenarios

This document captures the real workflow scenarios driving `llm-switcher`.

The goal is not to prescribe implementation yet. The goal is to make the usage pressure explicit before designing the next session model.

## Primary Goal

Keep one local coding workflow alive while switching models, accounts, or providers for quota, cost, and task-fit reasons, without losing the current session context.

## Current Core Scenarios

### 1. Quota failover without context loss

A user has both Claude and GPT subscriptions. When one side hits a session or rate limit, they want to switch to another available backend without:

- opening a new tool
- splitting the conversation
- re-explaining the work

This is the strongest immediate reason for the project.

### 2. Multi-account rotation within one provider

A user may have multiple Claude Pro accounts and wants to rotate between them locally as quota is exhausted.

This is often cheaper and more flexible than moving to a higher-cost plan, and it should preserve the same working session.

### 3. Credit-aware backend selection

A user may also have temporary or free credits from another provider, such as Gemini, and wants to use them as an additional fallback pool.

This makes backend choice partly an economics problem, not just a model-quality problem.

### 4. Model-for-task switching

Different models are better at different tasks. A user may want to:

- implement with one model
- review with another
- debug with a third
- plan or summarize with a cheaper/faster model

The key requirement is to do this inside one continuous local workflow.

## Next Design Pressure

### 5. Parallel local sessions

A single operator may run multiple local sessions at the same time, for example:

- one Claude window for implementation
- one Claude window for review
- one Codex session for a side task

These sessions may need different accounts or different model backends at the same time.

This is where the current global active-session design starts to become too coarse.

## Future Design Pressure

### 6. Sub-agent lanes with different models

The user may want parallel sub-agents or sub-workflows to use different model families under one broader task context.

Examples:

- a main coding lane on Claude
- a review lane on GPT
- a low-cost lane on Gemini for broad scanning or summarization

This is not primarily a multi-user/team problem. It is a single-operator, multi-lane local workflow problem.

## Implications For Design

The current global active-session model is still a valid MVP because it is the simplest way to support:

- quota failover
- multi-account rotation
- model switching in one main session

But the next natural design pressure is clear:

- global active session is enough for one main workflow
- it is not enough for multiple local sessions running in parallel

So the next design question is not whether multi-session support is needed. It is how to add it while keeping the current simple mode intact.

## Likely Direction

The likely progression is:

1. Keep the current global active-session mode as the default.
2. Add optional per-connection or per-session binding.
3. Preserve backward compatibility for users who only need one active lane.

This document should be used as input for any future work on:

- per-connection session selection
- local multi-session routing
- Codex CLI -> Anthropic reverse translation
- sub-agent lane routing
