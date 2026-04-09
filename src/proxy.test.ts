import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { createProxyServer, resetRuntimeObservability } from "./proxy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "config.json");

let originalConfig: string | null = null;

beforeEach(() => {
  originalConfig = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf-8") : null;
  rmSync(CONFIG_PATH, { force: true });
  resetRuntimeObservability();
});

afterEach(() => {
  if (originalConfig === null) {
    rmSync(CONFIG_PATH, { force: true });
    return;
  }
  writeFileSync(CONFIG_PATH, originalConfig);
  chmodSync(CONFIG_PATH, 0o600);
});

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createProxyServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function request(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  return {
    status: res.status,
    headers: res.headers,
    text: await res.text(),
  };
}

async function withCustomServer(
  server: ReturnType<typeof createProxyServer>,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function withHttpServer(
  handler: Parameters<typeof createServer>[0],
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

async function waitForMessage(ws: WebSocket): Promise<{ data: string; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data, isBinary) => resolve({ data: data.toString(), isBinary }));
    ws.once("error", reject);
  });
}

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.once("error", reject);
  });
}

describe("proxy HTTP routes", () => {
  it("returns 200 for GET / health check", async () => {
    await withServer(async (baseUrl) => {
      const res = await request(baseUrl, "/");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(res.text), { status: "ok" });
    });
  });

  it("returns 200 for HEAD / health check", async () => {
    await withServer(async (baseUrl) => {
      const res = await request(baseUrl, "/", { method: "HEAD" });
      assert.equal(res.status, 200);
      assert.equal(res.text, "");
    });
  });

  it("returns 400 for invalid JSON on /v1/messages", async () => {
    await withServer(async (baseUrl) => {
      const res = await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid",
      });

      assert.equal(res.status, 400);
      const body = JSON.parse(res.text);
      assert.equal(body.error.type, "invalid_request");
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
      assert.deepEqual(JSON.parse(res.text), { error: "No active session" });
    });
  });

  it("proxies anthropic requests through fetch and applies model override", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const proxy = createProxyServer({
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
          model_override: "claude-sonnet",
          base_url: "https://example.anthropic.test",
        }),
      });

      const res = await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-llm-session-used"), "claude-work");
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, "https://example.anthropic.test/v1/messages");
      const body = JSON.parse(String(fetchCalls[0].init?.body));
      assert.equal(body.model, "claude-sonnet");
      assert.equal(body.messages[0].content, "hi");
    });
  });

  it("uses the lean OAuth header set and billing block for anthropic OAuth sessions", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const proxy = createProxyServer({
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
        const body = JSON.parse(res.text);
        assert.equal(body.content[0].text, "from override session");
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
        const body = JSON.parse(res.text);
        assert.equal(body.content[0].text, "from alias header");
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
      const body = JSON.parse(res.text);
      assert.equal(body.error.type, "session_not_found");
    });
  });

  it("proxies /v1/models through the active openai session", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const proxy = createProxyServer({
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(JSON.stringify({ data: [{ id: "gpt-5.4" }] }), {
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
          name: "gpt-work",
          provider: "openai",
          token: "sk-openai-test",
          model_override: "gpt-5.4",
          base_url: "https://models.example.test",
        }),
      });

      const res = await request(baseUrl, "/v1/models?limit=1");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-llm-session-used"), "gpt-work");
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, "https://models.example.test/v1/models?limit=1");
      const body = JSON.parse(res.text);
      assert.equal(body.data[0].id, "gpt-5.4");
    });
  });

  it("proxies /v1/models through the active anthropic session", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const proxy = createProxyServer({
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }] }), {
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
          base_url: "https://models.anthropic.test",
        }),
      });

      const res = await request(baseUrl, "/v1/models");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-llm-session-used"), "claude-work");
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, "https://models.anthropic.test/v1/models");
      const headers = fetchCalls[0].init?.headers as Record<string, string>;
      assert.equal(headers["x-api-key"], "sk-ant-test");
      const body = JSON.parse(res.text);
      assert.equal(body.data[0].id, "claude-sonnet-4-5");
    });
  });

  it("uses x-llm-session to override the global session for /v1/models", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const proxy = createProxyServer({
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(JSON.stringify({ data: [{ id: "gpt-5.4" }] }), {
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
          base_url: "https://models.example.test",
        }),
      });

      const res = await request(baseUrl, "/v1/models", {
        headers: { "x-llm-session": "gpt-work" },
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-llm-session-used"), "gpt-work");
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, "https://models.example.test/v1/models");
    });
  });

  it("translates openai non-streaming responses back to anthropic format", async () => {
    const upstreamServer = createServer();
    const upstreamWss = new WebSocketServer({ server: upstreamServer });

    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstreamServer.address();
    assert.ok(upstreamAddress && typeof upstreamAddress === "object");
    const upstreamUrl = `ws://127.0.0.1:${upstreamAddress.port}`;

    upstreamWss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        assert.equal(msg.type, "response.create");
        ws.send(JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_123",
            model: "gpt-5.4",
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "hello from gpt" }],
              },
            ],
            usage: { input_tokens: 3, output_tokens: 4 },
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
            name: "gpt-work",
            provider: "openai",
            token: "sk-openai-test",
            model_override: "gpt-5.4",
          }),
        });

        const res = await request(baseUrl, "/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "ignored-by-openai-session",
            stream: false,
            messages: [{ role: "user", content: "hello" }],
          }),
        });

        assert.equal(res.status, 200);
        const body = JSON.parse(res.text);
        assert.equal(body.type, "message");
        assert.equal(body.role, "assistant");
        assert.equal(body.content[0].type, "text");
        assert.equal(body.content[0].text, "hello from gpt");
        assert.equal(body.usage.input_tokens, 3);
        assert.equal(body.usage.output_tokens, 4);
      });
    } finally {
      await new Promise<void>((resolve, reject) => upstreamWss.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => upstreamServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("streams openai websocket events back as anthropic SSE", async () => {
    const upstreamServer = createServer();
    const upstreamWss = new WebSocketServer({ server: upstreamServer });

    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstreamServer.address();
    assert.ok(upstreamAddress && typeof upstreamAddress === "object");
    const upstreamUrl = `ws://127.0.0.1:${upstreamAddress.port}`;

    upstreamWss.on("connection", (ws) => {
      ws.on("message", () => {
        ws.send(JSON.stringify({
          type: "response.created",
          response: { id: "resp_stream", model: "gpt-5.4" },
        }));
        ws.send(JSON.stringify({
          type: "response.content_part.added",
        }));
        ws.send(JSON.stringify({
          type: "response.output_text.delta",
          delta: "Hello",
        }));
        ws.send(JSON.stringify({
          type: "response.output_text.done",
        }));
        ws.send(JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_stream",
            model: "gpt-5.4",
            status: "completed",
            usage: { input_tokens: 2, output_tokens: 3 },
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
            name: "gpt-work",
            provider: "openai",
            token: "sk-openai-test",
            model_override: "gpt-5.4",
          }),
        });

        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          }),
        });

        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "text/event-stream");
        assert.equal(res.headers.get("x-llm-session-used"), "gpt-work");
        const text = await res.text();
        assert.match(text, /event: message_start/);
        assert.match(text, /event: content_block_start/);
        assert.match(text, /event: content_block_delta/);
        assert.match(text, /"text":"Hello"/);
        assert.match(text, /event: content_block_stop/);
        assert.match(text, /event: message_delta/);
        assert.match(text, /event: message_stop/);
      });
    } finally {
      await new Promise<void>((resolve, reject) => upstreamWss.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => upstreamServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("returns upstream error as JSON (not SSE) for streaming requests so Claude Code does not hang", async () => {
    const proxy = createProxyServer({
      fetchImpl: async () => {
        return new Response(
          JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limit exceeded" } }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
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
        }),
      });

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
      });

      assert.equal(res.status, 429);
      assert.equal(res.headers.get("content-type"), "application/json");
      const body = JSON.parse(await res.text());
      assert.equal(body.error.type, "rate_limit_error");
    });
  });

  it("tracks observability for anthropic requests in /admin/status", async () => {
    const proxy = createProxyServer({
      fetchImpl: async () => {
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5-20251001",
            content: [],
            usage: { input_tokens: 11, output_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
        }),
      });

      await request(baseUrl, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      const statusRes = await request(baseUrl, "/admin/status");
      const statusBody = JSON.parse(statusRes.text);
      assert.equal(statusBody.observability.last_requested_model, "claude-haiku-4-5-20251001");
      assert.equal(statusBody.observability.last_effective_model, "claude-haiku-4-5-20251001");
      assert.deepEqual(statusBody.observability.last_usage, { input_tokens: 11, output_tokens: 7 });
      assert.deepEqual(statusBody.observability.totals, {
        input_tokens: 11,
        output_tokens: 7,
        requests: 1,
        errors: 0,
      });
    });
  });

  it("tracks observability for openai requests in /admin/status", async () => {
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
            id: "resp_obs",
            model: "gpt-5.4",
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: 5, output_tokens: 3 },
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
            name: "gpt-work",
            provider: "openai",
            token: "sk-openai-test",
            model_override: "gpt-5.4",
          }),
        });

        await request(baseUrl, "/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            stream: false,
            messages: [{ role: "user", content: "hello" }],
          }),
        });

        const statusRes = await request(baseUrl, "/admin/status");
        const statusBody = JSON.parse(statusRes.text);
        assert.equal(statusBody.observability.configured_model, "gpt-5.4");
        assert.equal(statusBody.observability.last_requested_model, "claude-haiku-4-5-20251001");
        assert.equal(statusBody.observability.last_effective_model, "gpt-5.4");
        assert.deepEqual(statusBody.observability.last_usage, { input_tokens: 5, output_tokens: 3 });
      });
    } finally {
      await new Promise<void>((resolve, reject) => upstreamWss.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => upstreamServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("tracks observability errors for failed openai websocket requests", async () => {
    class FakeErrorSocket extends EventEmitter {
      send(_data: string): void {}
      close(): void {}
    }

    const proxy = createProxyServer({
      openAIWsFactory: () => {
        const ws = new FakeErrorSocket();
        queueMicrotask(() => {
          ws.emit("open");
          ws.emit("error", new Error("boom"));
        });
        return ws as unknown as WebSocket;
      },
    });

    await withCustomServer(proxy, async (baseUrl) => {
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      assert.equal(res.status, 502);
      const body = JSON.parse(res.text);
      assert.equal(body.error.type, "upstream_connection_error");
      assert.equal(body.error.message, "boom");

      const statusRes = await request(baseUrl, "/admin/status");
      const statusBody = JSON.parse(statusRes.text);
      assert.equal(statusBody.observability.last_error.type, "upstream_connection_error");
      assert.equal(statusBody.observability.last_error.message, "boom");
      assert.equal(statusBody.observability.totals.errors, 1);
    });
  });

  it("returns 502 when the openai websocket emits an error", async () => {
    class FakeErrorSocket extends EventEmitter {
      send(_data: string): void {}
      close(): void {}
    }

    const proxy = createProxyServer({
      openAIWsFactory: () => {
        const ws = new FakeErrorSocket();
        queueMicrotask(() => {
          ws.emit("open");
          ws.emit("error", new Error("boom"));
        });
        return ws as unknown as WebSocket;
      },
    });

    await withCustomServer(proxy, async (baseUrl) => {
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      assert.equal(res.status, 502);
      const body = JSON.parse(res.text);
      assert.equal(body.error.type, "upstream_connection_error");
      assert.equal(body.error.message, "boom");
    });
  });
});

