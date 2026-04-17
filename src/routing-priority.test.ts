/**
 * Routing priority matrix tests.
 *
 * Priority order (highest → lowest):
 *   explicit_session_header
 *   explicit_session_header_compat
 *   chat_binding_fallback      ← promoted above model-based routing in #49
 *   model_override_exact
 *   session_name_alias
 *   active_session_fallback
 *   provider_inference_match
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "./config.js";
import { createProxyServer, resetRuntimeObservability } from "./proxy.js";

const tempDirs: string[] = [];

const MOCK_ANTHROPIC_RESPONSE = JSON.stringify({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
});

function makeMockProxy() {
  return createProxyServer({
    fetchImpl: async () =>
      new Response(MOCK_ANTHROPIC_RESPONSE, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
}

async function withServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const proxy = makeMockProxy();
  await once(proxy.listen(0, "127.0.0.1"), "listening");
  const addr = proxy.address();
  assert.ok(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      proxy.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

async function adminPost(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

async function addSession(
  baseUrl: string,
  name: string,
  opts: { model_override?: string; provider?: string } = {},
) {
  await adminPost(baseUrl, "/admin/sessions", {
    name,
    provider: opts.provider ?? "anthropic",
    token: "sk-ant-test",
    ...(opts.model_override ? { model_override: opts.model_override } : {}),
  });
}

async function bindChat(
  baseUrl: string,
  chatSessionId: string,
  sessionName: string,
) {
  await fetch(
    `${baseUrl}/admin/chat-bind/${encodeURIComponent(chatSessionId)}/${encodeURIComponent(sessionName)}`,
    { method: "POST" },
  );
}

async function sendMessage(
  baseUrl: string,
  opts: {
    model?: string;
    sessionHeader?: string;
    sessionHeaderCompat?: string;
    chatSessionId?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.sessionHeader) headers["x-llm-session"] = opts.sessionHeader;
  if (opts.sessionHeaderCompat)
    headers["x-llm-switch-session"] = opts.sessionHeaderCompat;
  if (opts.chatSessionId)
    headers["x-claude-code-session-id"] = opts.chatSessionId;

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-4-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  return {
    status: res.status,
    reason: res.headers.get("x-llm-routing-reason"),
    session: res.headers.get("x-llm-session-used"),
  };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "llm-switcher-routing-test-"));
  tempDirs.push(dir);
  process.env.LLM_SWITCHER_CONFIG_PATH = join(dir, "config.json");
  saveConfig({ active_session: null, sessions: {} });
  resetRuntimeObservability();
});

afterEach(() => {
  delete process.env.LLM_SWITCHER_CONFIG_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("routing priority matrix", () => {
  it("explicit_session_header beats chat_binding_fallback", async () => {
    await withServer(async (baseUrl) => {
      await addSession(baseUrl, "session-a");
      await addSession(baseUrl, "session-b");
      await bindChat(baseUrl, "chat-1", "session-b");

      const r = await sendMessage(baseUrl, {
        sessionHeader: "session-a",
        chatSessionId: "chat-1",
      });
      assert.equal(r.status, 200);
      assert.equal(r.reason, "explicit_session_header");
      assert.equal(r.session, "session-a");
    });
  });

  it("explicit_session_header beats model_override_exact", async () => {
    await withServer(async (baseUrl) => {
      await addSession(baseUrl, "session-a");
      await addSession(baseUrl, "session-b", { model_override: "gpt-4o" });

      const r = await sendMessage(baseUrl, {
        model: "gpt-4o",
        sessionHeader: "session-a",
      });
      assert.equal(r.status, 200);
      assert.equal(r.reason, "explicit_session_header");
      assert.equal(r.session, "session-a");
    });
  });

  it("explicit_session_header_compat beats chat_binding_fallback", async () => {
    await withServer(async (baseUrl) => {
      await addSession(baseUrl, "session-a");
      await addSession(baseUrl, "session-b");
      await bindChat(baseUrl, "chat-1", "session-b");

      const r = await sendMessage(baseUrl, {
        sessionHeaderCompat: "session-a",
        chatSessionId: "chat-1",
      });
      assert.equal(r.status, 200);
      assert.equal(r.reason, "explicit_session_header_compat");
      assert.equal(r.session, "session-a");
    });
  });

  it("chat_binding_fallback beats model_override_exact", async () => {
    await withServer(async (baseUrl) => {
      await addSession(baseUrl, "session-a");
      await addSession(baseUrl, "session-b", { model_override: "gpt-4o" });
      await bindChat(baseUrl, "chat-1", "session-a");

      // body carries model=gpt-4o which would match session-b via model_override_exact,
      // but the chat binding to session-a must win
      const r = await sendMessage(baseUrl, {
        model: "gpt-4o",
        chatSessionId: "chat-1",
      });
      assert.equal(r.status, 200);
      assert.equal(r.reason, "chat_binding_fallback");
      assert.equal(r.session, "session-a");
    });
  });

  it("chat_binding_fallback beats session_name_alias", async () => {
    await withServer(async (baseUrl) => {
      await addSession(baseUrl, "session-a");
      await addSession(baseUrl, "session-b");
      await bindChat(baseUrl, "chat-1", "session-a");

      // model="session-b" would match session_name_alias, but chat binding wins
      const r = await sendMessage(baseUrl, {
        model: "session-b",
        chatSessionId: "chat-1",
      });
      assert.equal(r.status, 200);
      assert.equal(r.reason, "chat_binding_fallback");
      assert.equal(r.session, "session-a");
    });
  });

  it("chat_binding_fallback beats active_session_fallback", async () => {
    await withServer(async (baseUrl) => {
      await addSession(baseUrl, "session-active");
      await addSession(baseUrl, "session-bound");
      // make session-active the active session
      await fetch(`${baseUrl}/admin/sessions/session-active/activate`, {
        method: "POST",
      });
      await bindChat(baseUrl, "chat-1", "session-bound");

      const r = await sendMessage(baseUrl, { chatSessionId: "chat-1" });
      assert.equal(r.status, 200);
      assert.equal(r.reason, "chat_binding_fallback");
      assert.equal(r.session, "session-bound");
    });
  });

  it("model_override_exact beats session_name_alias", async () => {
    await withServer(async (baseUrl) => {
      // session-b exists (session_name_alias candidate for model="session-b")
      // session-a has model_override="session-b" (exact match wins)
      await addSession(baseUrl, "session-a", { model_override: "session-b" });
      await addSession(baseUrl, "session-b");

      const r = await sendMessage(baseUrl, { model: "session-b" });
      assert.equal(r.status, 200);
      assert.equal(r.reason, "model_override_exact");
      assert.equal(r.session, "session-a");
    });
  });

  it("model_override_exact beats active_session_fallback", async () => {
    await withServer(async (baseUrl) => {
      await addSession(baseUrl, "session-active");
      await fetch(`${baseUrl}/admin/sessions/session-active/activate`, {
        method: "POST",
      });
      await addSession(baseUrl, "session-override", {
        model_override: "gpt-4o",
      });

      const r = await sendMessage(baseUrl, { model: "gpt-4o" });
      assert.equal(r.status, 200);
      assert.equal(r.reason, "model_override_exact");
      assert.equal(r.session, "session-override");
    });
  });

  it("session_name_alias beats active_session_fallback", async () => {
    await withServer(async (baseUrl) => {
      await addSession(baseUrl, "session-active");
      await fetch(`${baseUrl}/admin/sessions/session-active/activate`, {
        method: "POST",
      });
      await addSession(baseUrl, "session-named");

      const r = await sendMessage(baseUrl, { model: "session-named" });
      assert.equal(r.status, 200);
      assert.equal(r.reason, "session_name_alias");
      assert.equal(r.session, "session-named");
    });
  });

  it("active_session_fallback beats provider_inference_match", async () => {
    await withServer(async (baseUrl) => {
      await addSession(baseUrl, "session-active", { provider: "anthropic" });
      await fetch(`${baseUrl}/admin/sessions/session-active/activate`, {
        method: "POST",
      });

      // claude-opus-4-5 would match provider_inference_match for anthropic,
      // but since there is an active session it should win as active_session_fallback
      const r = await sendMessage(baseUrl, { model: "claude-opus-4-5" });
      assert.equal(r.status, 200);
      assert.equal(r.reason, "active_session_fallback");
      assert.equal(r.session, "session-active");
    });
  });

  it("no chat binding for a different chat session id does not interfere", async () => {
    await withServer(async (baseUrl) => {
      await addSession(baseUrl, "session-a");
      await addSession(baseUrl, "session-b");
      await fetch(`${baseUrl}/admin/sessions/session-a/activate`, {
        method: "POST",
      });
      await bindChat(baseUrl, "chat-other", "session-b");

      // chat-1 has no binding → should fall back to active session
      const r = await sendMessage(baseUrl, { chatSessionId: "chat-1" });
      assert.equal(r.status, 200);
      assert.equal(r.reason, "active_session_fallback");
      assert.equal(r.session, "session-a");
    });
  });
});
