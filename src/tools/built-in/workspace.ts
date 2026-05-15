import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { workspaceManager } from "../../core/workspace.js";
import { eventBus } from "../../core/event-bus.js";

const KNOWN_PREFIXES = ["assets/", "artifacts/", "logs/"];

const CODE_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js", ".css", ".html", ".vue", ".svelte"]);

function normalizePath(name: string): string {
  if (KNOWN_PREFIXES.some((p) => name.startsWith(p))) return name;
  return `assets/${name}`;
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function isLogsPath(path: string): boolean {
  return normalizeSlashes(path).startsWith("logs/");
}

function isTraceLogPath(path: string): boolean {
  return /^logs\/trace_.*\.json$/i.test(normalizeSlashes(path));
}

function isCodeFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return CODE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * Some LLMs double-escape newlines in tool call arguments, producing literal
 * two-char sequences like `\n` instead of real newline characters.
 * Detect this (content has no real newlines but contains `\n` literals) and fix.
 */
function normalizeEscapedContent(content: string): string {
  if (content.includes("\n")) return content;
  if (!content.includes("\\n")) return content;
  return content
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r");
}

export function createWorkspaceWriteTool(tenantId: string, userId: string, sessionId: string, agentName: string): StructuredToolInterface {
  return tool(
    async ({ name, content }) => {
      try {
        const targetPath = normalizePath(name);
        const finalContent = isCodeFile(targetPath) ? normalizeEscapedContent(content) : content;

        await workspaceManager.writeArtifact(tenantId, userId, sessionId, targetPath, finalContent);
        eventBus.emitArtifactCreated(agentName, sessionId, targetPath);
        return JSON.stringify({ success: true, path: targetPath, sessionId });
      } catch (err) {
        return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      name: "workspace_write",
      description:
        "Write a file/artifact to the shared workspace. All agents in the same session can read it. " +
        "Use for sharing research docs, scripts, code, images, and any intermediate outputs between agents.",
      schema: z.object({
        name: z.string().describe("File name/path within workspace (e.g., 'research.md', 'scenes/scene-1.tsx')"),
        content: z.string().describe("File content to write"),
      }),
    },
  );
}

export function createWorkspaceReadTool(tenantId: string, userId: string, sessionId: string): StructuredToolInterface {
  return tool(
    async ({ name }) => {
      try {
        const targetPath = normalizePath(name);
        if (isLogsPath(targetPath)) {
          return JSON.stringify({ success: false, error: "Reading logs/ artifacts is not allowed through workspace_read." });
        }

        const content = await workspaceManager.readArtifact(tenantId, userId, sessionId, targetPath);
        if (content === null) {
          return JSON.stringify({ success: false, error: `Artifact not found: ${targetPath}` });
        }
        return JSON.stringify({ success: true, name: targetPath, content: content.slice(0, 50_000) });
      } catch (err) {
        return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      name: "workspace_read",
      description: "Read a file/artifact from the shared workspace written by you or another agent in the same session.",
      schema: z.object({
        name: z.string().describe("File name/path to read from workspace"),
      }),
    },
  );
}

export function createWorkspaceListTool(tenantId: string, userId: string, sessionId: string): StructuredToolInterface {
  return tool(
    async () => {
      try {
        const artifacts = (await workspaceManager.listArtifacts(tenantId, userId, sessionId))
          .filter((artifact) => !isTraceLogPath(artifact.name));
        return JSON.stringify({ success: true, sessionId, artifacts });
      } catch (err) {
        return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      name: "workspace_list",
      description: "List all files/artifacts in the shared workspace for this session.",
      schema: z.object({}),
    },
  );
}
