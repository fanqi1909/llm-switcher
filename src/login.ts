import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { which } from "./utils.js";

export async function sniffOAuthToken(timeout = 30000): Promise<string | null> {
  return new Promise((resolve) => {
    let token: string | null = null;
    let resolved = false;

    const done = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      server.close();
      resolve(result);
    };

    // Find free port
    const server = createServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200);
        res.end();
        return;
      }

      // Capture token from POST
      const auth = req.headers["authorization"] || "";
      if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        token = auth.slice(7);
      }

      res.writeHead(529, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "token captured" } }));

      // Give response time to flush, then resolve
      setTimeout(() => done(token), 100);
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      const claudePath = which("claude");
      if (!claudePath) {
        done(null);
        return;
      }

      const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
      delete env.CLAUDECODE;

      const proc = spawn(claudePath, ["-p", "hi", "--output-format", "json", "--max-turns", "1"], {
        env,
        stdio: ["ignore", "ignore", "ignore"],
      });

      proc.on("exit", () => {
        setTimeout(() => done(token), 500);
      });

      // Timeout
      setTimeout(() => {
        proc.kill();
        done(token);
      }, timeout);
    });
  });
}
