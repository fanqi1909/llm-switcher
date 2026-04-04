import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getFallbackModels, shouldUseFallbackModels } from "./models.js";

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

  it("returns GLM fallback models", () => {
    assert.deepEqual(getFallbackModels("glm"), [
      "glm-4.7",
      "glm-4.5-air",
      "glm-4.5-x",
      "glm-z1-air",
    ]);
  });

  it("uses fallback for auth and permission failures", () => {
    assert.equal(shouldUseFallbackModels(401), true);
    assert.equal(shouldUseFallbackModels(403), true);
    assert.equal(shouldUseFallbackModels(500), false);
    assert.equal(shouldUseFallbackModels(null), false);
  });
});
