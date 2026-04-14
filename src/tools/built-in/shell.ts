import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "node:child_process";

export const shellTool = tool(
  async ({ command, cwd, timeout }) => {
    try {
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        exec(command, { cwd, timeout: timeout ?? 30_000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(`${err.message}\nstderr: ${stderr}`));
          else resolve({ stdout, stderr });
        });
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
    }
  },
  {
    name: "shell",
    description: "Execute a shell command on the server. Returns stdout/stderr.",
    schema: z.object({
      command: z.string().describe("The shell command to execute"),
      cwd: z.string().optional().describe("Working directory for the command"),
      timeout: z.number().optional().describe("Execution timeout in ms (default 30s)"),
    }),
  },
);
