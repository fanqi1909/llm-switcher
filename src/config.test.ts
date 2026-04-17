import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addSession,
  getActiveSession,
  getSession,
  listSessions,
  loadConfig,
  removeSession,
  saveConfig,
  setActive,
  setSessionModel,
  updateSessionToken,
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

  it("adds the first session as active and persists defaults", async () => {
    await addSession("claude-work", "anthropic", "sk-ant-test");

    const active = getActiveSession();
    assert.ok(active);
    assert.equal(active.name, "claude-work");
    assert.equal(active.provider, "anthropic");
    assert.equal(active.base_url, "https://api.anthropic.com");
  });

  it("does not replace the active session when adding another one", async () => {
    await addSession("claude-work", "anthropic", "sk-ant-test");
    await addSession("gpt-work", "openai", "sk-openai-test", undefined, "gpt-5.4", "acct_123");

    const active = getActiveSession();
    assert.ok(active);
    assert.equal(active.name, "claude-work");

    const listed = listSessions();
    assert.equal(listed.sessions["gpt-work"].model_override, "gpt-5.4");
    assert.equal(listed.sessions["gpt-work"].account_id, "acct_123");
    assert.equal(listed.sessions["gpt-work"].base_url, "https://api.openai.com");
  });

  it("switches the active session", async () => {
    await addSession("claude-work", "anthropic", "sk-ant-test");
    await addSession("gpt-work", "openai", "sk-openai-test");

    await setActive("gpt-work");

    const active = getActiveSession();
    assert.ok(active);
    assert.equal(active.name, "gpt-work");
  });

  it("returns a named session without changing the active session", async () => {
    await addSession("claude-work", "anthropic", "sk-ant-test");
    await addSession("gpt-work", "openai", "sk-openai-test", undefined, "gpt-5.4");

    const session = getSession("gpt-work");
    assert.ok(session);
    assert.equal(session.name, "gpt-work");
    assert.equal(session.model_override, "gpt-5.4");
    assert.equal(getActiveSession()?.name, "claude-work");
  });

  it("returns null for a missing named session", async () => {
    await addSession("claude-work", "anthropic", "sk-ant-test");
    assert.equal(getSession("missing"), null);
  });

  it("updates the configured model for a named session", async () => {
    await addSession("claude-work", "anthropic", "sk-ant-test");
    await addSession("gpt-work", "openai", "sk-openai-test");

    await setSessionModel("claude-work", "claude-sonnet-4-5");
    await setSessionModel("gpt-work", "gpt-5.4");

    assert.equal(getSession("claude-work")?.model_override, "claude-sonnet-4-5");
    assert.equal(getSession("gpt-work")?.model_override, "gpt-5.4");
  });

  it("throws when setting a model for a missing session", async () => {
    await addSession("claude-work", "anthropic", "sk-ant-test");
    await assert.rejects(() => setSessionModel("missing", "gpt-5.4"), /not found/);
  });

  it("throws when switching to a missing session", async () => {
    await addSession("claude-work", "anthropic", "sk-ant-test");
    await assert.rejects(() => setActive("missing"), /not found/);
  });

  it("clears active_session when removing the active session", async () => {
    await addSession("claude-work", "anthropic", "sk-ant-test");
    await removeSession("claude-work");

    assert.equal(getActiveSession(), null);
    assert.equal(listSessions().active_session, null);
  });
});

describe("config write serialization", () => {
  it("concurrent addSession calls do not lose data", async () => {
    // Fire 10 addSession calls concurrently — all must survive in config.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        addSession(`session-${i}`, "anthropic", `sk-ant-token-${i}`)
      )
    );

    const { sessions } = listSessions();
    for (let i = 0; i < 10; i++) {
      assert.ok(sessions[`session-${i}`], `session-${i} should be present`);
      assert.equal(sessions[`session-${i}`].token, `sk-ant-token-${i}`);
    }
    assert.equal(Object.keys(sessions).length, 10);
  });

  it("concurrent updateSessionToken calls do not corrupt each other", async () => {
    await addSession("shared", "anthropic", "sk-ant-initial");

    // 20 concurrent token updates — last writer wins, but no corruption
    const tokens = Array.from({ length: 20 }, (_, i) => `sk-ant-token-v${i}`);
    await Promise.all(tokens.map((t) => updateSessionToken("shared", t)));

    const session = getSession("shared");
    assert.ok(session, "session should still exist after concurrent updates");
    // Token must be one of the valid values written — not corrupted JSON
    assert.ok(tokens.includes(session.token), `token '${session.token}' should be one of the written values`);
  });

  it("interleaved addSession and setActive do not corrupt active_session", async () => {
    await addSession("alpha", "anthropic", "sk-ant-alpha");
    await addSession("beta", "openai", "sk-openai-beta");

    // Concurrently: keep switching active while also adding a new session
    await Promise.all([
      setActive("alpha"),
      setActive("beta"),
      addSession("gamma", "anthropic", "sk-ant-gamma"),
      setActive("alpha"),
    ]);

    const { active_session, sessions } = listSessions();
    assert.ok(["alpha", "beta"].includes(active_session!), "active session should be one of the valid names");
    assert.ok(sessions["gamma"], "gamma session should have been added");
  });

  it("config file is never left in a truncated state on disk", async () => {
    // The atomic temp-rename strategy means the file is always a complete JSON.
    await addSession("robust", "anthropic", "sk-ant-robust");

    // Run concurrent writes; after each completes, the file must be valid JSON.
    const checks: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      checks.push(
        addSession(`concurrent-${i}`, "openai", `sk-openai-${i}`).then(() => {
          const raw = readFileSync(CONFIG_PATH, "utf-8");
          // Must be valid JSON — never a partial write
          assert.doesNotThrow(() => JSON.parse(raw), `config.json should be valid JSON after write ${i}`);
        })
      );
    }
    await Promise.all(checks);
  });
});
