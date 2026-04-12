import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrannkey";
const CODEX_TOKEN_ENDPOINT = "https://auth0.openai.com/oauth/token";

export interface CodexTokenRefreshResult {
  access_token: string;
  refresh_token?: string;
}

export async function refreshCodexToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexTokenRefreshResult> {
  const res = await fetchImpl(CODEX_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed: HTTP ${res.status} ${text}`);
  }

  const data = await res.json() as Record<string, unknown>;
  if (typeof data.access_token !== "string") {
    throw new Error("Token refresh response missing access_token");
  }

  return {
    access_token: data.access_token,
    ...(typeof data.refresh_token === "string" ? { refresh_token: data.refresh_token } : {}),
  };
}

export function updateCodexAuthFile(newTokens: CodexTokenRefreshResult): void {
  const authPath = join(homedir(), ".codex", "auth.json");
  if (!existsSync(authPath)) return;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    auth.tokens.access_token = newTokens.access_token;
    if (newTokens.refresh_token) auth.tokens.refresh_token = newTokens.refresh_token;
    auth.last_refresh = new Date().toISOString();
    writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
  } catch {
    // best-effort
  }
}

export interface CodexAuth {
  auth_mode: string;
  tokens: {
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
}

export function loadCodexAuth(): CodexAuth | null {
  const authPath = join(homedir(), ".codex", "auth.json");
  if (!existsSync(authPath)) return null;
  try {
    return JSON.parse(readFileSync(authPath, "utf-8"));
  } catch {
    return null;
  }
}

export function buildCodexHeaders(token: string, accountId: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "authorization": `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    "originator": "codex_exec",
    "version": "0.117.0",
    "user-agent": "codex_exec/0.117.0",
  };
  if (extra) {
    // Forward specific headers from incoming request
    const forward = ["openai-beta", "session_id", "x-codex-turn-metadata", "x-client-request-id"];
    for (const key of forward) {
      if (extra[key]) headers[key] = extra[key];
    }
  }
  return headers;
}
