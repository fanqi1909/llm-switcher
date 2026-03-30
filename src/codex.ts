import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
