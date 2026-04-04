# TODO

## Performance
- [ ] WS connection pooling — reuse persistent connections to chatgpt.com instead of creating one per request
- [ ] Optimize non-streaming requests — avoid unnecessary WS overhead for simple requests

## Stability
- [ ] WS disconnect retry — automatic retry with backoff on upstream WS failures
- [ ] Graceful shutdown — properly close active WS connections on SIGINT/SIGTERM
- [ ] Concurrent request handling — share WS connections across parallel requests from Claude Code

## Features
- [x] GLM Coding Plan preset — add a Claude-compatible GLM provider preset and fallback model suggestions
- [ ] Auto failover — detect quota/rate limit errors and automatically switch to next available account
- [ ] Token auto-refresh — use Codex OAuth refresh_token to renew before expiry
- [ ] Reverse translation — OpenAI → Anthropic format, enabling Codex CLI to use Claude models
- [ ] Request logging/metrics — track latency, token usage, error rates per session
- [ ] Token expiry detection — proactively warn or refresh before requests fail
- [ ] GLM Coding Plan validation — test real GLM keys against `/v1/messages` and `/v1/models`, then tighten defaults based on observed behavior
- [ ] GLM onboarding UX — consider a dedicated `glm-login` or `glm-init` convenience flow if manual API-key setup proves too rough
