import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FALLBACK_COMMAND = `Switch LLM session via the llm-switcher proxy running on localhost:8411.

If "$ARGUMENTS" is provided, switch to that session:
- Run: \`curl -s -X POST http://localhost:8411/admin/switch/$ARGUMENTS\`
- Confirm the switch result to the user.

If no argument is provided:
1. List available sessions: \`curl -s http://localhost:8411/admin/sessions\`
2. Show them in a table and ask which one to switch to.
3. Once the user picks one, run \`curl -s -X POST http://localhost:8411/admin/switch/<name>\` to switch.
`;

export function getDefaultClaudeCommandsDir(home: string = homedir()): string {
  return join(home, ".claude", "commands");
}

export function getClaudeCommandMarkdown(repoRoot: string = join(__dirname, "..")): string {
  const commandPath = join(repoRoot, ".claude", "commands", "llm-switch.md");
  if (existsSync(commandPath)) {
    return readFileSync(commandPath, "utf-8");
  }
  return FALLBACK_COMMAND;
}

export function installClaudeCommand(targetDir: string, markdown: string = getClaudeCommandMarkdown()): string {
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, "llm-switch.md");
  writeFileSync(targetPath, markdown);
  return targetPath;
}
