import type { Session } from "./config.js";

const OPENAI_FALLBACK_MODELS = [
  "gpt-5.4",
  "gpt-5",
  "gpt-4.1",
  "gpt-4o",
  "o4-mini",
];

const ANTHROPIC_FALLBACK_MODELS = [
  "claude-opus-4-1",
  "claude-opus-4",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-3-7-sonnet",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
];

const GLM_FALLBACK_MODELS = [
  "glm-4.7",
  "glm-4.5-air",
  "glm-4.5-x",
  "glm-z1-air",
];

export function getFallbackModels(provider: Session["provider"]): string[] {
  switch (provider) {
    case "anthropic":
      return ANTHROPIC_FALLBACK_MODELS;
    case "glm":
      return GLM_FALLBACK_MODELS;
    case "openai":
    default:
      return OPENAI_FALLBACK_MODELS;
  }
}

export function shouldUseFallbackModels(status: number | null): boolean {
  return status === 401 || status === 403;
}
