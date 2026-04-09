import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { getActiveSession, listSessions, addSession, removeSession, setActive } from "./config.js";
import { buildCodexHeaders } from "./codex.js";
import { translateRequest, translateResponse, createWsEventProcessor } from "./translate.js";

type FetchImpl = typeof fetch;
type WsFactory = (url: string, options?: { headers?: Record<string, string> }) => WsWebSocket;

interface ProxyDeps {
  fetchImpl?: FetchImpl;
  openAIWsFactory?: WsFactory;
  codexBridgeWsFactory?: WsFactory;
  codexBridgeUrl?: string;
}

function sessionUsedHeader(sessionName: string): Record<string, string> {
  return { "x-llm-session-used": sessionName };
}

// --- OAuth helpers ---

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

  // Forward relevant headers from incoming request
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

// --- Runtime observability tracking ---
const rateLimits: Record<string, Record<string, string>> = {};

interface SessionUsageSnapshot {
  input_tokens: number;
  output_tokens: number;
}

interface SessionObservability {
  configured_model: string | null;
  last_requested_model: string | null;
  last_effective_model: string | null;
  last_used_at: string | null;
  last_error: { type: string; message: string; status?: number } | null;
  last_usage: SessionUsageSnapshot | null;
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

export function resetRuntimeObservability(): void {
  for (const key of Object.keys(rateLimits)) delete rateLimits[key];
  for (const key of Object.keys(sessionObservability)) delete sessionObservability[key];
  for (const key of Object.keys(sessionProbeStatus)) delete sessionProbeStatus[key];
}

function getSessionObservability(session: { name: string; model_override?: string | null }): SessionObservability {
  if (!sessionObservability[session.name]) {
    sessionObservability[session.name] = {
      configured_model: session.model_override || null,
      last_requested_model: null,
      last_effective_model: null,
      last_used_at: null,
      last_error: null,
      last_usage: null,
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
    usage?: { input_tokens?: number; output_tokens?: number } | null;
  },
): void {
  const snapshot = getSessionObservability(session);
  snapshot.last_requested_model = data.requestedModel ?? snapshot.last_requested_model;
  snapshot.last_effective_model = data.effectiveModel ?? snapshot.last_effective_model;
  snapshot.last_used_at = new Date().toISOString();
  snapshot.last_error = null;
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
    type: string;
    message: string;
    status?: number;
  },
): void {
  const snapshot = getSessionObservability(session);
  snapshot.last_requested_model = data.requestedModel ?? snapshot.last_requested_model;
  snapshot.last_effective_model = data.effectiveModel ?? snapshot.last_effective_model;
  snapshot.last_used_at = new Date().toISOString();
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

// --- Per-chat session binding ---
// Maps x-claude-code-session-id → llm session name, so each chat window can use a different session.
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
  const header = req.headers["x-llm-session"] ?? req.headers["x-llm-switch-session"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return null;
}

function getRequestedWsSessionName(req: IncomingMessage): string | null {
  const url = req.url || "/responses";
  const parsed = new URL(url, "http://127.0.0.1");
  return parsed.searchParams.get("session");
}

// --- Request body parser ---
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

// --- Route handlers ---

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

  // Track the chat session ID for per-chat binding
  const chatSessionId = getChatSessionId(req);
  if (chatSessionId) lastSeenChatSessionId = chatSessionId;

  // Session resolution order: explicit x-llm-session header > per-chat binding > global active
  const requestedSession = getRequestedSessionName(req)
    ?? (chatSessionId ? chatSessionMap[chatSessionId] : undefined)
    ?? null;
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
    return handleOpenAIProxy(res, body, session, deps);
  }

  const requestedModel = typeof body.model === "string" ? body.model : null;

