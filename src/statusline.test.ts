import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatStatusline,
  isLoopbackProxyUrl,
  parseScopedSessionFromHeaders,
  renderClaudeStatusline,
  resolveClaudeStatuslineContext,
} from "./statusline.js";

describe("statusline helpers", () => {
  it("parses x-llm-session from custom headers", () => {
    assert.equal(
      parseScopedSessionFromHeaders("x-llm-session: gpt-work"),
      "gpt-work",
    );
  });

  it("parses x-llm-switch-session as a compatibility alias", () => {
    assert.equal(
      parseScopedSessionFromHeaders("x-llm-switch-session: claude-work"),
      "claude-work",
    );
  });

  it("detects loopback proxy urls", () => {
    assert.equal(isLoopbackProxyUrl("http://127.0.0.1:8411"), true);
    assert.equal(isLoopbackProxyUrl("http://localhost:8411"), true);
    assert.equal(isLoopbackProxyUrl("https://api.anthropic.com"), false);
  });
});

describe("resolveClaudeStatuslineContext", () => {
  it("marks non-proxy windows as direct", async () => {
    const context = await resolveClaudeStatuslineContext(
      { model: { display_name: "Claude Opus" } },
      {},
    );

    assert.deepEqual(context, {
      client: "claude",
      uses_proxy: false,
      source: "direct",
    });
  });

  it("prefers scoped session over proxy default", async () => {
    const context = await resolveClaudeStatuslineContext(
      {},
      {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8411",
        ANTHROPIC_CUSTOM_HEADERS: "x-llm-session: gpt-work",
      },
      async () =>
        new Response(JSON.stringify({
          active_session: { name: "claude-default", provider: "anthropic" },
        }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    assert.equal(context.source, "scoped");
    assert.equal(context.effective_session, "gpt-work");
    assert.equal(context.proxy_default_session, "claude-default");
  });

  it("falls back to proxy default when no scoped session is set", async () => {
    const context = await resolveClaudeStatuslineContext(
      {},
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:8411" },
      async () =>
        new Response(JSON.stringify({
          active_session: { name: "gpt-default", provider: "openai" },
        }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    assert.equal(context.source, "proxy_default");
    assert.equal(context.effective_session, "gpt-default");
  });

  it("returns unknown when proxy is enabled but admin status is unavailable", async () => {
    const context = await resolveClaudeStatuslineContext(
      {},
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:8411" },
      async () => {
        throw new Error("offline");
      },
    );

    assert.equal(context.uses_proxy, true);
    assert.equal(context.source, "unknown");
  });
});

describe("formatStatusline", () => {
  it("labels proxy default explicitly", () => {
    assert.equal(
      formatStatusline(
        { model: { display_name: "Claude Opus" } },
        {
          client: "claude",
          uses_proxy: true,
          effective_session: "gpt-work",
          source: "proxy_default",
        },
      ),
      "proxy default: gpt-work",
    );
  });

  it("renders direct windows distinctly", () => {
    assert.equal(
      formatStatusline(
        { model: { display_name: "Claude Opus" } },
        {
          client: "claude",
          uses_proxy: false,
          source: "direct",
        },
      ),
      "direct: Claude Opus",
    );
  });
});

describe("renderClaudeStatusline", () => {
  it("parses stdin json and returns text plus context", async () => {
    const result = await renderClaudeStatusline(
      JSON.stringify({ model: { display_name: "Claude Opus" } }),
      {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8411",
        ANTHROPIC_CUSTOM_HEADERS: "x-llm-session: gpt-review",
      },
      async () =>
        new Response(JSON.stringify({
          active_session: { name: "claude-default", provider: "anthropic" },
        }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    assert.equal(result.text, "proxy: gpt-review");
    assert.equal(result.context.source, "scoped");
    assert.equal(result.context.proxy_default_session, "claude-default");
  });
});
