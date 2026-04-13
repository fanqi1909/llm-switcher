import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.LLM_SWITCHER_CONFIG_PATH ?? join(__dirname, "..", "config.json");

export interface Session {
  provider: "anthropic" | "openai";
  token: string;
  base_url: string;
  model_override?: string;
  account_id?: string;
  refresh_token?: string;
}

export interface Config {
  active_session: string | null;
  sessions: Record<string, Session>;
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    const def: Config = { active_session: null, sessions: {} };
    saveConfig(def);
    return def;
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

export function saveConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  chmodSync(CONFIG_PATH, 0o600);
}

export function addSession(
  name: string,
  provider: "anthropic" | "openai",
  token: string,
  baseUrl?: string,
  modelOverride?: string,
  accountId?: string,
  refreshToken?: string,
): void {
  const config = loadConfig();
  config.sessions[name] = {
    provider,
    token,
    base_url: baseUrl ?? (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"),
    ...(modelOverride ? { model_override: modelOverride } : {}),
    ...(accountId ? { account_id: accountId } : {}),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
  if (!config.active_session) config.active_session = name;
  saveConfig(config);
}

export function updateSessionToken(name: string, token: string): void {
  const config = loadConfig();
  if (!config.sessions[name]) throw new Error(`Session '${name}' not found`);
  config.sessions[name].token = token;
  saveConfig(config);
}

export function removeSession(name: string): void {
  const config = loadConfig();
  delete config.sessions[name];
  if (config.active_session === name) config.active_session = null;
  saveConfig(config);
}

export function setActive(name: string): void {
  const config = loadConfig();
  if (!(name in config.sessions)) throw new Error(`Session '${name}' not found`);
  config.active_session = name;
  saveConfig(config);
}

export function getActiveSession(): (Session & { name: string }) | null {
  const config = loadConfig();
  if (!config.active_session) return null;
  const session = config.sessions[config.active_session];
  if (!session) return null;
  return { name: config.active_session, ...session };
}

export function getSession(name: string): (Session & { name: string }) | null {
  const config = loadConfig();
  const session = config.sessions[name];
  if (!session) return null;
  return { name, ...session };
}

export function setSessionModel(name: string, model: string): void {
  const config = loadConfig();
  const session = config.sessions[name];
  if (!session) throw new Error(`Session '${name}' not found`);
  session.model_override = model;
  saveConfig(config);
}

export function listSessions(): { sessions: Record<string, Session>; active_session: string | null } {
  const config = loadConfig();
  return { sessions: config.sessions, active_session: config.active_session };
}