describe("proxy admin routes", () => {
  it("adds, lists, switches, reports status, and removes sessions", async () => {
    await withServer(async (baseUrl) => {
      const addClaude = await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "claude-work",
          provider: "anthropic",
          token: "sk-ant-test",
        }),
      });
      assert.equal(addClaude.status, 200);

      const addGpt = await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "gpt-work",
          provider: "openai",
          token: "sk-openai-test",
          model_override: "gpt-5.4",
        }),
      });
      assert.equal(addGpt.status, 200);

      const listRes = await request(baseUrl, "/admin/sessions");
      assert.equal(listRes.status, 200);
      const listed = JSON.parse(listRes.text);
      assert.equal(listed.active_session, "claude-work");
      assert.equal(listed.sessions["claude-work"].provider, "anthropic");
      assert.equal(listed.sessions["gpt-work"].provider, "openai");
      assert.equal(listed.sessions["claude-work"].token, undefined, "token must not be exposed");
      assert.equal(listed.sessions["gpt-work"].token, undefined, "token must not be exposed");
      assert.equal(listed.sessions["claude-work"].configured_model, null);
      assert.equal(listed.sessions["gpt-work"].configured_model, "gpt-5.4");
      assert.equal(listed.sessions["claude-work"].last_effective_model, null);
      assert.deepEqual(listed.sessions["claude-work"].totals, {
        input_tokens: 0,
        output_tokens: 0,
        requests: 0,
        errors: 0,
      });

      const statusBefore = await request(baseUrl, "/admin/status");
      assert.equal(statusBefore.status, 200);
      const beforeBody = JSON.parse(statusBefore.text);
      assert.equal(beforeBody.active_session.name, "claude-work");
      assert.equal(beforeBody.active_session.provider, "anthropic");
      assert.equal(beforeBody.active_session.token, undefined);
      assert.deepEqual(beforeBody.available_sessions, ["claude-work", "gpt-work"]);
      assert.equal(beforeBody.override_header, "x-llm-session");
      assert.equal(beforeBody.override_ws_param, "?session=<name>");
      assert.equal(beforeBody.observability.configured_model, null);
      assert.equal(beforeBody.observability.last_effective_model, null);

      const switchRes = await request(baseUrl, "/admin/switch/gpt-work", {
        method: "POST",
      });
      assert.equal(switchRes.status, 200);

      const statusAfter = await request(baseUrl, "/admin/status");
      assert.equal(statusAfter.status, 200);
      const afterBody = JSON.parse(statusAfter.text);
      assert.equal(afterBody.active_session.name, "gpt-work");
      assert.equal(afterBody.active_session.provider, "openai");
      assert.equal(afterBody.active_session.token, undefined);
      assert.deepEqual(afterBody.available_sessions, ["claude-work", "gpt-work"]);
      assert.equal(afterBody.override_header, "x-llm-session");
      assert.equal(afterBody.override_ws_param, "?session=<name>");

      const removeRes = await request(baseUrl, "/admin/sessions/gpt-work", {
        method: "DELETE",
      });
      assert.equal(removeRes.status, 200);

      const listAfterRemove = await request(baseUrl, "/admin/sessions");
      const afterRemoveBody = JSON.parse(listAfterRemove.text);
      assert.equal(afterRemoveBody.sessions["gpt-work"], undefined);
      assert.equal(afterRemoveBody.active_session, null);
    });
  });

  it("returns 422 when required admin session fields are missing", async () => {
    await withServer(async (baseUrl) => {
      const res = await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "broken" }),
      });

      assert.equal(res.status, 422);
      assert.match(res.text, /required/);
    });
  });

  it("reports observability hints even when no active session exists", async () => {
    await withServer(async (baseUrl) => {
      const res = await request(baseUrl, "/admin/status");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.text);
      assert.equal(body.active_session, null);
      assert.deepEqual(body.available_sessions, []);
      assert.equal(body.override_header, "x-llm-session");
      assert.equal(body.override_ws_param, "?session=<name>");
      assert.deepEqual(body.rate_limits, {});
      assert.equal(body.observability, null);
    });
  });

  it("returns 404 when switching to a missing session", async () => {
    await withServer(async (baseUrl) => {
      const res = await request(baseUrl, "/admin/switch/missing", {
        method: "POST",
      });

      assert.equal(res.status, 404);
      assert.match(res.text, /not found/);
    });
  });

  it("GET /admin/sessions without ?health=true returns sessions without pinging upstream", async () => {
    let fetchCalled = false;
    const proxy = createProxyServer({
      fetchImpl: async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      },
    });

    await withCustomServer(proxy, async (baseUrl) => {
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "claude-work", provider: "anthropic", token: "sk-ant-test" }),
      });

      const res = await request(baseUrl, "/admin/sessions");
      assert.equal(res.status, 200);
      assert.equal(fetchCalled, false, "should not ping upstream without ?health=true");
      const body = JSON.parse(res.text);
      assert.equal(body.sessions["claude-work"].ok, undefined);
    });
  });

  it("GET /admin/sessions?health=true runs an Anthropic chat probe", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const proxy = createProxyServer({
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return new Response(JSON.stringify({ id: "msg_probe", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1, output_tokens: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "999" },
        });
      },
    });

    await withCustomServer(proxy, async (baseUrl) => {
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "claude-oauth", provider: "anthropic", token: "sk-ant-oat01-test-token", base_url: "https://api.anthropic.test" }),
      });

      const before = JSON.parse((await request(baseUrl, "/admin/status")).text);
      const res = await request(baseUrl, "/admin/sessions?health=true");
      assert.equal(res.status, 200);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, "https://api.anthropic.test/v1/messages");
      const probeBody = JSON.parse(String(fetchCalls[0].init?.body));
      assert.equal(probeBody.max_tokens, 1);
      assert.equal(probeBody.messages[0].content, "ping");

      const body = JSON.parse(res.text);
      assert.equal(body.sessions["claude-oauth"].ok, true);
      assert.equal(body.sessions["claude-oauth"].status, 200);
      assert.equal(body.sessions["claude-oauth"].health_state, "healthy");
      assert.equal(body.sessions["claude-oauth"].health_message, "Healthy");
      assert.equal(body.sessions["claude-oauth"].rate_limits["x-ratelimit-remaining"], "999");

      const after = JSON.parse((await request(baseUrl, "/admin/status")).text);
      assert.deepEqual(after.observability.totals, before.observability.totals, "probe must not affect normal observability totals");
    });
  });

  it("GET /admin/rate-limits runs an OpenAI chat probe", async () => {
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
          response: { id: "resp_probe", model: "gpt-5.4", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
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
            name: "gpt-work",
            provider: "openai",
            token: "sk-openai-test",
            model_override: "gpt-5.4",
          }),
        });

        const before = JSON.parse((await request(baseUrl, "/admin/status")).text);
        const res = await request(baseUrl, "/admin/rate-limits");
        assert.equal(res.status, 200);

        const body = JSON.parse(res.text);
        assert.equal(body.rate_limits["gpt-work"].ok, true);
        assert.equal(body.rate_limits["gpt-work"].status, 200);
        assert.equal(body.rate_limits["gpt-work"].health_state, "healthy");
        assert.equal(body.rate_limits["gpt-work"].health_message, "Healthy");

        const after = JSON.parse((await request(baseUrl, "/admin/status")).text);
        assert.deepEqual(after.observability.totals, before.observability.totals, "probe must not affect normal observability totals");
      });
    } finally {
      await new Promise<void>((resolve, reject) => upstreamWss.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => upstreamServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("GET /admin/rate-limits marks session not-ok when ping returns 4xx", async () => {
    const proxy = createProxyServer({
      fetchImpl: async () => {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      },
    });

    await withCustomServer(proxy, async (baseUrl) => {
      await request(baseUrl, "/admin/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "claude-bad",
          provider: "anthropic",
          token: "sk-ant-expired",
        }),
      });

      const res = await request(baseUrl, "/admin/rate-limits");
      assert.equal(res.status, 200);

      const body = JSON.parse(res.text);
      assert.equal(body.rate_limits["claude-bad"].ok, false);
      assert.equal(body.rate_limits["claude-bad"].status, 401);
    });
  });
});