  const token = session.token;
  const baseUrl = session.base_url || "https://api.anthropic.com";
  const incomingHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") incomingHeaders[k] = v;
  }

  // Apply model override
  if (session.model_override && !body.model) {
    body.model = session.model_override;
  }

  // Inject billing header for OAuth
  body = injectBillingHeader({ ...body }, token);

  const upstreamUrl = getUpstreamUrl(baseUrl);
  const upstreamHeaders = buildUpstreamHeaders(token, incomingHeaders);
  const isStream = body.stream === true;

  try {
    const effectiveModel = typeof body.model === "string" ? body.model : session.model_override || null;
    const upstreamRes = await deps.fetchImpl(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    updateRateLimits(session.name, upstreamRes.headers);

    if (isStream && upstreamRes.ok && upstreamRes.body) {
      recordSessionSuccess(session, {
        requestedModel,
        effectiveModel,
      });
      // Stream SSE passthrough (only for successful responses)
      res.writeHead(upstreamRes.status, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        ...sessionUsedHeader(session.name),
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
      // JSON passthrough (errors always returned as JSON so Claude Code doesn't hang)
      const responseBody = await upstreamRes.text();
      try {
        const parsed = JSON.parse(responseBody);
        if (upstreamRes.ok) {
          recordSessionSuccess(session, {
            requestedModel,
            effectiveModel: parsed.model || effectiveModel,
            usage: parsed.usage || null,
          });
        } else {
          recordSessionError(session, {
            requestedModel,
            effectiveModel,
            type: parsed.error?.type || "api_error",
            message: parsed.error?.message || `HTTP ${upstreamRes.status}`,
            status: upstreamRes.status,
          });
        }
      } catch {
        if (upstreamRes.ok) {
          recordSessionSuccess(session, {
            requestedModel,
            effectiveModel,
          });
        } else {
          recordSessionError(session, {
            requestedModel,
            effectiveModel,
            type: "api_error",
            message: `HTTP ${upstreamRes.status}`,
            status: upstreamRes.status,
          });
        }
      }
      res.writeHead(upstreamRes.status, {
        "content-type": "application/json",
        ...sessionUsedHeader(session.name),
      });
      res.end(responseBody);
    }
  } catch (err: any) {
    recordSessionError(session, {
      requestedModel,
      effectiveModel: typeof body.model === "string" ? body.model : session.model_override || null,
      type: "upstream_connection_error",
      message: err.message,
      status: 502,
    });
    res.writeHead(502, {
      "content-type": "application/json",
      ...sessionUsedHeader(session.name),
    });
    res.end(JSON.stringify({ error: { type: "upstream_connection_error", message: err.message } }));
  }
}

async function handleOpenAIProxy(
  res: ServerResponse,
  body: any,
  session: any,
  deps: Required<ProxyDeps>,
): Promise<void> {
  const requestedModel = typeof body.model === "string" ? body.model : null;
  let translated: { url: string; headers: Record<string, string>; body: string };
  try {
    translated = translateRequest(body, session);
  } catch (err: any) {
    recordSessionError(session, {
      requestedModel,
      effectiveModel: session.model_override || null,
      type: "invalid_request",
      message: err.message,
      status: 422,
    });
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request", message: err.message } }));
    return;
  }

  const isStream = body.stream === true;
  const requestBody = JSON.parse(translated.body);
  const effectiveModel = typeof requestBody.model === "string" ? requestBody.model : session.model_override || null;
  // Always stream over WebSocket, we'll collect if non-streaming was requested
  requestBody.stream = true;

  const ws = deps.openAIWsFactory(translated.url, { headers: translated.headers });

  const events: any[] = [];
  let responseDone = false;
  const processWsEvent = createWsEventProcessor();

  function endResponse(status: number, body: any): void {
    if (responseDone) return;
    responseDone = true;
    res.writeHead(status, {
      "content-type": "application/json",
      ...sessionUsedHeader(session.name),
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
        ...sessionUsedHeader(session.name),
      });
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "response.create", ...requestBody }));
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
        type: "api_error",
        message: event.error?.message || "OpenAI error",
        status: 502,
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
          effectiveModel: event.response?.model || effectiveModel,
          usage: event.response?.usage || null,
        });
        processWsEvent({ type: "_finish" }, writeSSE);
        responseDone = true;
        res.end();
        ws.close();
      }
    } else {
      events.push(event);

      if (event.type === "response.completed") {
        const anthropicRes = translateResponse(event.response);
        recordSessionSuccess(session, {
          requestedModel,
          effectiveModel: anthropicRes.model || event.response?.model || effectiveModel,
          usage: anthropicRes.usage || null,
        });
        endResponse(200, anthropicRes);
        ws.close();
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`[OpenAI] WS connection error:`, err.message);
    recordSessionError(session, {
      requestedModel,
      effectiveModel,
      type: "upstream_connection_error",
      message: err.message,
      status: 502,
    });
    endResponse(502, { error: { type: "upstream_connection_error", message: err.message } });
  });

  ws.on("close", (code, reason) => {
    if (!responseDone) {
      recordSessionError(session, {
        requestedModel,
        effectiveModel,
        type: "upstream_connection_error",
        message: `WebSocket closed: ${code} ${reason}`,
        status: 502,
      });
    }
    endResponse(502, { error: { type: "upstream_connection_error", message: `WebSocket closed: ${code} ${reason}` } });
  });
}

