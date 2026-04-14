import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export const fileReadTool = tool(
  async ({ path }) => {
    try {
      if (!existsSync(path)) return JSON.stringify({ error: `File not found: ${path}` });
      const content = await readFile(path, "utf-8");
      return JSON.stringify({ success: true, content: content.slice(0, 50_000) });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  {
    name: "file_read",
    description: "Read the contents of a file at the given path.",
    schema: z.object({
      path: z.string().describe("Absolute or relative file path"),
    }),
  },
);

export const fileWriteTool = tool(
  async ({ path, content }) => {
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      await writeFile(path, content, "utf-8");
      return JSON.stringify({ success: true, path });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  {
    name: "file_write",
    description: "Write content to a file. Creates parent directories if needed.",
    schema: z.object({
      path: z.string().describe("Absolute or relative file path"),
      content: z.string().describe("Content to write"),
    }),
  },
);

export const fileListTool = tool(
  async ({ directory, recursive }) => {
    try {
      if (!existsSync(directory)) return JSON.stringify({ error: `Directory not found: ${directory}` });

      const entries = await readdir(directory, { withFileTypes: true });
      const items = entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
      }));

      return JSON.stringify({ success: true, items });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  {
    name: "file_list",
    description: "List files and directories in a given directory.",
    schema: z.object({
      directory: z.string().describe("Directory path to list"),
      recursive: z.boolean().optional().describe("Whether to list recursively"),
    }),
  },
);