describe("proxy websocket bridge", () => {
  it("rejects /responses when there is no active openai session", async () => {
    await withServer(async (baseUrl) => {
      const ws = new WebSocket(baseUrl.replace("http", "ws") + "/responses");
      await waitForOpen(ws);
      const closed = await waitForClose(ws);
      assert.equal(closed.code, 4003);
      assert.equal(closed.reason, "No active OpenAI session");
    });
  });

  it("uses the session query parameter to override the global session for websocket connections", async () => {
    class FakeUpstreamSocket extends EventEmitter {
      OPEN = 1;
      readyState = 0;
      sent: string[] = [];

      send(data: string | Buffer): void {
        const text = data.toString();
        this.sent.push(text);
        this.emit("message", Buffer.from(`echo:${text}`), false);
      }

      close(code = 1000, reason = ""): void {
        this.readyState = 3;
        this.emit("close", code, Buffer.from(reason));
      }

      open(): void {
        this.readyState = this.OPEN;
        this.emit("open");
      }
    }

    let fakeUpstream: FakeUpstreamSocket | null = null;

    const proxy = createProxyServer({
      codexBridgeUrl: "ws://unused.test",
      codexBridgeWsFactory: () => {
        fakeUpstream = new FakeUpstreamSocket();
        return fakeUpstream as unknown as WebSocket;
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

      const clientWs = new WebSocket(baseUrl.replace("http", "ws") + "/responses?session=gpt-work");
      await waitForOpen(clientWs);

      clientWs.send("hello-scoped");
      assert.ok(fakeUpstream);
      assert.deepEqual(fakeUpstream.sent, []);

      fakeUpstream.open();

      const reply = await waitForMessage(clientWs);
      assert.equal(reply.data, "echo:hello-scoped");
      assert.deepEqual(fakeUpstream.sent, ["hello-scoped"]);

      clientWs.close();
    });
  });

  it("rejects /responses when the session query parameter points to a missing session", async () => {
    await withServer(async (baseUrl) => {
      const ws = new WebSocket(baseUrl.replace("http", "ws") + "/responses?session=missing");
      await waitForOpen(ws);
      const closed = await waitForClose(ws);
      assert.equal(closed.code, 4004);
      assert.equal(closed.reason, "Session 'missing' not found");
    });
  });

  it("buffers client frames until the upstream websocket opens, then forwards both directions", async () => {
    class FakeUpstreamSocket extends EventEmitter {
      OPEN = 1;
      readyState = 0;
      sent: string[] = [];

      send(data: string | Buffer): void {
        const text = data.toString();
        this.sent.push(text);
        this.emit("message", Buffer.from(`echo:${text}`), false);
      }

      close(code = 1000, reason = ""): void {
        this.readyState = 3;
        this.emit("close", code, Buffer.from(reason));
      }

      open(): void {
        this.readyState = this.OPEN;
        this.emit("open");
      }
    }

    let fakeUpstream: FakeUpstreamSocket | null = null;

    const proxy = createProxyServer({
      codexBridgeUrl: "ws://unused.test",
      codexBridgeWsFactory: () => {
        fakeUpstream = new FakeUpstreamSocket();
        return fakeUpstream as unknown as WebSocket;
      },
    });

    await withCustomServer(proxy, async (baseUrl) => {
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

      const clientWs = new WebSocket(baseUrl.replace("http", "ws") + "/responses");
      await waitForOpen(clientWs);

      clientWs.send("hello-before-upstream-open");
      assert.ok(fakeUpstream);
      assert.deepEqual(fakeUpstream.sent, []);

      fakeUpstream.open();

      const reply = await waitForMessage(clientWs);
      assert.equal(reply.data, "echo:hello-before-upstream-open");
      assert.deepEqual(fakeUpstream.sent, ["hello-before-upstream-open"]);

      clientWs.close();
    });
  });
});
