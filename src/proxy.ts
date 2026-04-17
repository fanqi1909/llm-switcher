import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { getActiveSession, listSessions, addSession, removeSession, setActive, updateSessionToken } from "./config.js";
import type { Session } from "./config.js";
import { buildCodexHeaders, refreshCodexToken, updateCodexAuthFile, loadCodexAuth } from "./codex.js";
import { sniffOAuthToken } from "./login.js";
import { inferProviderFromModel, pickDeterministicSessionName } from "./models.js";
import { translateRequest, translateResponse, createWsEventProcessor, TranslationError } from "./translate.js";

type FetchImpl = typeof fetch;
type WsFactory = (url: string, options?: { headers?: Record<string, string> }) => WsWebSocket;

interface ProxyDeps {
  fetchImpl?: FetchImpl;
  openAIWsFactory?: WsFactory;
  codexBridgeWsFactory?: WsFactory;
  codexBridgeUrl?: string;
  sniffOAuthTokenImpl?: (timeout?: number) => Promise<string | null>;
}

type RoutingReason =
  | "explicit_session_header"
  | "explicit_session_header_compat"
  | "model_override_exact"
  | "session_name_alias"
  | "provider_inference_match"
  | "chat_binding_fallback"
  | "active_session_fallback";

interface RoutingResolution {
  requestedSession: string | null;
  requestedModel: string | null;
  resolvedSessionName: string | null;
  inferredProvider: Session["provider"] | null;
  reason: RoutingReason | null;
}

/** Immutable per-request context built once after routing resolution.
 *  Carries every piece of routing/tracing data so it doesn't have to be
 *  threaded as separate parameters through every helper. */
interface RequestContext {
  /** UUID for end-to-end request tracing (returned as x-llm-request-id). */
  readonly requestId: string;
  readonly chatSessionId: string | null;
  readonly sessionName: string;
  readonly routingReason: RoutingReason | null;
  readonly requestedModel: string | null;
  readonly resolvedSession: string | null;
  readonly inferredProvider: Session["provider"] | null;
  readonly startedAt: number;
}

function buildRequestContext(
  chatSessionId: string | null,
  session: { name: string },
  resolution: RoutingResolution,
): RequestContext {
  return {
    requestId: randomUUID(),
    chatSessionId,
    sessionName: session.name,
    routingReason: resolution.reason,
    requestedModel: resolution.requestedModel,
    resolvedSession: resolution.resolvedSessionName,
    inferredProvider: resolution.inferredProvider,
    startedAt: Date.now(),
  };
}

function buildResponseHeaders(ctx: RequestContext): Record<string, string> {
  return {
    "x-llm-session-used": ctx.sessionName,
    "x-llm-request-id": ctx.requestId,
    ...(ctx.routingReason ? { "x-llm-routing-reason": ctx.routingReason } : {}),
  };
}

function sessionUsedHeader(sessionName: string, reason?: RoutingReason | null): Record<string, string> {
  return {
    "x-llm-session-used": sessionName,
    ...(reason ? { "x-llm-routing-reason": reason } : {}),
  };
}

function getExplicitSessionReason(req: IncomingMessage): RoutingReason | null {
  const primary = req.headers["x-llm-session"];
  if (typeof primary === "string" && primary.trim()) return "explicit_session_header";
  const compat = req.headers["x-llm-switch-session"];
  if (typeof compat === "string" && compat.trim()) return "explicit_session_header_compat";
  return null;
}

const BILLING_BLOCK = {
  type: "text",
  text: "x-anthropic-billing-header: cc_version=2.1.87.d34; cc_entrypoint=cli;",
};

function isOAuthToken(token: string): boolean {
  return token.startsWith("sk-ant-oat01-");
}

