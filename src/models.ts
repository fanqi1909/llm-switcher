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

export function getFallbackModels(provider: Session["provider"]): string[] {
  return provider === "anthropic" ? ANTHROPIC_FALLBACK_MODELS : OPENAI_FALLBACK_MODELS;
}

export function shouldUseFallbackModels(status: number | null): boolean {
  return status === 401 || status === 403;
}
