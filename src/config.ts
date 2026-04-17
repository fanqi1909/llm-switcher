import { readFileSync, writeFileSync, chmodSync, existsSync, renameSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Write config atomically: temp file → rename, so a crash mid-write never
 *  leaves a truncated config.json.  Also sets mode 0600. */
function atomicSave(config: Config): void {
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  chmodSync(tmp, 0o600);
  renameSync(tmp, CONFIG_PATH);
}

/** Process-level write serialization: all mutations are queued on this
 *  promise chain so concurrent requests never interleave load → save pairs. */
let writeLock: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => T): Promise<T> {
  const result = writeLock.then(() => fn());
  // Keep the chain alive even if fn() throws, so later callers aren't stuck.
  writeLock = (result as Promise<unknown>).then(
    () => {},
    () => {},
  );
  return result;
}

// ---------------------------------------------------------------------------
// Public read API  (no lock needed — reads are always consistent because
// writes are atomic rename operations)
// ---------------------------------------------------------------------------

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    const def: Config = { active_session: null, sessions: {} };
    atomicSave(def);
    return def;
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
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

export function listSessions(): { sessions: Record<string, Session>; active_session: string | null } {
  const config = loadConfig();
  return { sessions: config.sessions, active_session: config.active_session };
}

// ---------------------------------------------------------------------------
// saveConfig — kept for test fixtures and one-shot CLI bootstrap.
// Prefer the async mutation functions below for all runtime writes.
// ---------------------------------------------------------------------------

export function saveConfig(config: Config): void {
  atomicSave(config);
}

// ---------------------------------------------------------------------------
// Public write API  (serialized via writeLock)
// ---------------------------------------------------------------------------

export function addSession(
  name: string,
  provider: "anthropic" | "openai",
  token: string,
  baseUrl?: string,
  modelOverride?: string,
  accountId?: string,
  refreshToken?: string,
): Promise<void> {
  return withLock(() => {
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
    atomicSave(config);
  });
}

export function updateSessionToken(name: string, token: string): Promise<void> {
  return withLock(() => {
    const config = loadConfig();
    if (!config.sessions[name]) throw new Error(`Session '${name}' not found`);
    config.sessions[name].token = token;
    atomicSave(config);
  });
}

export function removeSession(name: string): Promise<void> {
  return withLock(() => {
    const config = loadConfig();
    delete config.sessions[name];
    if (config.active_session === name) config.active_session = null;
    atomicSave(config);
  });
}

export function setActive(name: string): Promise<void> {
  return withLock(() => {
    const config = loadConfig();
    if (!(name in config.sessions)) throw new Error(`Session '${name}' not found`);
    config.active_session = name;
    atomicSave(config);
  });
}

export function setSessionModel(name: string, model: string): Promise<void> {
  return withLock(() => {
    const config = loadConfig();
    const session = config.sessions[name];
    if (!session) throw new Error(`Session '${name}' not found`);
    session.model_override = model;
    atomicSave(config);
  });
}
