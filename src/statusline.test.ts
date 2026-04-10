import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatStatusline,
  isLoopbackProxyUrl,
  parseScopedSessionFromHeaders,
  renderClaudeStatusline,
  resolveClaudeStatuslineContext,
} from "./statusline.js";

function createFetchStub(responses: Record<string, any>) {
  return async (input: string | URL) => {
    const url = input instanceof URL ? input.pathname + input.search : String(input);
    const body = responses[url];
    if (body instanceof Error) throw body;
    if (!body) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const healthyFetch = createFetchStub({
  "/admin/status": {
    active_session: { name: "claude-default", provider: "anthropic" },
  },
  "/admin/sessions?health=true": {
    sessions: {
      "claude-default": {
        model_override: "claude-sonnet-4-5",
        observability: {
          configured_model: "claude-sonnet-4-5",
          last_effective_model: "claude-sonnet-4-5",
        },
        health_state: "healthy",
      },
      "gpt-work": {
        model_override: "gpt-4.1",
        observability: {
          configured_model: "gpt-4.1",
          last_effective_model: "gpt-4.1",
        },
        health_state: "healthy",
      },
      "gpt-review": {
        model_override: "gpt-4.1-mini",
        observability: {
          configured_model: "gpt-4.1-mini",
          last_effective_model: null,
        },
        health_state: "unknown",
      },
    },
  },
});

const fallbackFetch = createFetchStub({
  "/admin/status": {
    active_session: { name: "gpt-default", provider: "openai" },
  },
  "/admin/sessions?health=true": {
    sessions: {
      "gpt-default": {
        model_override: "gpt-4.1",
        observability: {
          configured_model: "gpt-4.1",
          last_effective_model: null,
        },
        health_state: "unhealthy",
      },
    },
  },
});

const offlineFetch = createFetchStub({
  "/admin/status": new Error("offline"),
  "/admin/sessions?health=true": new Error("offline"),
});

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

  it("prefers scoped session over proxy default and includes model plus health", async () => {
    const context = await resolveClaudeStatuslineContext(
      {},
      {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8411",
        ANTHROPIC_CUSTOM_HEADERS: "x-llm-session: gpt-work",
      },
      healthyFetch as typeof fetch,
    );

    assert.equal(context.source, "scoped");
    assert.equal(context.effective_session, "gpt-work");
    assert.equal(context.proxy_default_session, "claude-default");
    assert.equal(context.effective_model, "gpt-4.1");
    assert.equal(context.health_state, "healthy");
  });

  it("falls back to proxy default and uses configured model when last effective model is missing", async () => {
    const context = await resolveClaudeStatuslineContext(
      {},
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:8411" },
      fallbackFetch as typeof fetch,
    );

    assert.equal(context.source, "proxy_default");
    assert.equal(context.effective_session, "gpt-default");
    assert.equal(context.effective_model, "gpt-4.1");
    assert.equal(context.health_state, "unhealthy");
  });

  it("returns unknown when proxy is enabled but admin lookups are unavailable", async () => {
    const context = await resolveClaudeStatuslineContext(
      {},
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:8411" },
      offlineFetch as typeof fetch,
    );

    assert.equal(context.uses_proxy, true);
    assert.equal(context.source, "unknown");
  });
});

describe("formatStatusline", () => {
  it("labels proxy default with model and healthy marker", () => {
    assert.equal(
      formatStatusline(
        {},
        {
          client: "claude",
          uses_proxy: true,
          effective_session: "gpt-work",
          effective_model: "gpt-4.1",
          health_state: "healthy",
          source: "proxy_default",
        },
      ),
      "proxy default: gpt-work · gpt-4.1 · ✓",
    );
  });

  it("omits health suffix when health is unknown", () => {
    assert.equal(
      formatStatusline(
        {},
        {
          client: "claude",
          uses_proxy: true,
          effective_session: "gpt-review",
          effective_model: "gpt-4.1-mini",
          health_state: "unknown",
          source: "scoped",
        },
      ),
      "proxy: gpt-review · gpt-4.1-mini",
    );
  });

  it("renders direct windows as empty text", () => {
    assert.equal(
      formatStatusline(
        { model: { display_name: "Claude Opus" } },
        {
          client: "claude",
          uses_proxy: false,
          source: "direct",
        },
      ),
      "",
    );
  });
});

describe("renderClaudeStatusline", () => {
  it("parses stdin json and returns scoped proxy text plus context", async () => {
    const result = await renderClaudeStatusline(
      JSON.stringify({ model: { display_name: "Claude Opus" } }),
      {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8411",
        ANTHROPIC_CUSTOM_HEADERS: "x-llm-session: gpt-work",
      },
      healthyFetch as typeof fetch,
    );

    assert.equal(result.text, "proxy: gpt-work · gpt-4.1 · ✓");
    assert.equal(result.context.source, "scoped");
    assert.equal(result.context.proxy_default_session, "claude-default");
  });

  it("renders proxy default text with configured model fallback and unhealthy marker", async () => {
    const result = await renderClaudeStatusline(
      JSON.stringify({}),
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:8411" },
      fallbackFetch as typeof fetch,
    );

    assert.equal(result.text, "proxy default: gpt-default · gpt-4.1 · ✗");
    assert.equal(result.context.source, "proxy_default");
  });

  it("renders direct windows as empty text", async () => {
    const result = await renderClaudeStatusline(
      JSON.stringify({ model: { display_name: "Claude Opus" } }),
      {},
      createFetchStub({}) as typeof fetch,
    );

    assert.equal(result.text, "");
    assert.equal(result.context.source, "direct");
  });
});
