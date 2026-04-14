import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { logger } from "../../utils/logger.js";

function getE2bBaseUrl(): string {
  return (process.env.E2B_BASE_URL ?? "http://35.232.154.66:7780").replace(/\/$/, "");
}

async function e2bFetch(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<{ status: number; data: unknown }> {
  const base = getE2bBaseUrl();
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 30_000);

  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    const contentType = resp.headers.get("content-type") ?? "";
    const data = contentType.includes("json") ? await resp.json() : await resp.text();
    if (resp.status >= 400) {
      logger.warn(`[e2b] ${init?.method ?? "GET"} ${path} → ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
    } else {
      logger.info(`[e2b] ${init?.method ?? "GET"} ${path} → ${resp.status}`);
    }
    return { status: resp.status, data };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[e2b] ${init?.method ?? "GET"} ${path} FAILED: ${msg}`);
    return { status: 0, data: { error: msg } };
  }
}

// ---------------------------------------------------------------------------
// Tool 1: e2b_project_status
// ---------------------------------------------------------------------------

export const e2bProjectStatusTool = tool(
  async ({ projectId }) => {
    const [statusRes, previewRes] = await Promise.all([
      e2bFetch(`/api/projects/${projectId}/status`),
      e2bFetch(`/api/preview-data?projectId=${projectId}`),
    ]);
    return JSON.stringify({
      status: statusRes.data,
      previewData: previewRes.data,
    });
  },
  {
    name: "e2b_project_status",
    description:
      "Get E2B project status and preview data. Returns bundleStatus (pending/building/ready/error), " +
      "manifest (scenes list with durations), bundleUrl, errors if any. " +
      "Use after pushing code to verify it compiled and runs correctly.",
    schema: z.object({
      projectId: z.string().describe("E2B project ID"),
    }),
  },
);

// ---------------------------------------------------------------------------
// Tool 2: e2b_preflight
// ---------------------------------------------------------------------------

export const e2bPreflightTool = tool(
  async ({ projectId }) => {
    const res = await e2bFetch(`/api/projects/${projectId}/preflight-runtime`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeoutMs: 60_000,
    });
    return JSON.stringify(res.data);
  },
  {
    name: "e2b_preflight",
    description:
      "Run a runtime preflight check on an E2B project. Detects compilation errors, " +
      "missing imports, runtime exceptions in TSX code BEFORE rendering. " +
      "Returns error details if any issues found. Use for self-healing: if errors, fix code and re-push.",
    schema: z.object({
      projectId: z.string().describe("E2B project ID to preflight-check"),
    }),
  },
);

// ---------------------------------------------------------------------------
// Tool 3: e2b_manage_assets
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".mp4": "video/mp4", ".webm": "video/webm",
};

async function uploadAssetToE2b(
  projectId: string,
  fileSource: string,
  type: string,
  role: string,
  title?: string,
  description?: string,
  tags?: string[],
): Promise<{ status: number; data: unknown }> {
  let fileBuffer: Buffer;
  let fileName: string;

  if (fileSource.startsWith("http://") || fileSource.startsWith("https://")) {
    const resp = await fetch(fileSource);
    if (!resp.ok) return { status: resp.status, data: { error: `Failed to download: ${resp.statusText}` } };
    fileBuffer = Buffer.from(await resp.arrayBuffer());
    const urlPath = new URL(fileSource).pathname;
    fileName = basename(urlPath) || "asset";
  } else {
    fileBuffer = await readFile(fileSource);
    fileName = basename(fileSource);
  }

  const ext = extname(fileName).toLowerCase();
  const mimeType = MIME_MAP[ext] ?? "application/octet-stream";

  const boundary = `----E2BBoundary${Date.now()}`;
  const parts: Buffer[] = [];

  const addField = (name: string, value: string) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  };

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from("\r\n"));

  addField("type", type);
  addField("role", role);
  if (title) addField("title", title);
  if (description) addField("description", description);
  if (tags?.length) addField("tags", JSON.stringify(tags));

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return e2bFetch(`/api/projects/${projectId}/assets`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
    timeoutMs: 60_000,
  });
}

