import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createServer } from "node:http";
import { once, EventEmitter } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "./config.js";
import { createProxyServer, resetRuntimeObservability, setProbeCheckedAtForTest } from "./proxy.js";

const tempDirs: string[] = [];

async function withHttpServer(server: ReturnType<typeof createServer>, fn: (baseUrl: string) => Promise<void>) {
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  await withHttpServer(createProxyServer(), fn);
}

async function withCustomServer(server: ReturnType<typeof createServer>, fn: (baseUrl: string) => Promise<void>) {
  await withHttpServer(server, fn);
}

async function request(baseUrl: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, init);
  return {
    status: res.status,
    headers: res.headers,
    text: await res.text(),
  };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "llm-switcher-proxy-test-"));
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

describe("proxy HTTP routes", () => {
  it("returns 200 for GET / health check", async () => {
    await withServer(async (baseUrl) => {
      const res = await request(baseUrl, "/");
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.text).status, "ok");
    });
  });

  it("returns 200 for HEAD / health check", async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`, { method: "HEAD" });
      assert.equal(res.status, 200);
    });
  });

  it("returns 400 for invalid JSON on /v1/messages", async () => {
    await withServer(async (baseUrl) => {
      const res = await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      assert.equal(res.status, 400);
    });
  });

  it("returns 503 when no active session exists", async () => {
    await withServer(async (baseUrl) => {
      const res = await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      });
      assert.equal(res.status, 503);
      const body = JSON.parse(res.text);
      assert.equal(body.error.type, "no_active_session");
    });
  });

  it("returns 503 for /v1/models without an active session", async () => {
    await withServer(async (baseUrl) => {
      const res = await request(baseUrl, "/v1/models");
      assert.equal(res.status, 503);
    });
  });

  it("proxies anthropic requests through fetch and applies model override", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const proxy = createProxyServer({
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{ type: "text", text: "hello" }],
          usage: { input_tokens: 12, output_tokens: 34 },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await withCustomServer(proxy, async (baseUrl) => {
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "claude-work",
          provider: "anthropic",
          token: "sk-ant-test",
          model_override: "claude-sonnet-4",
        }),
      });

      const res = await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-llm-session-used"), "claude-work");
      assert.equal(res.headers.get("x-llm-routing-reason"), "active_session_fallback");
      const body = JSON.parse(res.text);
      assert.equal(body.content[0].text, "hello");
      assert.equal(fetchCalls.length, 1);
      const sentBody = JSON.parse(String(fetchCalls[0].init?.body));
      assert.equal(sentBody.model, "claude-sonnet-4");
    });
  });

  it("uses the lean OAuth header set and billing block for anthropic OAuth sessions", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const proxy = createProxyServer({
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          id: "msg_oauth",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4",
          content: [],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await withCustomServer(proxy, async (baseUrl) => {
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "claude-oauth",
          provider: "anthropic",
          token: "sk-ant-oat01-test-token",
          base_url: "https://oauth.example.test",
        }),
      });

      const res = await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          system: "Be concise.",
        }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-llm-session-used"), "claude-oauth");
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, "https://oauth.example.test/v1/messages");

      const headers = fetchCalls[0].init?.headers as Record<string, string>;
      assert.equal(headers.authorization, "Bearer sk-ant-oat01-test-token");
      assert.equal(headers["anthropic-beta"], "claude-code-20250219,oauth-2025-04-20");
      assert.equal(headers["anthropic-dangerous-direct-browser-access"], undefined);
      assert.equal(headers["x-app"], "cli");

      const body = JSON.parse(String(fetchCalls[0].init?.body));
      assert.equal(body.system[0].text, "x-anthropic-billing-header: cc_version=2.1.87.d34; cc_entrypoint=cli;");
      assert.equal(body.system[1].text, "Be concise.");
    });
  });

  it("uses x-llm-session to override the global session for HTTP requests", async () => {
    const upstreamServer = createServer();
    const upstreamWss = new WebSocketServer({ server: upstreamServer });

    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstreamServer.address();
    assert.ok(upstreamAddress && typeof upstreamAddress === "object");
    const upstreamUrl = `ws://127.0.0.1:${upstreamAddress.port}`;

    upstreamWss.on("connection", (ws) => {
      ws.on("message", () => {
        ws.send(JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_override",
            model: "gpt-5.4",
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "from override session" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        }));
      });
    });

    const proxy = createProxyServer({
      openAIWsFactory: (_url, options) => new WebSocket(upstreamUrl, options),
    });

    try {
      await withCustomServer(proxy, async (baseUrl) => {
        await request(baseUrl, "/admin/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "claude-work",
            provider: "anthropic",
            token: "sk-ant-test",
          }),
        });

        await request(baseUrl, "/admin/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "gpt-work",
            provider: "openai",
            token: "sk-openai-test",
            model_override: "gpt-5.4",
          }),
        });

        const res = await request(baseUrl, "/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-llm-session": "gpt-work",
          },
          body: JSON.stringify({
            stream: false,
            messages: [{ role: "user", content: "hello" }],
          }),
        });

        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-llm-session-used"), "gpt-work");
        assert.equal(res.headers.get("x-llm-routing-reason"), "explicit_session_header");
      });
    } finally {
      await new Promise<void>((resolve, reject) => upstreamWss.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => upstreamServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("still accepts x-llm-switch-session as a compatibility alias", async () => {
    const upstreamServer = createServer();
    const upstreamWss = new WebSocketServer({ server: upstreamServer });

    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstreamServer.address();
    assert.ok(upstreamAddress && typeof upstreamAddress === "object");
    const upstreamUrl = `ws://127.0.0.1:${upstreamAddress.port}`;

    upstreamWss.on("connection", (ws) => {
      ws.on("message", () => {
        ws.send(JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_alias",
            model: "gpt-5.4",
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "from alias header" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        }));
      });
    });

    const proxy = createProxyServer({
      openAIWsFactory: (_url, options) => new WebSocket(upstreamUrl, options),
    });

    try {
      await withCustomServer(proxy, async (baseUrl) => {
        await request(baseUrl, "/admin/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "claude-work",
            provider: "anthropic",
            token: "sk-ant-test",
          }),
        });

        await request(baseUrl, "/admin/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "gpt-work",
            provider: "openai",
            token: "sk-openai-test",
            model_override: "gpt-5.4",
          }),
        });

        const res = await request(baseUrl, "/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-llm-switch-session": "gpt-work",
          },
          body: JSON.stringify({
            stream: false,
            messages: [{ role: "user", content: "hello" }],
          }),
        });

        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-llm-session-used"), "gpt-work");
        assert.equal(res.headers.get("x-llm-routing-reason"), "explicit_session_header_compat");
      });
    } finally {
      await new Promise<void>((resolve, reject) => upstreamWss.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => upstreamServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("returns 404 when x-llm-session points to a missing session", async () => {
    await withServer(async (baseUrl) => {
      const res = await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-llm-session": "missing",
        },
        body: JSON.stringify({ messages: [] }),
      });

      assert.equal(res.status, 404);
      assert.equal(res.headers.get("x-llm-routing-reason"), "explicit_session_header");
      const body = JSON.parse(res.text);
      assert.equal(body.error.type, "session_not_found");
    });
  });

  it("routes by model_override_exact when request model matches a session's model_override", async () => {
    const proxy = createProxyServer({
      fetchImpl: async () => new Response(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant",
        model: "claude-opus-4", content: [], usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    await withCustomServer(proxy, async (baseUrl) => {
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "opus-session", provider: "anthropic", token: "sk-ant-test", model_override: "claude-opus-4" }),
      });

      const res = await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4", messages: [{ role: "user", content: "hi" }] }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-llm-session-used"), "opus-session");
      assert.equal(res.headers.get("x-llm-routing-reason"), "model_override_exact");
    });
  });

  it("routes by session_name_alias when request model equals a session name", async () => {
    const proxy = createProxyServer({
      fetchImpl: async () => new Response(JSON.stringify({
        id: "msg_2", type: "message", role: "assistant",
        model: "claude-haiku-4", content: [], usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    await withCustomServer(proxy, async (baseUrl) => {
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "claude-haiku-4", provider: "anthropic", token: "sk-ant-test" }),
      });

      const res = await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4", messages: [{ role: "user", content: "hi" }] }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-llm-session-used"), "claude-haiku-4");
      assert.equal(res.headers.get("x-llm-routing-reason"), "session_name_alias");
    });
  });

  it("prefers the active session over provider inference when both are available", async () => {
    const upstreamServer = createServer();
    const upstreamWss = new WebSocketServer({ server: upstreamServer });

    await once(upstreamServer.listen(0, "127.0.0.1"), "listening");
    const addr = upstreamServer.address();
    assert.ok(addr && typeof addr === "object");
    const upstreamUrl = `ws://127.0.0.1:${addr.port}`;

    upstreamWss.on("connection", (ws) => {
      ws.on("message", () => {
        ws.send(JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_active",
            model: "gpt-5.4",
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "from active session" }] }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }));
      });
    });

    const proxy = createProxyServer({
      openAIWsFactory: (_url, options) => new WebSocket(upstreamUrl, options),
      fetchImpl: async () => new Response(JSON.stringify({
        id: "msg_active", type: "message", role: "assistant",
        model: "claude-sonnet-4-5", content: [], usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    try {
      await withCustomServer(proxy, async (baseUrl) => {
        await request(baseUrl, "/admin/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "codex-1", provider: "openai", token: "sk-openai-test", model_override: "gpt-5.4" }),
        });

        await request(baseUrl, "/admin/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "claude", provider: "anthropic", token: "sk-ant-test" }),
        });

        const res = await request(baseUrl, "/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-5", stream: false, messages: [{ role: "user", content: "hi" }] }),
        });

        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-llm-session-used"), "codex-1");
        assert.equal(res.headers.get("x-llm-routing-reason"), "active_session_fallback");
      });
    } finally {
      await new Promise<void>((resolve, reject) => upstreamWss.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => upstreamServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("routes by provider_inference_match when request model implies anthropic provider and no active session exists", async () => {
    const proxy = createProxyServer({
      fetchImpl: async () => new Response(JSON.stringify({
        id: "msg_3", type: "message", role: "assistant",
        model: "claude-sonnet-4-5", content: [], usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    await withCustomServer(proxy, async (baseUrl) => {
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "my-anthropic", provider: "anthropic", token: "sk-ant-test" }),
      });

      saveConfig({
        active_session: null,
        sessions: {
          "my-anthropic": {
            provider: "anthropic",
            token: "sk-ant-test",
          },
        },
      });

      const res = await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-llm-session-used"), "my-anthropic");
      assert.equal(res.headers.get("x-llm-routing-reason"), "provider_inference_match");
    });
  });

  it("prefers model_override_exact over provider_inference_match when both could match", async () => {
    const proxy = createProxyServer({
      fetchImpl: async () => new Response(JSON.stringify({
        id: "msg_4", type: "message", role: "assistant",
        model: "claude-opus-4", content: [], usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    await withCustomServer(proxy, async (baseUrl) => {
      // generic anthropic session (no model_override)
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "generic-claude", provider: "anthropic", token: "sk-ant-test" }),
      });
      // specific session pinned to claude-opus-4
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "opus-pinned", provider: "anthropic", token: "sk-ant-test2", model_override: "claude-opus-4" }),
      });

      const res = await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4", messages: [{ role: "user", content: "hi" }] }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-llm-session-used"), "opus-pinned");
      assert.equal(res.headers.get("x-llm-routing-reason"), "model_override_exact");
    });
  });
});

