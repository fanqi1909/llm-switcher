import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyClaudeProxyConfig,
  getDefaultClaudeSettingsPath,
  readClaudeSettings,
  writeClaudeSettings,
} from "./claude-proxy-config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("claude proxy config", () => {
  it("computes the default Claude settings path", () => {
    assert.equal(
      getDefaultClaudeSettingsPath("/tmp/demo-home"),
      "/tmp/demo-home/.claude/settings.json",
    );
  });

  it("merges the proxy env without dropping existing keys", () => {
    const updated = applyClaudeProxyConfig({
      theme: "light",
      env: {
        FOO: "bar",
      },
    });

    assert.equal(updated.theme, "light");
    assert.equal(updated.env.FOO, "bar");
    assert.equal(updated.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8411");
  });

  it("writes and reads Claude settings JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-switcher-claude-settings-"));
    tempDirs.push(dir);
    const settingsPath = join(dir, ".claude", "settings.json");

    writeClaudeSettings(settingsPath, {
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8411" },
    });

    assert.equal(
      readFileSync(settingsPath, "utf-8"),
      '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8411"\n  }\n}\n',
    );
    assert.deepEqual(readClaudeSettings(settingsPath), {
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8411" },
    });
  });

  it("returns an empty object when Claude settings do not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-switcher-claude-settings-"));
    tempDirs.push(dir);
    const settingsPath = join(dir, ".claude", "settings.json");

    assert.deepEqual(readClaudeSettings(settingsPath), {});
  });
});
