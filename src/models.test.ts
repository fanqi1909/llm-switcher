import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getFallbackModels,
  inferProviderFromModel,
  pickDeterministicSessionName,
  shouldUseFallbackModels,
} from "./models.js";

describe("model inference helpers", () => {
  it("infers Anthropic provider from Claude models", () => {
    assert.equal(inferProviderFromModel("claude-sonnet-4"), "anthropic");
    assert.equal(inferProviderFromModel("claude-3-5-haiku"), "anthropic");
  });

  it("infers OpenAI provider from GPT and o-series models", () => {
    assert.equal(inferProviderFromModel("gpt-5.4"), "openai");
    assert.equal(inferProviderFromModel("gpt-4o"), "openai");
    assert.equal(inferProviderFromModel("o4-mini"), "openai");
  });

  it("returns null for unknown model families", () => {
    assert.equal(inferProviderFromModel("gemini-2.5-pro"), null);
  });

  it("picks the active session when available", () => {
    assert.equal(pickDeterministicSessionName(["b", "a"], "b"), "b");
  });

  it("falls back to lexical order when active session is unavailable", () => {
    assert.equal(pickDeterministicSessionName(["b", "a"], "z"), "a");
    assert.equal(pickDeterministicSessionName([], "z"), null);
  });
});

describe("model fallback helpers", () => {
  it("returns OpenAI fallback models", () => {
    assert.deepEqual(getFallbackModels("openai"), [
      "gpt-5.4",
      "gpt-5",
      "gpt-4.1",
      "gpt-4o",
      "o4-mini",
    ]);
  });

  it("returns Anthropic fallback models", () => {
    assert.deepEqual(getFallbackModels("anthropic"), [
      "claude-opus-4-1",
      "claude-opus-4",
      "claude-sonnet-4-5",
      "claude-sonnet-4",
      "claude-3-7-sonnet",
      "claude-3-5-sonnet",
      "claude-3-5-haiku",
    ]);
  });

  it("uses fallback for auth and permission failures", () => {
    assert.equal(shouldUseFallbackModels(401), true);
    assert.equal(shouldUseFallbackModels(403), true);
    assert.equal(shouldUseFallbackModels(500), false);
    assert.equal(shouldUseFallbackModels(null), false);
  });
});