async function handleModels(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Required<ProxyDeps>,
): Promise<void> {
  const requestedSession = getRequestedSessionName(req);
  const session = getScopedSession(requestedSession);
  if (!session) {
    res.writeHead(requestedSession ? 404 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: requestedSession ? `Session '${requestedSession}' not found` : "No active session" }));
    return;
  }

  const baseUrl = session.base_url || (session.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com");
  const queryString = req.url?.includes("?") ? req.url.split("?")[1] : "";
  const url = `${baseUrl}/v1/models${queryString ? "?" + queryString : ""}`;

  let headers: Record<string, string>;
  if (session.provider === "openai") {
    const accountId = session.account_id || "";
    headers = buildCodexHeaders(session.token, accountId);
  } else {
    headers = buildUpstreamHeaders(session.token, {});
  }

  try {
    const upstreamRes = await deps.fetchImpl(url, { headers });
    const body = await upstreamRes.text();
    res.writeHead(upstreamRes.status, {
      "content-type": "application/json",
      ...sessionUsedHeader(session.name),
    });
    res.end(body);
  } catch (err: any) {
    res.writeHead(502, {
      "content-type": "application/json",
      ...sessionUsedHeader(session.name),
    });
    res.end(JSON.stringify({ error: err.message }));
  }
}

async function runAnthropicProbe(session: any, deps: Required<ProxyDeps>): Promise<SessionProbeStatus> {
  const startedAt = Date.now();
  const token = session.token;
  const baseUrl = session.base_url || "https://api.anthropic.com";
  const headers = buildUpstreamHeaders(token, {});
  const body = injectBillingHeader({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
  }, token);

  try {
    const upstreamRes = await deps.fetchImpl(getUpstreamUrl(baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const probeRateLimits = extractRateLimits(upstreamRes.headers);
    if (Object.keys(probeRateLimits).length > 0) rateLimits[session.name] = probeRateLimits;
    return {
      ok: upstreamRes.ok,
      status: upstreamRes.status,
      health_state: upstreamRes.ok ? "healthy" : "unhealthy",
      health_message: upstreamRes.ok ? "Healthy" : `Unhealthy: HTTP ${upstreamRes.status}`,
      checked_at: new Date().toISOString(),
      latency_ms: Date.now() - startedAt,
      rate_limits: probeRateLimits,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      health_state: "unhealthy",
      health_message: "Unhealthy: probe failed",
      reason: err.message,
      checked_at: new Date().toISOString(),
      latency_ms: Date.now() - startedAt,
      rate_limits: rateLimits[session.name] || {},
    };
  }
}

async function runOpenAIProbe(session: any, deps: Required<ProxyDeps>): Promise<SessionProbeStatus> {
  const startedAt = Date.now();
  let translated: { url: string; headers: Record<string, string>; body: string };
  try {
    translated = translateRequest({
      model: "claude-haiku-4-5-20251001",
      stream: false,
      messages: [{ role: "user", content: "ping" }],
    }, session);
  } catch (err: any) {
    return {
      ok: false,
      status: 422,
      health_state: "unhealthy",
      health_message: `Unhealthy: ${err.message}`,
      reason: err.message,
      checked_at: new Date().toISOString(),
      latency_ms: Date.now() - startedAt,
      rate_limits: rateLimits[session.name] || {},
    };
  }

  const requestBody = JSON.parse(translated.body);
  requestBody.stream = true;

  return await new Promise((resolve) => {
    const ws = deps.openAIWsFactory(translated.url, { headers: translated.headers });
    let done = false;
    const finish = (status: SessionProbeStatus) => {
      if (done) return;
      done = true;
      setProbeStatus(session.name, status);
      resolve(status);
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "response.create", ...requestBody }));
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
          status: 502,
          health_state: "unhealthy",
          health_message: `Unhealthy: ${event.error?.message || "OpenAI error"}`,
          reason: event.error?.message || "OpenAI error",
          checked_at: new Date().toISOString(),
          latency_ms: Date.now() - startedAt,
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
          latency_ms: Date.now() - startedAt,
          rate_limits: rateLimits[session.name] || {},
        });
        ws.close();
      }
    });

    ws.on("error", (err) => {
      finish({
        ok: false,
        status: 502,
        health_state: "unhealthy",
        health_message: `Unhealthy: ${err.message}`,
        reason: err.message,
        checked_at: new Date().toISOString(),
        latency_ms: Date.now() - startedAt,
        rate_limits: rateLimits[session.name] || {},
      });
    });

    ws.on("close", (code, reason) => {
      finish({
        ok: false,
        status: code || 502,
        health_state: "unhealthy",
        health_message: `Unhealthy: WebSocket closed ${code}`,
        reason: reason.toString(),
        checked_at: new Date().toISOString(),
        latency_ms: Date.now() - startedAt,
        rate_limits: rateLimits[session.name] || {},
      });
    });
  });
}

