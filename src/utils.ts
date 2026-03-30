// LLM
// Switcher utils
import { execSync } from "node:child_process";

export function which(cmd: string): string | null {
  try {
    return execSync(`which ${cmd}`, { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}