describe("session probe TTL", () => {
  it("caches probe result within 60s and does not re-probe", async () => {
    let probeCalls = 0;
    const proxy = createProxyServer({
      fetchImpl: async (url) => {
        if (String(url).includes("/v1/messages")) probeCalls++;
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await withCustomServer(proxy, async (baseUrl) => {
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "probe-session", provider: "anthropic", token: "sk-ant-test" }),
      });

      await request(baseUrl, "/admin/rate-limits");
      await request(baseUrl, "/admin/rate-limits");

      assert.equal(probeCalls, 1, "second call within TTL should use cache");
    });
  });

  it("re-probes after TTL expires", async () => {
    let probeCalls = 0;
    const proxy = createProxyServer({
      fetchImpl: async (url) => {
        if (String(url).includes("/v1/messages")) probeCalls++;
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await withCustomServer(proxy, async (baseUrl) => {
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "probe-session", provider: "anthropic", token: "sk-ant-test" }),
      });

      await request(baseUrl, "/admin/rate-limits");
      assert.equal(probeCalls, 1);

      // Backdate the cached probe to simulate TTL expiry
      const staleTime = new Date(Date.now() - 61_000).toISOString();
      setProbeCheckedAtForTest("probe-session", staleTime);

      await request(baseUrl, "/admin/rate-limits");
      assert.equal(probeCalls, 2, "should re-probe after TTL expires");
    });
  });
});

