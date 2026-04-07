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

// --- Rate limit tracking ---
const rateLimits: Record<string, Record<string, string>> = {};

function updateRateLimits(sessionName: string, headers: Headers): void {
  const info: Record<string, string> = {};
  for (const key of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
    const val = headers.get(key);
    if (val) info[key] = val;
  }
  if (Object.keys(info).length > 0) rateLimits[sessionName] = info;
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
    const upstreamRes = await deps.fetchImpl(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    updateRateLimits(session.name, upstreamRes.headers);

    if (isStream && upstreamRes.body) {
      // Stream SSE passthrough
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
      // JSON passthrough
      const responseBody = await upstreamRes.text();
      res.writeHead(upstreamRes.status, {
        "content-type": "application/json",
        ...sessionUsedHeader(session.name),
      });
      res.end(responseBody);
    }
  } catch (err: any) {
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
  let translated: { url: string; headers: Record<string, string>; body: string };
  try {
    translated = translateRequest(body, session);
  } catch (err: any) {
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request", message: err.message } }));
    return;
  }

  const isStream = body.stream === true;
  const requestBody = JSON.parse(translated.body);
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
      endResponse(502, { error: { type: "api_error", message: event.error?.message || "OpenAI error" } });
      ws.close();
      return;
    }

    if (isStream) {
      processWsEvent(event, writeSSE);

      if (event.type === "response.completed") {
        processWsEvent({ type: "_finish" }, writeSSE);
        responseDone = true;
        res.end();
        ws.close();
      }
    } else {
      events.push(event);

      if (event.type === "response.completed") {
        const anthropicRes = translateResponse(event.response);
        endResponse(200, anthropicRes);
        ws.close();
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`[OpenAI] WS connection error:`, err.message);
    endResponse(502, { error: { type: "upstream_connection_error", message: err.message } });
  });

  ws.on("close", (code, reason) => {
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

async function handleAdmin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  res.setHeader("content-type", "application/json");

  // GET /admin/sessions
  if (req.method === "GET" && path === "/admin/sessions") {
    res.end(JSON.stringify(listSessions()));
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
      }));
      return;
    }
    const { token, ...safe } = session;
    res.end(JSON.stringify({
      active_session: safe,
      available_sessions: availableSessions,
      override_header: "x-llm-session",
      override_ws_param: "?session=<name>",
      rate_limits: rateLimits[session.name] || {},
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
      return handleAdmin(req, res, url);
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
