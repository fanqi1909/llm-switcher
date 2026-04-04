#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { addSession, removeSession, setActive, getActiveSession, listSessions } from "./config.js";
import { startServer } from "./proxy.js";
import { sniffOAuthToken } from "./login.js";
import { renderClaudeStatusline } from "./statusline.js";
import { getDefaultClaudeCommandsDir, installClaudeCommand } from "./claude-command.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
) as { version: string };

const program = new Command()
  .name("llm-switcher")
  .description("LLM proxy switcher - manage multiple LLM accounts")
  .version(version);

// --- serve ---
program
  .command("serve")
  .description("Start the LLM Switcher proxy server")
  .option("-p, --port <port>", "Port to listen on", "8411")
  .action((opts) => {
    startServer(parseInt(opts.port, 10));
  });

// --- login ---
program
  .command("login [name]")
  .description("Capture a fresh OAuth token from Claude Code and add as session")
  .action(async (name = "claude") => {
    console.log("Capturing fresh OAuth token from Claude Code...");
    const token = await sniffOAuthToken();
    if (!token) {
      console.error("Error: Failed to capture token. Make sure you're logged in with 'claude login'.");
      process.exit(1);
    }
    console.log(`Token captured: ${token.slice(0, 20)}...${token.slice(-10)}`);
    addSession(name, "anthropic", token);
    console.log(`\u2713 Session '${name}' ready with fresh OAuth token`);

    if (process.env.ANTHROPIC_API_KEY) {
      console.warn(
        "Warning: ANTHROPIC_API_KEY is set in your environment. " +
        "When using the proxy, unset it or set ANTHROPIC_BASE_URL=http://localhost:8411 instead."
      );
    }
  });

// --- codex-login ---
program
  .command("codex-login [name]")
  .description("Import Codex CLI OAuth token from ~/.codex/auth.json")
  .action(async (name = "codex") => {
    const { loadCodexAuth } = await import("./codex.js");
    const auth = loadCodexAuth();
    if (!auth?.tokens?.access_token) {
      console.error("Error: No Codex auth found. Run 'codex' first to login.");
      process.exit(1);
    }
    const token = auth.tokens.access_token;
    const accountId = auth.tokens.account_id;
    console.log(`Token found: ${token.slice(0, 20)}...`);
    console.log(`Account ID: ${accountId}`);

    addSession(name, "openai", token, undefined, undefined, accountId);
    console.log(`\u2713 Session '${name}' ready with Codex OAuth token`);
  });

// --- add ---
program
  .command("add <name>")
  .description("Add a new LLM session")
  .requiredOption("-p, --provider <provider>", "Provider: anthropic or openai")
  .requiredOption("-t, --token <token>", "API token or OAuth token")
  .option("-b, --base-url <url>", "Custom API base URL")
  .option("-m, --model <model>", "Model override")
  .action((name, opts) => {
    if (!["anthropic", "openai"].includes(opts.provider)) {
      console.error("Error: provider must be 'anthropic' or 'openai'");
      process.exit(1);
    }
    // Try HTTP first, fall back to direct config
    tryHttp("POST", "/admin/sessions", {
      name, provider: opts.provider, token: opts.token,
      base_url: opts.baseUrl, model_override: opts.model,
    }).then((ok) => {
      if (!ok) addSession(name, opts.provider, opts.token, opts.baseUrl, opts.model);
      console.log(`\u2713 Added session '${name}' (${opts.provider})`);
    });
  });

// --- remove ---
program
  .command("remove <name>")
  .description("Remove an LLM session")
  .action(async (name) => {
    const ok = await tryHttp("DELETE", `/admin/sessions/${name}`);
    if (!ok) removeSession(name);
    console.log(`\u2713 Removed session '${name}'`);
  });

