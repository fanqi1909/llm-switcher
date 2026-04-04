import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  getClaudeCommandMarkdown,
  getDefaultClaudeCommandsDir,
  installClaudeCommand,
} from "./claude-command.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("claude command installer", () => {
  it("computes the default global Claude commands dir", () => {
    assert.equal(
      getDefaultClaudeCommandsDir("/tmp/demo-home"),
      "/tmp/demo-home/.claude/commands",
    );
  });

  it("reads the tracked repo command when present", () => {
    const markdown = getClaudeCommandMarkdown(join(process.cwd()));
    assert.match(markdown, /Switch LLM session via the llm-switcher proxy/);
    assert.match(markdown, /admin\/switch/);
  });

  it("installs llm-switch.md into the target commands directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-switcher-claude-"));
    tempDirs.push(dir);
    const commandsDir = join(dir, ".claude", "commands");

    const targetPath = installClaudeCommand(commandsDir, "test command");

    assert.equal(targetPath, join(commandsDir, "llm-switch.md"));
    assert.equal(readFileSync(targetPath, "utf-8"), "test command");
  });
});