function buildUpstreamHeaders(token: string, incomingHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };

  if (isOAuthToken(token)) {
    headers["authorization"] = `Bearer ${token}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
    headers["x-app"] = "cli";
    headers["user-agent"] = "claude-cli/2.1.87 (external, cli)";
  } else {
    headers["x-api-key"] = token;
  }

  const forward = ["anthropic-version", "anthropic-beta", "x-claude-code-session-id", "x-client-request-id"];
  for (const key of forward) {
    if (incomingHeaders[key]) headers[key] = incomingHeaders[key];
  }

  return headers;
}

function injectBillingHeader(body: any, token: string): any {
  if (!isOAuthToken(token)) return body;

  const system = body.system;
  if (system === undefined || system === null) {
    body.system = [BILLING_BLOCK];
  } else if (typeof system === "string") {
    body.system = [BILLING_BLOCK, { type: "text", text: system }];
  } else if (Array.isArray(system)) {
    const hasBilling = system.some(
      (b: any) => typeof b === "object" && b.text?.includes("x-anthropic-billing-header")
    );
    if (!hasBilling) body.system = [BILLING_BLOCK, ...system];
  }
  return body;
}

function getUpstreamUrl(baseUrl: string): string {
  return `${baseUrl}/v1/messages`;
}

const rateLimits: Record<string, Record<string, string>> = {};

interface SessionUsageSnapshot {
  input_tokens: number;
  output_tokens: number;
}

interface SessionObservability {
  configured_model: string | null;
  last_requested_model: string | null;
  last_effective_model: string | null;
  last_resolved_session: string | null;
  last_inferred_provider: Session["provider"] | null;
  last_resolution_reason: RoutingReason | null;
  last_used_at: string | null;
  last_error: { type: string; message: string; status?: number } | null;
  last_usage: SessionUsageSnapshot | null;
  last_request_id: string | null;
  last_chat_session_id: string | null;
  totals: {
    input_tokens: number;
    output_tokens: number;
    requests: number;
    errors: number;
  };
}

interface SessionProbeStatus {
  ok: boolean | null;
  status: number | null;
  reason?: string;
  health_state: "healthy" | "unhealthy" | "unknown";
  health_message: string;
  checked_at: string | null;
  latency_ms: number | null;
  rate_limits: Record<string, string>;
}

const sessionObservability: Record<string, SessionObservability> = {};
const sessionProbeStatus: Record<string, SessionProbeStatus> = {};
const pendingTokenRefresh = new Map<string, Promise<import("./codex.js").CodexTokenRefreshResult>>();
const pendingAnthropicRefresh = new Map<string, Promise<string | null>>();

interface CachedWorktreeMapping {
  original: string;
  worktree: string;
  lastSeen: number;
}
const worktreeMappings = new Map<string, CachedWorktreeMapping>();
const WORKTREE_MAPPING_TTL_MS = 30 * 60 * 1000; // 30 minutes

const WORKTREE_SUFFIX_RE = /\/\.claude\/worktrees\/[^/]+$/;

function detectWorktreeMapping(system: any): { original: string; worktree: string } | null {
  let text: string;
  if (typeof system === "string") {
    text = system;
  } else if (Array.isArray(system)) {
    text = system
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  } else {
    return null;
  }
  const match = text.match(/Working directory:\s*(\S+)/);
  if (!match) return null;
  const worktree = match[1];
  const original = worktree.replace(WORKTREE_SUFFIX_RE, "");
  if (original === worktree) return null; // not a worktree path
  return { original, worktree };
}

function getWorktreeMapping(chatSessionId: string | null, system: any): { original: string; worktree: string } | null {
  if (!chatSessionId) return detectWorktreeMapping(system);

  const now = Date.now();
  // Purge stale entries
  for (const [key, entry] of worktreeMappings) {
    if (now - entry.lastSeen > WORKTREE_MAPPING_TTL_MS) worktreeMappings.delete(key);
  }

  const cached = worktreeMappings.get(chatSessionId);
  if (cached) {
    cached.lastSeen = now;
    return { original: cached.original, worktree: cached.worktree };
  }

  const detected = detectWorktreeMapping(system);
  if (detected) {
    worktreeMappings.set(chatSessionId, { ...detected, lastSeen: now });
  }
  return detected;
}

export function resetRuntimeObservability(): void {
  for (const key of Object.keys(rateLimits)) delete rateLimits[key];
  for (const key of Object.keys(sessionObservability)) delete sessionObservability[key];
  for (const key of Object.keys(sessionProbeStatus)) delete sessionProbeStatus[key];
  pendingTokenRefresh.clear();
  pendingAnthropicRefresh.clear();
  worktreeMappings.clear();
}

export function setProbeCheckedAtForTest(sessionName: string, checkedAt: string): void {
  if (sessionProbeStatus[sessionName]) {
    sessionProbeStatus[sessionName] = { ...sessionProbeStatus[sessionName], checked_at: checkedAt };
  }
}

function getSessionObservability(session: { name: string; model_override?: string | null }): SessionObservability {
  if (!sessionObservability[session.name]) {
    sessionObservability[session.name] = {
      configured_model: session.model_override || null,
      last_requested_model: null,
      last_effective_model: null,
      last_resolved_session: null,
      last_inferred_provider: null,
      last_resolution_reason: null,
      last_used_at: null,
      last_error: null,
      last_usage: null,
      last_request_id: null,
      last_chat_session_id: null,
      totals: {
        input_tokens: 0,
        output_tokens: 0,
        requests: 0,
        errors: 0,
      },
    };
  }
  sessionObservability[session.name].configured_model = session.model_override || null;
  return sessionObservability[session.name];
}

function extractRateLimits(headers: Headers): Record<string, string> {
  const info: Record<string, string> = {};
  for (const key of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
    const val = headers.get(key);
    if (val) info[key] = val;
  }
  return info;
}

function updateRateLimits(sessionName: string, headers: Headers): void {
  const info = extractRateLimits(headers);
  if (Object.keys(info).length > 0) rateLimits[sessionName] = info;
}

function recordSessionSuccess(
  session: { name: string; model_override?: string | null },
  data: {
    requestedModel?: string | null;
    effectiveModel?: string | null;
    resolvedSession?: string | null;
    inferredProvider?: Session["provider"] | null;
    resolutionReason?: RoutingReason | null;
    usage?: { input_tokens?: number; output_tokens?: number } | null;
    ctx?: RequestContext;
  },
): void {
  const snapshot = getSessionObservability(session);
  snapshot.last_requested_model = data.requestedModel ?? snapshot.last_requested_model;
  snapshot.last_effective_model = data.effectiveModel ?? snapshot.last_effective_model;
  snapshot.last_resolved_session = data.resolvedSession ?? snapshot.last_resolved_session;
  snapshot.last_inferred_provider = data.inferredProvider ?? snapshot.last_inferred_provider;
  snapshot.last_resolution_reason = data.resolutionReason ?? snapshot.last_resolution_reason;
  snapshot.last_used_at = new Date().toISOString();
  snapshot.last_error = null;
  if (data.ctx) {
    snapshot.last_request_id = data.ctx.requestId;
    snapshot.last_chat_session_id = data.ctx.chatSessionId;
  }
  snapshot.totals.requests += 1;

  if (data.usage) {
    const input = data.usage.input_tokens || 0;
    const output = data.usage.output_tokens || 0;
    snapshot.last_usage = { input_tokens: input, output_tokens: output };
    snapshot.totals.input_tokens += input;
    snapshot.totals.output_tokens += output;
  }
}

function recordSessionError(
  session: { name: string; model_override?: string | null },
  data: {
    requestedModel?: string | null;
    effectiveModel?: string | null;
    resolvedSession?: string | null;
    inferredProvider?: Session["provider"] | null;
    resolutionReason?: RoutingReason | null;
    type: string;
    message: string;
    status?: number;
    ctx?: RequestContext;
  },
): void {
  const snapshot = getSessionObservability(session);
  snapshot.last_requested_model = data.requestedModel ?? snapshot.last_requested_model;
  snapshot.last_effective_model = data.effectiveModel ?? snapshot.last_effective_model;
  snapshot.last_resolved_session = data.resolvedSession ?? snapshot.last_resolved_session;
  snapshot.last_inferred_provider = data.inferredProvider ?? snapshot.last_inferred_provider;
  snapshot.last_resolution_reason = data.resolutionReason ?? snapshot.last_resolution_reason;
  snapshot.last_used_at = new Date().toISOString();
  if (data.ctx) {
    snapshot.last_request_id = data.ctx.requestId;
    snapshot.last_chat_session_id = data.ctx.chatSessionId;
  }
  snapshot.last_error = {
    type: data.type,
    message: data.message,
    ...(data.status !== undefined ? { status: data.status } : {}),
  };
  snapshot.totals.errors += 1;
}

function sanitizeSession(session: Record<string, any>): Record<string, any> {
  const { token, ...safe } = session;
  return safe;
}

function getSessionAdminView(name: string, session: Record<string, any>): Record<string, any> {
  return {
    ...sanitizeSession(session),
    ...getSessionObservability({ name, model_override: session.model_override }),
  };
}

function getProbeStatus(sessionName: string): SessionProbeStatus {
  return sessionProbeStatus[sessionName] || {
    ok: null,
    status: null,
    health_state: "unknown",
    health_message: "Health not checked yet",
    checked_at: null,
    latency_ms: null,
    rate_limits: rateLimits[sessionName] || {},
  };
}

function setProbeStatus(sessionName: string, status: SessionProbeStatus): void {
  sessionProbeStatus[sessionName] = status;
}

const chatSessionMap: Record<string, string> = {};
let lastSeenChatSessionId: string | null = null;

function getChatSessionId(req: IncomingMessage): string | null {
  const val = req.headers["x-claude-code-session-id"];
  return typeof val === "string" && val.trim() ? val.trim() : null;
}

function getScopedSession(name: string | null | undefined) {
  if (!name) return getActiveSession();
  const { sessions } = listSessions();
  const session = sessions[name];
  if (!session) return null;
  return { name, ...session };
}

function getRequestedSessionName(req: IncomingMessage): string | null {
  const primary = req.headers["x-llm-session"];
  if (typeof primary === "string" && primary.trim()) return primary.trim();
  const compat = req.headers["x-llm-switch-session"];
  if (typeof compat === "string" && compat.trim()) return compat.trim();
  return null;
}

function getRequestedWsSessionName(req: IncomingMessage): string | null {
  const url = req.url || "/responses";
  const parsed = new URL(url, "http://127.0.0.1");
  return parsed.searchParams.get("session");
}

function resolveModelRoutedSession(bodyModel: unknown): Pick<RoutingResolution, "requestedModel" | "resolvedSessionName" | "inferredProvider" | "reason"> {
  if (typeof bodyModel !== "string" || !bodyModel.trim()) {
    return {
      requestedModel: null,
      resolvedSessionName: null,
      inferredProvider: null,
      reason: null,
    };
  }

  const requestedModel = bodyModel.trim();
  const { sessions, active_session } = listSessions();

  const exactModelMatches = Object.entries(sessions)
    .filter(([, session]) => session.model_override === requestedModel)
    .map(([name]) => name);
  const exactModelMatch = pickDeterministicSessionName(exactModelMatches, active_session);
  if (exactModelMatch) {
    return {
      requestedModel,
      resolvedSessionName: exactModelMatch,
      inferredProvider: null,
      reason: "model_override_exact",
    };
  }

  if (sessions[requestedModel]) {
    return {
      requestedModel,
      resolvedSessionName: requestedModel,
      inferredProvider: null,
      reason: "session_name_alias",
    };
  }

  const provider = inferProviderFromModel(requestedModel);
  if (!provider) {
    return {
      requestedModel,
      resolvedSessionName: null,
      inferredProvider: null,
      reason: null,
    };
  }

  const providerMatches = Object.entries(sessions)
    .filter(([, session]) => session.provider === provider)
    .map(([name]) => name);
  const resolvedSessionName = pickDeterministicSessionName(providerMatches, active_session);
  return {
    requestedModel,
    resolvedSessionName,
    inferredProvider: provider,
    reason: resolvedSessionName ? "provider_inference_match" : null,
  };
}

function resolveHttpRouting(req: IncomingMessage, body: any, chatSessionId: string | null): RoutingResolution {
  const explicitSession = getRequestedSessionName(req);
  const explicitReason = getExplicitSessionReason(req);
  if (explicitSession) {
    return {
      requestedSession: explicitSession,
      requestedModel: typeof body.model === "string" ? body.model : null,
      resolvedSessionName: explicitSession,
      inferredProvider: null,
      reason: explicitReason,
    };
  }

  const modelResolution = resolveModelRoutedSession(body.model);
  if (modelResolution.reason === "model_override_exact" || modelResolution.reason === "session_name_alias") {
    return {
      requestedSession: modelResolution.resolvedSessionName,
      requestedModel: modelResolution.requestedModel,
      resolvedSessionName: modelResolution.resolvedSessionName,
      inferredProvider: modelResolution.inferredProvider,
      reason: modelResolution.reason,
    };
  }

  const chatBoundSession = chatSessionId ? chatSessionMap[chatSessionId] : undefined;
  if (chatBoundSession) {
    return {
      requestedSession: chatBoundSession,
      requestedModel: modelResolution.requestedModel,
      resolvedSessionName: chatBoundSession,
      inferredProvider: modelResolution.inferredProvider,
      reason: "chat_binding_fallback",
    };
  }

  const active = getActiveSession();
  if (active) {
    return {
      requestedSession: active.name,
      requestedModel: modelResolution.requestedModel,
      resolvedSessionName: active.name,
      inferredProvider: modelResolution.inferredProvider,
      reason: "active_session_fallback",
    };
  }

  if (modelResolution.resolvedSessionName) {
    return {
      requestedSession: modelResolution.resolvedSessionName,
      requestedModel: modelResolution.requestedModel,
      resolvedSessionName: modelResolution.resolvedSessionName,
      inferredProvider: modelResolution.inferredProvider,
      reason: modelResolution.reason,
    };
  }

  return {
    requestedSession: null,
    requestedModel: modelResolution.requestedModel,
    resolvedSessionName: null,
    inferredProvider: modelResolution.inferredProvider,
    reason: null,
  };
}

function getRoutingReasonData(resolution: RoutingResolution) {
  return {
    resolvedSession: resolution.resolvedSessionName,
    inferredProvider: resolution.inferredProvider,
    resolutionReason: resolution.reason,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

async function handleProxy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Required<ProxyDeps>,
): Promise<void> {
  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request", message: "Invalid JSON body." } }));
    return;
  }

  const chatSessionId = getChatSessionId(req);
  if (chatSessionId) lastSeenChatSessionId = chatSessionId;

  const resolution = resolveHttpRouting(req, body, chatSessionId);
  const session = getScopedSession(resolution.requestedSession);
  if (!session) {
    const errorType = resolution.requestedSession ? "session_not_found" : "no_active_session";
    const message = resolution.requestedSession
      ? `Session '${resolution.requestedSession}' not found.`
      : "No active session. Use 'llm-switcher add' to add one.";
    const activeForError = getActiveSession();
    if (activeForError) {
      recordSessionError(activeForError, {
        requestedModel: resolution.requestedModel,
        ...getRoutingReasonData(resolution),
        type: errorType,
        message,
        status: resolution.requestedSession ? 404 : 503,
      });
    }
    res.writeHead(resolution.requestedSession ? 404 : 503, {
      "content-type": "application/json",
      ...(resolution.reason ? { "x-llm-routing-reason": resolution.reason } : {}),
    });
    res.end(JSON.stringify({
      error: {
        type: errorType,
        message,
      },
    }));
    return;
  }

  const ctx = buildRequestContext(chatSessionId, session, resolution);
  const routingHeaders = buildResponseHeaders(ctx);
  const routingData = getRoutingReasonData(resolution);

  if (session.provider === "openai") {
    return handleOpenAIProxy(res, body, session, deps, ctx, routingData);
  }

  const requestedModel = ctx.requestedModel;
  const token = session.token;
  const baseUrl = session.base_url || "https://api.anthropic.com";
  const incomingHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") incomingHeaders[k] = v;
  }

  if (session.model_override) {
    body.model = session.model_override;
  }

  body = injectBillingHeader({ ...body }, token);

  const upstreamUrl = getUpstreamUrl(baseUrl);
  const isStream = body.stream === true;
  const effectiveModel = typeof body.model === "string" ? body.model : session.model_override || null;

  async function doAnthropicFetch(currentToken: string, canRetry: boolean): Promise<void> {
    const upstreamHeaders = buildUpstreamHeaders(currentToken, incomingHeaders);
    let upstreamRes: Response;
    try {
      upstreamRes = await deps.fetchImpl(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(body),
      });
    } catch (err) {
      recordSessionError(session, {
        requestedModel,
        effectiveModel,
        ...routingData,
        type: "upstream_connection_error",
        message: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(502, { "content-type": "application/json", ...routingHeaders });
      res.end(JSON.stringify({ error: { type: "upstream_connection_error", message: err instanceof Error ? err.message : String(err) } }));
      return;
    }

    updateRateLimits(session.name, upstreamRes.headers);

    // Auto-refresh OAuth token on 401 and retry once
    if (upstreamRes.status === 401 && isOAuthToken(currentToken) && canRetry) {
      console.error(`[Anthropic] Token expired (401), attempting re-sniff for session '${session.name}'`);
      try {
        let refreshPromise = pendingAnthropicRefresh.get(session.name);
        if (!refreshPromise) {
          refreshPromise = deps.sniffOAuthTokenImpl(15000).finally(() => {
            pendingAnthropicRefresh.delete(session.name);
          });
          pendingAnthropicRefresh.set(session.name, refreshPromise);
        }
        const newToken = await refreshPromise;
        if (!newToken) throw new Error("sniffOAuthToken returned null — claude CLI unavailable or not logged in");
        await updateSessionToken(session.name, newToken);
        session.token = newToken;
        // Re-inject billing header with the new token before retrying
        body = injectBillingHeader({ ...body }, newToken);
        console.error(`[Anthropic] Token refreshed, retrying`);
        return doAnthropicFetch(newToken, false);
      } catch (refreshErr) {
        console.error(`[Anthropic] Token refresh failed:`, (refreshErr as Error).message);
        res.writeHead(502, { "content-type": "application/json", ...routingHeaders });
        res.end(JSON.stringify({
          error: {
            type: "oauth_token_refresh_failed",
            message: `Auto-refresh failed: ${(refreshErr as Error).message}. Run 'llm-switcher login' to manually refresh.`,
          },
        }));
        return;
      }
    }

    if (isStream && upstreamRes.ok && upstreamRes.body) {
      recordSessionSuccess(session, {
        requestedModel,
        effectiveModel,
        ...routingData,
        ctx,
      });
      res.writeHead(upstreamRes.status, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        ...routingHeaders,
      });
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } else {
      const text = await upstreamRes.text();
      res.writeHead(upstreamRes.status, {
        "content-type": upstreamRes.headers.get("content-type") || "application/json",
        ...routingHeaders,
      });
      res.end(text);

      if (upstreamRes.ok) {
        let parsed: any = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        recordSessionSuccess(session, {
          requestedModel,
          effectiveModel,
          ...routingData,
          usage: parsed?.usage || null,
          ctx,
        });
      } else {
        let parsed: any = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        recordSessionError(session, {
          requestedModel,
          effectiveModel,
          ...routingData,
          type: parsed?.error?.type || "upstream_error",
          message: parsed?.error?.message || `Upstream error ${upstreamRes.status}`,
          status: upstreamRes.status,
          ctx,
        });
      }
    }
  }

  return doAnthropicFetch(token, true);
}

async function handleOpenAIProxy(
  res: ServerResponse,
  requestBody: any,
  session: { name: string; token: string; model_override?: string; account_id?: string; refresh_token?: string },
  deps: Required<ProxyDeps>,
  ctx: RequestContext,
  routingData: { resolvedSession?: string | null; inferredProvider?: Session["provider"] | null; resolutionReason?: RoutingReason | null } = {},
): Promise<void> {
  const responseHeaders = buildResponseHeaders(ctx);
  let translated;
  try {
    translated = translateRequest(requestBody, session);
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json", ...responseHeaders });
    res.end(JSON.stringify({ error: { type: "invalid_request", message: (err as Error).message } }));
    return;
  }

  const worktreeMapping = getWorktreeMapping(ctx.chatSessionId, requestBody.system);

  const translatedBody = JSON.parse(translated.body);
  const isStream = requestBody.stream === true;
  let responseDone = false;
  const requestedModel = typeof requestBody.model === "string" ? requestBody.model : null;
  const effectiveModel =
    typeof translatedBody.model === "string"
      ? translatedBody.model
      : session.model_override || requestedModel;

  function endResponse(status: number, body: any, extraHeaders?: Record<string, string>): void {
    if (responseDone) return;
    responseDone = true;
    res.writeHead(status, {
      "content-type": "application/json",
      ...responseHeaders,
      ...(extraHeaders || {}),
    });
    res.end(JSON.stringify(body));
  }

  function writeSSE(event: string, data: any): void {
    if (responseDone) return;
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        ...responseHeaders,
        ...(worktreeMapping ? { "x-llm-path-rewritten": "true" } : {}),
      });
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function connectWs(token: string, canRetry: boolean): void {
    const headers = buildCodexHeaders(token, session.account_id || "");
    const ws = deps.openAIWsFactory(translated.url, { headers });
    const processWsEvent = createWsEventProcessor(worktreeMapping);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "response.create", ...translatedBody }));
    });

    ws.on("message", (data) => {
      let event: any;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (event.type === "error") {
        console.error(`[OpenAI] WS error event:`, JSON.stringify(event));
        recordSessionError(session, {
          requestedModel,
          effectiveModel,
          ...routingData,
          type: event.error?.type || "api_error",
          message: event.error?.message || "OpenAI error",
        });
        endResponse(502, { error: { type: "api_error", message: event.error?.message || "OpenAI error" } });
        ws.close();
        return;
      }

      if (isStream) {
        processWsEvent(event, writeSSE);
        if (event.type === "response.completed") {
          recordSessionSuccess(session, {
            requestedModel,
            effectiveModel,
            ...routingData,
            usage: event.response?.usage || null,
          });
          processWsEvent({ type: "_finish" }, writeSSE);
          responseDone = true;
          res.end();
          ws.close();
        }
      } else if (event.type === "response.completed") {
        let anthropicRes: any;
        let pathRewritten = false;
        try {
          ({ response: anthropicRes, pathRewritten } = translateResponse(event.response, worktreeMapping));
        } catch (translateErr) {
          const msg = translateErr instanceof TranslationError
            ? translateErr.message
            : `Unexpected translation error: ${(translateErr as Error).message}`;
          console.error(`[OpenAI] ${msg}`);
          recordSessionError(session, {
            requestedModel,
            effectiveModel,
            ...routingData,
            type: "translation_error",
            message: msg,
            ctx,
          });
          endResponse(502, { error: { type: "translation_error", message: msg } });
          ws.close();
          return;
        }
        recordSessionSuccess(session, {
          requestedModel,
          effectiveModel,
          ...routingData,
          usage: event.response?.usage || null,
          ctx,
        });
        endResponse(200, anthropicRes, pathRewritten ? { "x-llm-path-rewritten": "true" } : undefined);
        ws.close();
      }
    });

    ws.on("error", async (err) => {
      const is401 = (err as any).statusCode === 401 || err.message.includes("401");
      if (canRetry && is401) {
        // Prefer refresh_token stored in session config; fall back to ~/.codex/auth.json
        // so sessions created before refresh_token storage was added still auto-refresh.
        const refreshToken = session.refresh_token ?? loadCodexAuth()?.tokens?.refresh_token ?? null;
        if (refreshToken) {
          console.error(`[OpenAI] Token expired, attempting refresh for session '${session.name}'`);
          try {
            // Deduplicate concurrent refreshes: if another request already started a refresh
            // for this session, wait for that result rather than burning the rotation token twice.
            let refreshPromise = pendingTokenRefresh.get(session.name);
            if (!refreshPromise) {
              refreshPromise = refreshCodexToken(refreshToken, deps.fetchImpl).finally(() => {
                pendingTokenRefresh.delete(session.name);
              });
              pendingTokenRefresh.set(session.name, refreshPromise);
            }
            const result = await refreshPromise;
            await updateSessionToken(session.name, result.access_token);
            updateCodexAuthFile(result);
            session.token = result.access_token;
            if (result.refresh_token) session.refresh_token = result.refresh_token;
            console.error(`[OpenAI] Token refreshed, retrying`);
            connectWs(result.access_token, false);
            return;
          } catch (refreshErr) {
            console.error(`[OpenAI] Token refresh failed:`, (refreshErr as Error).message);
            endResponse(502, {
              error: { type: "token_refresh_failed", message: (refreshErr as Error).message },
            });
            return;
          }
        }
      }
      console.error(`[OpenAI] WS connection error:`, err.message);
      recordSessionError(session, {
        requestedModel,
        effectiveModel,
        ...routingData,
        type: "upstream_connection_error",
        message: err.message,
      });
      endResponse(502, {
        error: { type: "upstream_connection_error", message: err.message },
      });
    });

    ws.on("close", (code) => {
      if (!responseDone && code !== 1000) {
        recordSessionError(session, {
          requestedModel,
          effectiveModel,
          ...routingData,
          type: "upstream_closed",
          message: `Upstream WebSocket closed unexpectedly (${code})`,
        });
        endResponse(502, { error: { type: "upstream_closed", message: `Upstream WebSocket closed unexpectedly (${code})` } });
      }
    });
  }

  connectWs(session.token, true);
}

async function handleModels(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Required<ProxyDeps>,
): Promise<void> {
  const requestedSession = getRequestedSessionName(req) ?? null;
  const session = getScopedSession(requestedSession);
  if (!session) {
    res.writeHead(requestedSession ? 404 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        type: requestedSession ? "session_not_found" : "no_active_session",
        message: requestedSession
          ? `Session '${requestedSession}' not found.`
          : "No active session. Use 'llm-switcher add' to add one.",
      },
    }));
    return;
  }

  if (session.provider === "openai") {
    const headers = buildCodexHeaders(session.token, session.account_id || "");
    headers["content-type"] = "application/json";
    try {
      const upstreamRes = await deps.fetchImpl("https://api.openai.com/v1/models", {
        method: "GET",
        headers,
      });
      const text = await upstreamRes.text();
      res.writeHead(upstreamRes.status, {
        "content-type": upstreamRes.headers.get("content-type") || "application/json",
        ...sessionUsedHeader(session.name),
      });
      res.end(text);
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "upstream_connection_error", message: err instanceof Error ? err.message : String(err) } }));
    }
    return;
  }

  const incomingHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") incomingHeaders[k] = v;
  }

  const baseUrl = session.base_url || "https://api.anthropic.com";
  const upstreamUrl = `${baseUrl}/v1/models${new URL(req.url || "/v1/models", "http://127.0.0.1").search}`;
  const upstreamHeaders = buildUpstreamHeaders(session.token, incomingHeaders);

  try {
    const upstreamRes = await deps.fetchImpl(upstreamUrl, {
      method: "GET",
      headers: upstreamHeaders,
    });
    const text = await upstreamRes.text();
    res.writeHead(upstreamRes.status, {
      "content-type": upstreamRes.headers.get("content-type") || "application/json",
      ...sessionUsedHeader(session.name),
    });
    res.end(text);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "upstream_connection_error", message: err instanceof Error ? err.message : String(err) } }));
  }
}

async function runAnthropicProbe(
  session: Session & { name: string },
  deps: Required<ProxyDeps>,
): Promise<SessionProbeStatus> {
  const started = Date.now();
  const body = injectBillingHeader({
    model: session.model_override || "claude-haiku-4-5-20251001",
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
  }, session.token);

  try {
    const upstreamRes = await deps.fetchImpl(getUpstreamUrl(session.base_url || "https://api.anthropic.com"), {
      method: "POST",
      headers: buildUpstreamHeaders(session.token, {}),
      body: JSON.stringify(body),
    });
    updateRateLimits(session.name, upstreamRes.headers);
    const probeRateLimits = extractRateLimits(upstreamRes.headers);
    return {
      ok: upstreamRes.ok,
      status: upstreamRes.status,
      health_state: upstreamRes.ok ? "healthy" : "unhealthy",
      health_message: upstreamRes.ok ? "Healthy" : `Unhealthy: HTTP ${upstreamRes.status}`,
      checked_at: new Date().toISOString(),
      latency_ms: Date.now() - started,
      rate_limits: Object.keys(probeRateLimits).length > 0 ? probeRateLimits : rateLimits[session.name] || {},
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      health_state: "unhealthy",
      health_message: `Unhealthy: ${err instanceof Error ? err.message : String(err)}`,
      checked_at: new Date().toISOString(),
      latency_ms: Date.now() - started,
      rate_limits: rateLimits[session.name] || {},
    };
  }
}

async function runOpenAIProbe(
  session: Session & { name: string },
  deps: Required<ProxyDeps>,
): Promise<SessionProbeStatus> {
  const started = Date.now();
  try {
    const translated = translateRequest({
      model: "unused-for-openai-session-selection",
      stream: true,
      messages: [{ role: "user", content: "ping" }],
    }, session);

    return await new Promise<SessionProbeStatus>((resolve) => {
      const ws = deps.openAIWsFactory(translated.url, { headers: translated.headers });
      let resolved = false;
      const finish = (status: SessionProbeStatus) => {
        if (resolved) return;
        resolved = true;
        resolve(status);
      };

      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "response.create", ...JSON.parse(translated.body) }));
      });

      ws.on("message", (data) => {
        let event: any;
        try {
          event = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (event.type === "error") {
          finish({
            ok: false,
            status: null,
            health_state: "unhealthy",
            health_message: `Unhealthy: ${event.error?.message || "OpenAI error"}`,
            checked_at: new Date().toISOString(),
            latency_ms: Date.now() - started,
            rate_limits: rateLimits[session.name] || {},
          });
          ws.close();
          return;
        }

        if (event.type === "response.completed") {
          finish({
            ok: true,
            status: 200,
            health_state: "healthy",
            health_message: "Healthy",
            checked_at: new Date().toISOString(),
            latency_ms: Date.now() - started,
            rate_limits: rateLimits[session.name] || {},
          });
          ws.close();
        }
      });

      ws.on("error", (err) => {
        finish({
          ok: false,
          status: null,
          health_state: "unhealthy",
          health_message: `Unhealthy: ${err.message}`,
          checked_at: new Date().toISOString(),
          latency_ms: Date.now() - started,
          rate_limits: rateLimits[session.name] || {},
        });
      });

      ws.on("close", (code) => {
        if (!resolved) {
          finish({
            ok: false,
            status: null,
            health_state: "unhealthy",
            health_message: `Unhealthy: WebSocket closed ${code}`,
            checked_at: new Date().toISOString(),
            latency_ms: Date.now() - started,
            rate_limits: rateLimits[session.name] || {},
          });
        }
      });
    });
  } catch (err) {
    return {
      ok: false,
      status: null,
      health_state: "unhealthy",
      health_message: `Unhealthy: ${err instanceof Error ? err.message : String(err)}`,
      checked_at: new Date().toISOString(),
      latency_ms: Date.now() - started,
      rate_limits: rateLimits[session.name] || {},
    };
  }
}

const PROBE_TTL_MS = 60_000;

async function runSessionProbe(
  session: Session & { name: string },
  deps: Required<ProxyDeps>,
): Promise<SessionProbeStatus> {
  const cached = getProbeStatus(session.name);
  if (cached.checked_at && Date.now() - new Date(cached.checked_at).getTime() < PROBE_TTL_MS) {
    return cached;
  }
  const status = session.provider === "openai"
    ? await runOpenAIProbe(session, deps)
    : await runAnthropicProbe(session, deps);
  setProbeStatus(session.name, status);
  return status;
}

async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Required<ProxyDeps>,
): Promise<void> {
  const path = req.url || "/";

  if (req.method === "GET" && (path === "/admin/sessions" || path.startsWith("/admin/sessions?"))) {
    const { sessions, active_session } = listSessions();
    const wantHealth = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("health") === "true";
    let annotatedSessions: Record<string, any> = Object.fromEntries(
      Object.entries(sessions).map(([name, session]) => [name, getSessionAdminView(name, session)]),
    );
    if (wantHealth) {
      const health = Object.fromEntries(
        await Promise.all(
          Object.entries(sessions).map(async ([name, session]) => [name, await runSessionProbe({ name, ...session }, deps)] as const),
        ),
      );
      annotatedSessions = Object.fromEntries(
        Object.entries(sessions).map(([name, session]) => [name, { ...getSessionAdminView(name, session), ...health[name] }]),
      );
    }
    res.end(JSON.stringify({
      sessions: annotatedSessions,
      active_session,
      chat_session_bindings: { ...chatSessionMap },
    }));
    return;
  }

  if (req.method === "POST" && path === "/admin/sessions") {
    const body = JSON.parse(await readBody(req));
    if (!body.name || !body.provider || !body.token) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request", message: "name, provider, and token are required" } }));
      return;
    }
    await addSession(body.name, body.provider, body.token, body.base_url, body.model_override, body.account_id, body.refresh_token);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "DELETE" && path.startsWith("/admin/sessions/")) {
    const name = decodeURIComponent(path.slice("/admin/sessions/".length));
    await removeSession(name);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && path.startsWith("/admin/switch/")) {
    const name = decodeURIComponent(path.slice("/admin/switch/".length));
    try {
      await setActive(name);
      res.end(JSON.stringify({ ok: true, active_session: name }));
    } catch (err) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "session_not_found", message: (err as Error).message } }));
    }
    return;
  }

  if (req.method === "GET" && path === "/admin/status") {
    const session = getActiveSession();
    const { sessions } = listSessions();
    const availableSessions = Object.keys(sessions);
    if (!session) {
      res.end(JSON.stringify({
        active_session: null,
        available_sessions: availableSessions,
        override_header: "x-llm-session",
        override_ws_param: "?session=<name>",
        rate_limits: {},
        observability: null,
      }));
      return;
    }
    const safe = sanitizeSession(session);
    res.end(JSON.stringify({
      active_session: safe,
      available_sessions: availableSessions,
      override_header: "x-llm-session",
      override_ws_param: "?session=<name>",
      rate_limits: rateLimits[session.name] || {},
      observability: getSessionObservability(session),
    }));
    return;
  }

  if (req.method === "GET" && path === "/admin/recent-chat-id") {
    res.end(JSON.stringify({ chat_session_id: lastSeenChatSessionId }));
    return;
  }

  if (req.method === "GET" && path === "/admin/path-map") {
    const entries: Record<string, { original: string; worktree: string; last_seen_at: string }> = {};
    for (const [chatId, m] of worktreeMappings) {
      entries[chatId] = { original: m.original, worktree: m.worktree, last_seen_at: new Date(m.lastSeen).toISOString() };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path_mappings: entries }));
    return;
  }

  if (req.method === "POST" && path.startsWith("/admin/chat-bind/")) {
    const rest = path.slice("/admin/chat-bind/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request", message: "Expected /admin/chat-bind/<chat-session-id>/<session-name>" } }));
      return;
    }
    const chatSessionId = decodeURIComponent(rest.slice(0, slash));
    const sessionName = decodeURIComponent(rest.slice(slash + 1));
    const session = getScopedSession(sessionName);
    if (!session) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "session_not_found", message: `Session '${sessionName}' not found.` } }));
      return;
    }
    chatSessionMap[chatSessionId] = sessionName;
    res.end(JSON.stringify({ ok: true, chat_session_id: chatSessionId, session: sessionName }));
    return;
  }

  if (req.method === "GET" && path === "/admin/rate-limits") {
    const { sessions } = listSessions();
    const result = Object.fromEntries(
      await Promise.all(
        Object.entries(sessions).map(async ([name, session]) => [
          name,
          await runSessionProbe({ name, ...session }, deps),
        ] as const),
      ),
    );
    res.end(JSON.stringify({ rate_limits: result }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "not_found", message: "Unknown admin route" } }));
}

function handleWs(
  req: IncomingMessage,
  socket: any,
  head: Buffer,
  wss: WebSocketServer,
  deps: Required<ProxyDeps>,
) {
  const requestedSession = getRequestedWsSessionName(req);
  const session = getScopedSession(requestedSession);
  if (!session) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  if (session.provider !== "openai") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const upstreamUrl = deps.codexBridgeUrl || "wss://chatgpt.com/backend-api/codex/responses";
  const upstreamHeaders = buildCodexHeaders(session.token, session.account_id || "");
  const buffered: Array<{ data: any; isBinary: boolean }> = [];

  const upstreamWs = deps.codexBridgeWsFactory(upstreamUrl, { headers: upstreamHeaders });

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    clientWs.on("message", (data, isBinary) => {
      if (upstreamWs.readyState === upstreamWs.OPEN) {
        upstreamWs.send(data, { binary: isBinary });
      } else {
        buffered.push({ data, isBinary });
      }
    });

    upstreamWs.on("open", () => {
      for (const msg of buffered) upstreamWs.send(msg.data, { binary: msg.isBinary });
      buffered.length = 0;
    });

    upstreamWs.on("message", (data, isBinary) => {
      clientWs.send(data, { binary: isBinary });
    });

    clientWs.on("close", (code, reason) => {
      if (upstreamWs.readyState === upstreamWs.OPEN || upstreamWs.readyState === upstreamWs.CONNECTING) {
        upstreamWs.close(code, reason.toString());
      }
    });

    upstreamWs.on("close", (code, reason) => {
      if (clientWs.readyState === clientWs.OPEN || clientWs.readyState === clientWs.CONNECTING) {
        clientWs.close(code, reason.toString());
      }
    });

    clientWs.on("error", () => {
      if (upstreamWs.readyState === upstreamWs.OPEN || upstreamWs.readyState === upstreamWs.CONNECTING) {
        upstreamWs.close();
      }
    });

    upstreamWs.on("error", () => {
      if (clientWs.readyState === clientWs.OPEN || clientWs.readyState === clientWs.CONNECTING) {
        clientWs.close();
      }
    });
  });
}

export function createProxyServer(customDeps: ProxyDeps = {}) {
  const deps: Required<ProxyDeps> = {
    fetchImpl: customDeps.fetchImpl || fetch,
    openAIWsFactory: customDeps.openAIWsFactory || ((url, options) => new WsWebSocket(url, options)),
    codexBridgeWsFactory: customDeps.codexBridgeWsFactory || ((url, options) => new WsWebSocket(url, options)),
    codexBridgeUrl: customDeps.codexBridgeUrl || "wss://chatgpt.com/backend-api/codex/responses",
    sniffOAuthTokenImpl: customDeps.sniffOAuthTokenImpl || sniffOAuthToken,
  };

  const server = createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request", message: "Missing URL." } }));
      return;
    }

    const path = new URL(req.url, "http://127.0.0.1").pathname;

    if ((req.method === "GET" || req.method === "HEAD") && path === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "HEAD") return res.end();
      return res.end(JSON.stringify({ status: "ok" }));
    }

    if (path.startsWith("/admin/")) {
      return handleAdmin(req, res, deps);
    }

    if (req.method === "POST" && path === "/v1/messages") {
      return handleProxy(req, res, deps);
    }

    if (req.method === "GET" && path === "/v1/models") {
      return handleModels(req, res, deps);
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "not_found", message: `Unknown route ${path}` } }));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url || "/responses", "http://127.0.0.1").pathname;
    if (path !== "/responses") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    handleWs(req, socket, head, wss, deps);
  });

  return server;
}