async function runSessionProbe(session: any, deps: Required<ProxyDeps>): Promise<SessionProbeStatus> {
  const status = session.provider === "openai"
    ? await runOpenAIProbe(session, deps)
    : await runAnthropicProbe(session, deps);
  setProbeStatus(session.name, status);
  return status;
}

async function handleAdmin(req: IncomingMessage, res: ServerResponse, path: string, deps: Required<ProxyDeps>): Promise<void> {
  res.setHeader("content-type", "application/json");

  // GET /admin/sessions
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
    res.end(JSON.stringify({ sessions: annotatedSessions, active_session }));
    return;
  }

  // POST /admin/sessions
  if (req.method === "POST" && path === "/admin/sessions") {
    const body = JSON.parse(await readBody(req));
    if (!body.name || !body.provider || !body.token) {
      res.writeHead(422);
      res.end(JSON.stringify({ error: "Fields 'name', 'provider', and 'token' are required." }));
      return;
    }
    addSession(body.name, body.provider, body.token, body.base_url, body.model_override);
    res.end(JSON.stringify({ status: "ok", message: `Session '${body.name}' added.` }));
    return;
  }

  // DELETE /admin/sessions/:name
  if (req.method === "DELETE" && path.startsWith("/admin/sessions/")) {
    const name = decodeURIComponent(path.slice("/admin/sessions/".length));
    removeSession(name);
    res.end(JSON.stringify({ status: "ok", message: `Session '${name}' removed.` }));
    return;
  }

  // POST /admin/switch/:name
  if (req.method === "POST" && path.startsWith("/admin/switch/")) {
    const name = decodeURIComponent(path.slice("/admin/switch/".length));
    try {
      setActive(name);
      res.end(JSON.stringify({ status: "ok", message: `Active session set to '${name}'.` }));
    } catch (err: any) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /admin/status
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

  // POST /admin/chat-bind/:chat-session-id/:session-name
  if (req.method === "POST" && path.startsWith("/admin/chat-bind/")) {
    const rest = path.slice("/admin/chat-bind/".length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) {
      res.writeHead(422);
      res.end(JSON.stringify({ error: "Expected /admin/chat-bind/:chat-session-id/:session-name" }));
      return;
    }
    const chatId = decodeURIComponent(rest.slice(0, slashIdx));
    const sessionName = decodeURIComponent(rest.slice(slashIdx + 1));
    const { sessions } = listSessions();
    if (!sessions[sessionName]) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: `Session '${sessionName}' not found.` }));
      return;
    }
    chatSessionMap[chatId] = sessionName;
    res.end(JSON.stringify({ status: "ok", message: `Chat '${chatId}' bound to session '${sessionName}'.` }));
    return;
  }

  // DELETE /admin/chat-bind/:chat-session-id
  if (req.method === "DELETE" && path.startsWith("/admin/chat-bind/")) {
    const chatId = decodeURIComponent(path.slice("/admin/chat-bind/".length));
    delete chatSessionMap[chatId];
    res.end(JSON.stringify({ status: "ok", message: `Chat '${chatId}' unbound.` }));
    return;
  }

  // GET /admin/chat-sessions
  if (req.method === "GET" && path === "/admin/chat-sessions") {
    res.end(JSON.stringify({ chat_sessions: chatSessionMap, last_seen_chat_id: lastSeenChatSessionId }));
    return;
  }

  // GET /admin/rate-limits
  // Pings each session with GET /v1/models (no tokens consumed) to refresh rate-limit headers.
  if (req.method === "GET" && path === "/admin/rate-limits") {
    const { sessions } = listSessions();
    const result = Object.fromEntries(
      await Promise.all(
        Object.entries(sessions).map(async ([name, session]) => {
          const probe = await runSessionProbe({ name, ...session }, deps);
          return [name, probe] as const;
        }),
      ),
    );

    res.end(JSON.stringify({ rate_limits: result }));
    return;
  }

  // GET /admin/recent-chat-id
  if (req.method === "GET" && path === "/admin/recent-chat-id") {
    if (!lastSeenChatSessionId) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "No chat session seen yet." }));
      return;
    }
    res.end(JSON.stringify({ chat_session_id: lastSeenChatSessionId }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}

// --- Server factory ---

export function createProxyServer(overrides: ProxyDeps = {}) {
  const deps: Required<ProxyDeps> = {
    fetchImpl: overrides.fetchImpl ?? fetch,
    openAIWsFactory: overrides.openAIWsFactory ?? ((url, options) => new WsWebSocket(url, options)),
    codexBridgeWsFactory: overrides.codexBridgeWsFactory ?? ((url, options) => new WsWebSocket(url, options)),
    codexBridgeUrl: overrides.codexBridgeUrl ?? "wss://chatgpt.com/backend-api/codex/responses",
  };

  const server = createServer(async (req, res) => {
    const url = req.url || "/";

    // Health check (Claude Code sends HEAD / before requests)
    if ((req.method === "HEAD" || req.method === "GET") && url === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: "ok" }));
      return;
    }

    // Proxy route for Anthropic (match with or without query params)
    if (req.method === "POST" && (url === "/v1/messages" || url.startsWith("/v1/messages?"))) {
      return handleProxy(req, res, deps);
    }

    // Model discovery for Codex
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      return handleModels(req, res, deps);
    }

    // Admin routes
    if (url.startsWith("/admin/")) {
      return handleAdmin(req, res, url, deps);
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // WebSocket proxy for Codex (/v1/responses)
  const wss = new WebSocketServer({ server, path: "/responses" });

  wss.on("connection", (clientWs, req) => {
    const requestedSession = getRequestedWsSessionName(req);
    const session = getScopedSession(requestedSession);
    if (!session) {
      clientWs.close(
        requestedSession ? 4004 : 4003,
        requestedSession ? `Session '${requestedSession}' not found` : "No active OpenAI session",
      );
      return;
    }
    if (session.provider !== "openai") {
      clientWs.close(4003, "No active OpenAI session");
      return;
    }

    const accountId = session.account_id || "";

    // Build upstream headers from session + forward incoming headers
    const incomingHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") incomingHeaders[k.toLowerCase()] = v;
    }

    const upstreamHeaders = buildCodexHeaders(session.token, accountId, incomingHeaders);

    // Codex OAuth tokens use chatgpt.com backend
    const upstreamWs = deps.codexBridgeWsFactory(deps.codexBridgeUrl, {
      headers: upstreamHeaders,
    });

    let upstreamReady = false;
    const buffered: (string | Buffer)[] = [];

    upstreamWs.on("open", () => {
      upstreamReady = true;
      // Flush buffered messages
      for (const msg of buffered) {
        upstreamWs.send(msg);
      }
      buffered.length = 0;
    });

    // Client → Upstream (preserve text/binary frame type)
    clientWs.on("message", (data, isBinary) => {
      const msg = isBinary ? data : data.toString();
      if (upstreamReady) {
        upstreamWs.send(msg);
      } else {
        buffered.push(msg as any);
      }
    });

    // Upstream → Client (preserve text/binary frame type)
    upstreamWs.on("message", (data, isBinary) => {
      if (clientWs.readyState === clientWs.OPEN) {
        clientWs.send(isBinary ? data : data.toString());
      }
    });

    // Error handling
    upstreamWs.on("error", (err) => {
      console.error("Upstream WebSocket error:", err.message);
      clientWs.close(4502, "Upstream connection error");
    });

    clientWs.on("error", (err) => {
      console.error("Client WebSocket error:", err.message);
      upstreamWs.close();
    });

    // Close propagation
    upstreamWs.on("close", (code, reason) => {
      if (clientWs.readyState === clientWs.OPEN) {
        clientWs.close(code, reason.toString());
      }
    });

    clientWs.on("close", () => {
      if (upstreamWs.readyState === upstreamWs.OPEN) {
        upstreamWs.close();
      }
    });
  });

  return server;
}

export function startServer(port: number = 8411): void {
  const server = createProxyServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`LLM Switcher proxy running on http://127.0.0.1:${port}`);
  });
}