export const e2bManageAssetsTool = tool(
  async ({ action, projectId, assetId, fileSource, type, role, title, description, tags, limit, offset }) => {
    switch (action) {
      case "upload": {
        if (!fileSource) return JSON.stringify({ error: "fileSource is required for upload" });
        if (!type) return JSON.stringify({ error: "type is required for upload (image|audio|video)" });
        if (!role) return JSON.stringify({ error: "role is required for upload (cover|bgm|sfx|logo|illustration|broll|avatar)" });
        const res = await uploadAssetToE2b(projectId, fileSource, type, role, title, description, tags);
        return JSON.stringify(res.data);
      }
      case "list": {
        const params = new URLSearchParams();
        if (type) params.set("type", type);
        if (role) params.set("role", role);
        if (tags?.length) params.set("tags", tags.join(","));
        if (limit) params.set("limit", String(limit));
        if (offset) params.set("offset", String(offset));
        const qs = params.toString();
        const res = await e2bFetch(`/api/projects/${projectId}/assets${qs ? `?${qs}` : ""}`);
        return JSON.stringify(res.data);
      }
      case "get": {
        if (!assetId) return JSON.stringify({ error: "assetId is required for get" });
        const res = await e2bFetch(`/api/projects/${projectId}/assets/${assetId}`);
        return JSON.stringify(res.data);
      }
      case "delete": {
        if (!assetId) return JSON.stringify({ error: "assetId is required for delete" });
        const res = await e2bFetch(`/api/projects/${projectId}/assets/${assetId}`, { method: "DELETE" });
        return JSON.stringify(res.data);
      }
      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
  {
    name: "e2b_manage_assets",
    description:
      "Manage E2B project assets (images, audio, video). Actions: " +
      "upload (upload a file from local path or URL), list (list project assets with filters), " +
      "get (get single asset detail), delete (remove asset). " +
      "Use upload to push AI-generated images to E2B so they are accessible in the video.",
    schema: z.object({
      action: z.enum(["upload", "list", "get", "delete"]).describe("Action to perform"),
      projectId: z.string().describe("E2B project ID"),
      assetId: z.string().optional().describe("Asset ID (required for get/delete)"),
      fileSource: z.string().optional().describe("Local file path or HTTP URL of the file to upload"),
      type: z.string().optional().describe("Asset type: image | audio | video"),
      role: z.string().optional().describe("Asset role: cover | bgm | sfx | logo | illustration | broll | avatar"),
      title: z.string().optional().describe("Asset title"),
      description: z.string().optional().describe("Asset description"),
      tags: z.array(z.string()).optional().describe("Asset tags"),
      limit: z.number().optional().describe("Pagination limit (for list)"),
      offset: z.number().optional().describe("Pagination offset (for list)"),
    }),
  },
);

// ---------------------------------------------------------------------------
// Tool 4: e2b_render
// ---------------------------------------------------------------------------

export const e2bRenderTool = tool(
  async ({ action, projectId, jobId, compositionId }) => {
    switch (action) {
      case "start": {
        if (!projectId) return JSON.stringify({ error: "projectId is required to start render" });
        const res = await e2bFetch(`/api/projects/${projectId}/renders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ compositionId: compositionId ?? "MainVideo" }),
          timeoutMs: 60_000,
        });
        return JSON.stringify(res.data);
      }
      case "poll": {
        if (!projectId || !jobId) return JSON.stringify({ error: "projectId and jobId are required for poll" });
        const res = await e2bFetch(`/api/projects/${projectId}/renders/${jobId}`);
        return JSON.stringify(res.data);
      }
      case "poll_gpu": {
        if (!jobId) return JSON.stringify({ error: "jobId is required for poll_gpu" });
        const res = await e2bFetch(`/api/gpu/renders/${jobId}`);
        return JSON.stringify(res.data);
      }
      case "queue": {
        const res = await e2bFetch("/api/gpu/queue");
        return JSON.stringify(res.data);
      }
      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
  {
    name: "e2b_render",
    description:
      "Render video on E2B. Actions: " +
      "start (start rendering, returns jobId), " +
      "poll (check render job status by projectId+jobId), " +
      "poll_gpu (check GPU render status by jobId), " +
      "queue (view GPU render queue).",
    schema: z.object({
      action: z.enum(["start", "poll", "poll_gpu", "queue"]).describe("Render action"),
      projectId: z.string().optional().describe("E2B project ID (for start/poll)"),
      jobId: z.string().optional().describe("Render job ID (for poll/poll_gpu)"),
      compositionId: z.string().optional().describe("Remotion composition ID (default: MainVideo)"),
    }),
  },
);

// ---------------------------------------------------------------------------
// Tool 5: e2b_share
// ---------------------------------------------------------------------------

export const e2bShareTool = tool(
  async ({ action, projectId }) => {
    switch (action) {
      case "share": {
        const res = await e2bFetch(`/api/projects/${projectId}/share`, { method: "POST" });
        return JSON.stringify(res.data);
      }
      case "profile": {
        const res = await e2bFetch(`/api/projects/${projectId}/profile`);
        return JSON.stringify(res.data);
      }
      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
  {
    name: "e2b_share",
    description:
      "Get E2B project share link or video profile. Actions: " +
      "share (generate a shareable URL), profile (get video_profile details like resolution, fps, scenes).",
    schema: z.object({
      action: z.enum(["share", "profile"]).describe("Action: share or profile"),
      projectId: z.string().describe("E2B project ID"),
    }),
  },
);

// ---------------------------------------------------------------------------
// Tool 6: e2b_sandbox_exec
// ---------------------------------------------------------------------------

export const e2bSandboxExecTool = tool(
  async ({ sandboxId, cmd, timeoutMs }) => {
    const res = await e2bFetch(`/api/sandboxes/${sandboxId}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd, timeoutMs: timeoutMs ?? 5000 }),
      timeoutMs: (timeoutMs ?? 5000) + 5000,
    });
    return JSON.stringify(res.data);
  },
  {
    name: "e2b_sandbox_exec",
    description:
      "Execute a shell command inside an E2B sandbox. Useful for debugging: " +
      "check running processes (ps aux), inspect files (ls, cat), view logs, etc.",
    schema: z.object({
      sandboxId: z.string().describe("E2B sandbox ID"),
      cmd: z.string().describe("Shell command to execute"),
      timeoutMs: z.number().optional().describe("Command timeout in ms (default 5000)"),
    }),
  },
);

// ---------------------------------------------------------------------------
// Utility — for route-level asset sync (not an agent tool)
// ---------------------------------------------------------------------------

export { uploadAssetToE2b, getE2bBaseUrl };
