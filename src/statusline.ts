export type RoutingSource = "direct" | "scoped" | "proxy_default" | "unknown";

export interface StatuslineInput {
  model?: {
    id?: string;
    display_name?: string;
  };
}

export interface StatuslineRoutingContext {
  client: "claude" | "codex" | "unknown";
  uses_proxy: boolean;
  scoped_session?: string;
  proxy_default_session?: string;
  effective_session?: string;
  effective_model?: string;
  health_state?: "healthy" | "unhealthy" | "unknown";
  source: RoutingSource;
}

interface ProxyStatusResponse {
  active_session?: {
    name: string;
    provider: string;
  } | null;
}

interface SessionAdminView {
  model_override?: string;
  observability?: {
    last_effective_model?: string | null;
    configured_model?: string | null;
  } | null;
  health_state?: "healthy" | "unhealthy" | "unknown";
}

interface ProxySessionsResponse {
  sessions?: Record<string, SessionAdminView>;
}

interface ProxyStatuslineSnapshot {
  proxyDefaultSession?: string;
  sessions: Record<string, SessionAdminView>;
}

type FetchLike = typeof fetch;

function getEffectiveModel(view: SessionAdminView | undefined): string | undefined {
  return view?.observability?.last_effective_model || view?.observability?.configured_model || view?.model_override || undefined;
}

function getHealthSuffix(state: StatuslineRoutingContext["health_state"]): string {
  if (state === "healthy") return "✓";
  if (state === "unhealthy") return "✗";
  return "";
}

function formatProxyLabel(prefix: string, context: StatuslineRoutingContext): string {
  const parts = [`${prefix}${context.effective_session}`];
  if (context.effective_model) parts.push(context.effective_model);
  const health = getHealthSuffix(context.health_state);
  if (health) parts.push(health);
  return parts.join(" · ");
}

export function parseScopedSessionFromHeaders(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/x-llm-(?:switch-)?session\s*:\s*([^\n;,]+)/i);
  return match?.[1]?.trim() || undefined;
}

export function isLoopbackProxyUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export async function fetchProxyDefaultSession(
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(new URL("/admin/status", baseUrl), {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return undefined;
    const body = await res.json() as ProxyStatusResponse;
    return body.active_session?.name || undefined;
  } catch {
    return undefined;
  }
}

export async function fetchProxySessions(
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<Record<string, SessionAdminView>> {
  try {
    const res = await fetchImpl(new URL("/admin/sessions", baseUrl), {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return {};
    const body = await res.json() as ProxySessionsResponse;
    return body.sessions || {};
  } catch {
    return {};
  }
}

export async function fetchStatuslineSnapshot(
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<ProxyStatuslineSnapshot> {
  const [proxyDefaultSession, sessions] = await Promise.all([
    fetchProxyDefaultSession(baseUrl, fetchImpl),
    fetchProxySessions(baseUrl, fetchImpl),
  ]);
  return { proxyDefaultSession, sessions };
}

export function buildProxyContext(
  scopedSession: string | undefined,
  snapshot: ProxyStatuslineSnapshot,
): StatuslineRoutingContext {
  const effectiveSession = scopedSession || snapshot.proxyDefaultSession;
  const view = effectiveSession ? snapshot.sessions[effectiveSession] : undefined;

  if (scopedSession) {
    return {
      client: "claude",
      uses_proxy: true,
      scoped_session: scopedSession,
      proxy_default_session: snapshot.proxyDefaultSession,
      effective_session: scopedSession,
      effective_model: getEffectiveModel(view),
      health_state: view?.health_state,
      source: "scoped",
    };
  }

  if (snapshot.proxyDefaultSession) {
    return {
      client: "claude",
      uses_proxy: true,
      proxy_default_session: snapshot.proxyDefaultSession,
      effective_session: snapshot.proxyDefaultSession,
      effective_model: getEffectiveModel(view),
      health_state: view?.health_state,
      source: "proxy_default",
    };
  }

  return {
    client: "claude",
    uses_proxy: true,
    source: "unknown",
  };
}

export async function resolveClaudeStatuslineContext(
  _input: StatuslineInput,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<StatuslineRoutingContext> {
  const baseUrl = env.ANTHROPIC_BASE_URL;
  const usesProxy = isLoopbackProxyUrl(baseUrl);
  const scopedSession = parseScopedSessionFromHeaders(env.ANTHROPIC_CUSTOM_HEADERS);

  if (!usesProxy) {
    return {
      client: "claude",
      uses_proxy: false,
      source: "direct",
    };
  }

  if (!baseUrl) {
    return {
      client: "claude",
      uses_proxy: true,
      source: "unknown",
    };
  }

  const snapshot = await fetchStatuslineSnapshot(baseUrl, fetchImpl);
  return buildProxyContext(scopedSession, snapshot);
}

export function formatStatusline(
  _input: StatuslineInput,
  context: StatuslineRoutingContext,
): string {
  switch (context.source) {
    case "scoped":
      return formatProxyLabel("proxy: ", context);
    case "proxy_default":
      return formatProxyLabel("proxy default: ", context);
    case "direct":
      return "";
    default:
      return context.uses_proxy ? "proxy: unknown" : "";
  }
}

export async function renderClaudeStatusline(
  rawInput: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<{ context: StatuslineRoutingContext; text: string }> {
  let input: StatuslineInput = {};
  try {
    input = rawInput.trim() ? JSON.parse(rawInput) as StatuslineInput : {};
  } catch {
    input = {};
  }

  const context = await resolveClaudeStatuslineContext(input, env, fetchImpl);
  return {
    context,
    text: formatStatusline(input, context),
  };
}