describe("OpenAI proxy effectiveModel", () => {
  it("records last_effective_model in observability after a successful OpenAI request", async () => {
    const upstreamServer = createServer();
    const upstreamWss = new WebSocketServer({ server: upstreamServer });

    await once(upstreamServer.listen(0, "127.0.0.1"), "listening");
    const addr = upstreamServer.address();
    assert.ok(addr && typeof addr === "object");
    const upstreamUrl = `ws://127.0.0.1:${addr.port}`;

    upstreamWss.on("connection", (ws) => {
      ws.on("message", () => {
        ws.send(JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_eff",
            model: "gpt-5.4",
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }));
      });
    });

    const proxy = createProxyServer({
      openAIWsFactory: (_url, options) => new WebSocket(upstreamUrl, options),
    });

    try {
      await withCustomServer(proxy, async (baseUrl) => {
        await request(baseUrl, "/admin/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "gpt-work", provider: "openai", token: "sk-openai-test", model_override: "gpt-5.4" }),
        });

        const res = await request(baseUrl, "/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-llm-session": "gpt-work" },
          body: JSON.stringify({ stream: false, model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(res.status, 200);

        const sessionsRes = await request(baseUrl, "/admin/sessions");
        const body = JSON.parse(sessionsRes.text);
        assert.equal(body.sessions["gpt-work"].last_effective_model, "gpt-5.4");
      });
    } finally {
      await new Promise<void>((resolve, reject) => upstreamWss.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => upstreamServer.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe("OpenAI token auto-refresh on 401", () => {
  it("refreshes token and retries when WS returns 401", async () => {
    const upstreamServer = createServer();
    const upstreamWss = new WebSocketServer({ server: upstreamServer });

    await once(upstreamServer.listen(0, "127.0.0.1"), "listening");
    const addr = upstreamServer.address();
    assert.ok(addr && typeof addr === "object");
    const upstreamUrl = `ws://127.0.0.1:${addr.port}`;

    let connectionCount = 0;
    upstreamWss.on("connection", (ws) => {
      connectionCount++;
      ws.on("message", () => {
        ws.send(JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_refresh",
            model: "gpt-5.4",
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }));
      });
    });

    let wsCallCount = 0;
    const expiredToken = "sk-expired";
    const freshToken = "sk-fresh";
    let refreshCalled = false;

    const proxy = createProxyServer({
      // First WS call with expired token → simulate 401; second call with fresh token → connect to real server
      openAIWsFactory: (_url, options) => {
        wsCallCount++;
        const authHeader = (options?.headers as any)?.authorization ?? "";
        if (authHeader.includes(expiredToken)) {
          // Return a fake WS that immediately errors with 401
          const fake = new EventEmitter() as any;
          fake.send = () => {};
          fake.close = () => {};
          setImmediate(() => fake.emit("error", Object.assign(new Error("Unexpected server response: 401"), { statusCode: 401 })));
          return fake;
        }
        return new WebSocket(upstreamUrl, options);
      },
      fetchImpl: async (url, init) => {
        if (String(url).includes("oauth/token")) {
          refreshCalled = true;
          return new Response(JSON.stringify({ access_token: freshToken, refresh_token: "rt-new" }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    try {
      await withCustomServer(proxy, async (baseUrl) => {
        await request(baseUrl, "/admin/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "codex",
            provider: "openai",
            token: expiredToken,
            model_override: "gpt-5.4",
            refresh_token: "rt-old",
          }),
        });

        const res = await request(baseUrl, "/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-llm-session": "codex" },
          body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "hi" }] }),
        });

        assert.equal(res.status, 200, "should succeed after token refresh");
        assert.equal(refreshCalled, true, "should have called token refresh endpoint");
        assert.equal(wsCallCount, 2, "should have made two WS connections");
        assert.equal(connectionCount, 1, "only the second WS should reach upstream");
      });
    } finally {
      await new Promise<void>((resolve, reject) => upstreamWss.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => upstreamServer.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe("worktree path rewriting", () => {
  it("rewrites file_path in non-streaming OpenAI tool_use response", async () => {
    const upstreamServer = createServer();
    const upstreamWss = new WebSocketServer({ server: upstreamServer });

    await once(upstreamServer.listen(0, "127.0.0.1"), "listening");
    const addr = upstreamServer.address();
    assert.ok(addr && typeof addr === "object");
    const upstreamUrl = `ws://127.0.0.1:${addr.port}`;

    upstreamWss.on("connection", (ws) => {
      ws.on("message", () => {
        ws.send(JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_wt",
            model: "gpt-5.4",
            status: "completed",
            output: [{
              type: "function_call",
              call_id: "call_wt",
              name: "Edit",
              arguments: JSON.stringify({ file_path: "/Users/x/project/src/foo.ts" }),
            }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }));
      });
    });

    const proxy = createProxyServer({
      openAIWsFactory: (_url, options) => new WebSocket(upstreamUrl, options),
    });

    try {
      await withCustomServer(proxy, async (baseUrl) => {
        await request(baseUrl, "/admin/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "gpt-wt", provider: "openai", token: "sk-test", model_override: "gpt-5.4" }),
        });

        const worktreePath = "/Users/x/project/.claude/worktrees/agent-abc";
        const systemPrompt = `You are Claude Code.\nWorking directory: ${worktreePath}\nDo good work.`;

        const res = await request(baseUrl, "/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-llm-session": "gpt-wt",
            "x-claude-code-session-id": "chat-wt-001",
          },
          body: JSON.stringify({
            stream: false,
            model: "gpt-5.4",
            system: systemPrompt,
            messages: [{ role: "user", content: "edit the file" }],
          }),
        });

        assert.equal(res.status, 200);
        const body = JSON.parse(res.text);
        const toolBlock = body.content.find((b: any) => b.type === "tool_use");
        assert.ok(toolBlock, "should have a tool_use block");
        assert.equal(
          toolBlock.input.file_path,
          `${worktreePath}/src/foo.ts`,
          "file_path should be rewritten to worktree path",
        );

        // /admin/path-map should reflect the detected mapping
        const mapRes = await request(baseUrl, "/admin/path-map");
        const mapBody = JSON.parse(mapRes.text);
        assert.ok(mapBody.path_mappings["chat-wt-001"]);
        assert.equal(mapBody.path_mappings["chat-wt-001"].worktree, worktreePath);
      });
    } finally {
      await new Promise<void>((resolve, reject) => upstreamWss.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => upstreamServer.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