// --- list ---
program
  .command("list")
  .description("List all LLM sessions")
  .action(async () => {
    let data = await tryHttp("GET", "/admin/sessions");
    if (!data) data = listSessions();

    const sessions = data.sessions || {};
    const active = data.active_session || "";

    if (Object.keys(sessions).length === 0) {
      console.log("No sessions configured. Use 'llm-switcher login' or 'llm-switcher add' to add one.");
      return;
    }

    console.log(`  ${"NAME".padEnd(20)} ${"PROVIDER".padEnd(12)} ${"MODEL".padEnd(18)} STATUS`);
    console.log(`  ${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(18)} ${"─".repeat(8)}`);

    for (const [name, session] of Object.entries(sessions) as [string, any][]) {
      const isActive = name === active;
      const prefix = isActive ? "* " : "  ";
      const model = session.model_override || "-";
      const status = isActive ? "active" : "";
      const line = `${prefix}${name.padEnd(20)} ${session.provider.padEnd(12)} ${model.padEnd(18)} ${status}`;
      console.log(isActive ? `\x1b[32m${line}\x1b[0m` : line);
    }
  });

// --- models ---
program
  .command("models [name]")
  .description("List available models for the active or named session")
  .action(async (name) => {
    const headers = name ? { "x-llm-session": name } : undefined;
    const result = await tryHttp("GET", "/v1/models", undefined, headers);

    if (!result?.data || !Array.isArray(result.data)) {
      console.error(
        name
          ? `Error: Unable to fetch models for session '${name}'. Make sure it exists and is supported.`
          : "Error: Unable to fetch models. Make sure there is an active session.",
      );
      process.exit(1);
    }

    if (result.data.length === 0) {
      console.log("No models returned.");
      return;
    }

    for (const model of result.data) {
      if (model?.id) console.log(model.id);
    }
  });

// --- switch ---
program
  .command("switch <name>")
  .description("Switch to a different LLM session")
  .action(async (name) => {
    const ok = await tryHttp("POST", `/admin/switch/${name}`);
    if (!ok) {
      try { setActive(name); } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
    }
    console.log(`\u2713 Switched to '${name}'`);
  });

// --- status ---
program
  .command("status")
  .description("Show current active session and quota info")
  .action(async () => {
    const result = await tryHttp("GET", "/admin/status");
    let name: string, provider: string, rateLimits: Record<string, string> = {};

    if (result?.active_session) {
      name = result.active_session.name;
      provider = result.active_session.provider;
      rateLimits = result.rate_limits || {};
    } else {
      const session = getActiveSession();
      if (!session) {
        console.log("No active session. Use 'llm-switcher login' to add one.");
        return;
      }
      name = session.name;
      provider = session.provider;
    }

    console.log(`Active: \x1b[1;32m${name}\x1b[0m`);
    console.log(`Provider: ${provider}`);
    if (rateLimits["x-ratelimit-remaining"]) {
      console.log(`Quota: ${rateLimits["x-ratelimit-remaining"]}/${rateLimits["x-ratelimit-limit"] || "?"} remaining`);
    } else {
      console.log("Quota: (no data yet)");
    }
  });

// --- statusline ---
program
  .command("statusline")
  .description("Render statusline text for Claude-style stdin payloads")
  .option("--json", "Output normalized routing context as JSON")
  .action(async (opts) => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const rawInput = Buffer.concat(chunks).toString("utf-8");
    const result = await renderClaudeStatusline(rawInput);

    if (opts.json) {
      console.log(JSON.stringify(result.context, null, 2));
      return;
    }

    console.log(result.text);
  });

// --- install-claude-command ---
program
  .command("install-claude-command")
  .description("Install /llm-switch as a global Claude command")
  .option("--dir <dir>", "Target Claude commands directory")
  .action((opts) => {
    const targetDir = opts.dir || getDefaultClaudeCommandsDir();
    const targetPath = installClaudeCommand(targetDir);
    console.log(`✓ Installed Claude command at ${targetPath}`);
  });

// --- HTTP helper ---
async function tryHttp(
  method: string,
  path: string,
  body?: any,
  extraHeaders?: Record<string, string>,
): Promise<any> {
  try {
    const res = await fetch(`http://localhost:8411${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(extraHeaders || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

program.parse();
