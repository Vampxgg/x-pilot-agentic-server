import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execFile } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DATA_DIR = resolve(process.cwd(), "data");

function isPathSafe(targetPath: string): boolean {
  const normalized = normalize(resolve(targetPath));
  return normalized.startsWith(DATA_DIR) || normalized.startsWith(tmpdir());
}

export const codeExecutorTool = tool(
  async ({ language, code, timeout, workingDir, env }) => {
    const effectiveTimeout = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const id = randomUUID().slice(0, 8);
    const ext = language === "python" ? "py" : "ts";

    let cwd: string | undefined;
    if (workingDir) {
      const resolvedDir = resolve(workingDir);
      if (!isPathSafe(resolvedDir)) {
        return JSON.stringify({
          success: false,
          error: `workingDir must be within the data directory or temp directory. Got: ${workingDir}`,
        });
      }
      if (!existsSync(resolvedDir)) {
        await mkdir(resolvedDir, { recursive: true });
      }
      cwd = resolvedDir;
    }

    const targetDir = cwd ?? tmpdir();
    const tmpFile = join(targetDir, `xpilot-exec-${id}.${ext}`);

    await writeFile(tmpFile, code, "utf-8");

    try {
      const cmd = language === "python" ? "python3" : "npx";
      const args = language === "python" ? [tmpFile] : ["tsx", tmpFile];

      const childEnv = env ? { ...process.env, ...env } : undefined;

      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(
          cmd,
          args,
          {
            timeout: effectiveTimeout,
            cwd: cwd ?? undefined,
            env: childEnv,
            maxBuffer: 10 * 1024 * 1024,
          },
          (err, stdout, stderr) => {
            if (err) reject(new Error(`${err.message}\nstderr: ${stderr}`));
            else resolve({ stdout, stderr });
          },
        );
      });

      return JSON.stringify({
        success: true,
        stdout: result.stdout.slice(0, 10_000),
        stderr: result.stderr.slice(0, 5_000),
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (!cwd) {
        await unlink(tmpFile).catch(() => {});
      }
    }
  },
  {
    name: "code_executor",
    description:
      "Execute TypeScript or Python code on the server. Returns stdout/stderr. " +
      "Supports custom working directory for persistent environments and extended timeouts up to 600s.",
    schema: z.object({
      language: z.enum(["typescript", "python"]).describe("Programming language"),
      code: z.string().describe("The code to execute"),
      timeout: z.number().optional().describe("Execution timeout in ms (default 30s, max 600s)"),
      workingDir: z.string().optional().describe("Working directory for execution (must be within workspace/data directory)"),
      env: z.record(z.string()).optional().describe("Extra environment variables for the child process"),
    }),
  },
);
