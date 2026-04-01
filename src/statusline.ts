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
  source: RoutingSource;
}

interface ProxyStatusResponse {
  active_session?: {
    name: string;
    provider: string;
  } | null;
}

type FetchLike = typeof fetch;

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

async function fetchProxyDefaultSession(
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

  const proxyDefaultSession = baseUrl
    ? await fetchProxyDefaultSession(baseUrl, fetchImpl)
    : undefined;

  if (scopedSession) {
    return {
      client: "claude",
      uses_proxy: true,
      scoped_session: scopedSession,
      proxy_default_session: proxyDefaultSession,
      effective_session: scopedSession,
      source: "scoped",
    };
  }

  if (proxyDefaultSession) {
    return {
      client: "claude",
      uses_proxy: true,
      proxy_default_session: proxyDefaultSession,
      effective_session: proxyDefaultSession,
      source: "proxy_default",
    };
  }

  return {
    client: "claude",
    uses_proxy: true,
    source: "unknown",
  };
}

export function formatStatusline(
  input: StatuslineInput,
  context: StatuslineRoutingContext,
): string {
  switch (context.source) {
    case "scoped":
      return `proxy: ${context.effective_session}`;
    case "proxy_default":
      return `proxy default: ${context.effective_session}`;
    case "direct":
      return input.model?.display_name ? `direct: ${input.model.display_name}` : "direct";
    default:
      return context.uses_proxy ? "proxy: unknown" : "unknown";
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
