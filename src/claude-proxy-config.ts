import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PROXY_URL = "http://127.0.0.1:8411";

export function getDefaultClaudeSettingsPath(home: string = homedir()): string {
  return join(home, ".claude", "settings.json");
}

export function readClaudeSettings(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function applyClaudeProxyConfig(settings: Record<string, any>, proxyUrl: string = DEFAULT_PROXY_URL): Record<string, any> {
  const env = typeof settings.env === "object" && settings.env !== null ? settings.env : {};
  return {
    ...settings,
    env: {
      ...env,
      ANTHROPIC_BASE_URL: proxyUrl,
    },
  };
}

export function writeClaudeSettings(path: string, settings: Record<string, any>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

export async function assertLocalProxyHealthy(proxyUrl: string = DEFAULT_PROXY_URL): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${proxyUrl}/`, { signal: AbortSignal.timeout(2000) });
  } catch {
    throw new Error(`llm-switcher is not reachable at ${proxyUrl}. Start 'llm-switcher serve' first.`);
  }

  if (!res.ok) {
    throw new Error(`llm-switcher health check failed at ${proxyUrl} (HTTP ${res.status}).`);
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!body || body.status !== "ok") {
    throw new Error(`llm-switcher health check returned an unexpected response from ${proxyUrl}.`);
  }
}
