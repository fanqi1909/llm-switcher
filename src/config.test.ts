import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addSession,
  getActiveSession,
  listSessions,
  loadConfig,
  removeSession,
  saveConfig,
  setActive,
} from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "config.json");

let originalConfig: string | null = null;

beforeEach(() => {
  originalConfig = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf-8") : null;
  rmSync(CONFIG_PATH, { force: true });
});

afterEach(() => {
  if (originalConfig === null) {
    rmSync(CONFIG_PATH, { force: true });
    return;
  }
  writeFileSync(CONFIG_PATH, originalConfig);
  chmodSync(CONFIG_PATH, 0o600);
});

describe("config persistence", () => {
  it("creates a default config file on first load", () => {
    const config = loadConfig();
    assert.equal(config.active_session, null);
    assert.deepEqual(config.sessions, {});
    assert.equal(existsSync(CONFIG_PATH), true);
  });

  it("writes config.json with mode 0600", () => {
    saveConfig({ active_session: null, sessions: {} });
    const mode = statSync(CONFIG_PATH).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("adds the first session as active and persists defaults", () => {
    addSession("claude-work", "anthropic", "sk-ant-test");

    const active = getActiveSession();
    assert.ok(active);
    assert.equal(active.name, "claude-work");
    assert.equal(active.provider, "anthropic");
    assert.equal(active.base_url, "https://api.anthropic.com");
  });

  it("does not replace the active session when adding another one", () => {
    addSession("claude-work", "anthropic", "sk-ant-test");
    addSession("gpt-work", "openai", "sk-openai-test", undefined, "gpt-5.4", "acct_123");

    const active = getActiveSession();
    assert.ok(active);
    assert.equal(active.name, "claude-work");

    const listed = listSessions();
    assert.equal(listed.sessions["gpt-work"].model_override, "gpt-5.4");
    assert.equal(listed.sessions["gpt-work"].account_id, "acct_123");
    assert.equal(listed.sessions["gpt-work"].base_url, "https://api.openai.com");
  });

  it("switches the active session", () => {
    addSession("claude-work", "anthropic", "sk-ant-test");
    addSession("gpt-work", "openai", "sk-openai-test");

    setActive("gpt-work");

    const active = getActiveSession();
    assert.ok(active);
    assert.equal(active.name, "gpt-work");
  });

  it("throws when switching to a missing session", () => {
    addSession("claude-work", "anthropic", "sk-ant-test");
    assert.throws(() => setActive("missing"), /not found/);
  });

  it("clears active_session when removing the active session", () => {
    addSession("claude-work", "anthropic", "sk-ant-test");
    removeSession("claude-work");

    assert.equal(getActiveSession(), null);
    assert.equal(listSessions().active_session, null);
  });
});
