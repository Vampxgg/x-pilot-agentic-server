/**
 * Chorus 业务路由：/api/business/scene-dsl-chorus/*
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getTenantId, getUserId } from "../../../src/api/middleware/auth.js";
import { createStreamWriter, type StreamWriterOptions } from "../../../src/core/stream-writer-factory.js";
import { resolvePublicBaseUrl } from "../../../src/utils/public-url.js";
import { logger } from "../../../src/utils/logger.js";
import { getDslFilePath } from "./chorus/publisher.js";

const CHORUS_DIRECTOR = "chorus-director";
const RUNTIME_PREFIX = "/runtime";
const RUNTIME_HTML = "/runtime.html";

interface ChatBody {
  message: string;
  sessionId?: string;
  conversationId?: string;
}

function buildSessionUrls(request: FastifyRequest, sessionId: string): {
  base: string;
  dslUrl: string;
  runtimeUrl: string;
  playUrl: string;
} {
  const base = resolvePublicBaseUrl(request);
  const dslPath = `/api/business/scene-dsl-chorus/sessions/${sessionId}/dsl`;
  const playPath = `/api/business/scene-dsl-chorus/sessions/${sessionId}/play`;
  const dslUrl = `${base}${dslPath}`;
  const runtimeUrl = `${base}${RUNTIME_PREFIX}${RUNTIME_HTML}?dslUrl=${encodeURIComponent(dslPath)}`;
  const playUrl = `${base}${playPath}`;
  return { base, dslUrl, runtimeUrl, playUrl };
}

export async function registerSceneDslChorusRoutes(app: FastifyInstance): Promise<void> {
  // 不在此注册 /runtime/ 静态资源：@fastify/static 可能在 listen 阶段才报重复路由，
  // try/catch 无法兜住，会导致进程 Fatal。请由 interactive-tutorial-v2（或其它单一入口）
  // 挂载 react-code-rander/dist，或将来在 server.ts 统一挂载一次。

  app.post("/api/business/scene-dsl-chorus/chat-stream", async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const body = request.body as ChatBody;

    if (!body?.message) {
      return reply.code(400).send({ error: "message is required" });
    }

    const [{ agentRegistry }, { agentRuntime }, { workspaceManager }] = await Promise.all([
      import("../../../src/core/agent-registry.js"),
      import("../../../src/core/agent-runtime.js"),
      import("../../../src/core/workspace.js"),
    ]);

    const agentDef = agentRegistry.get(CHORUS_DIRECTOR);
    if (!agentDef) {
      return reply.code(503).send({ error: `Agent not found: ${CHORUS_DIRECTOR}` });
    }

    const sessionId = await workspaceManager.create(tenantId, userId, body.sessionId);
    const conversationId = body.conversationId ?? randomUUID();
    const taskId = `task_${randomUUID().slice(0, 8)}`;

    const writerOpts: StreamWriterOptions = {
      taskId,
      sessionId,
      userId,
      query: body.message,
      tenantId,
      hideThinkOutput: agentDef.config.hideThinkOutput,
    };
    const writer = createStreamWriter(reply.raw, writerOpts);

    try {
      const CHORUS_TOOLS = new Set(["start_chorus_pipeline"]);
      let capturedSessionId: string | null = null;
      let capturedTitle: string | null = null;

      for await (const event of agentRuntime.streamAgentV2(CHORUS_DIRECTOR, body.message, {
        threadId: conversationId,
        skipPipeline: true,
        tenantId,
        userId,
        sessionId,
        context: {
          businessType: "scene-dsl-chorus",
          conversationId,
        },
      })) {
        if (!writer.isOpen) break;
        if (event.event === "tool_finished") {
          const data = event.data as Record<string, unknown>;
          if (CHORUS_TOOLS.has(data.tool_name as string)) {
            try {
              const out = typeof data.output === "string" ? JSON.parse(data.output as string) : data.output;
              if (out?.url) {
                capturedSessionId = (out.sessionId as string | undefined) ?? sessionId;
                capturedTitle = out.app?.name ?? out.title ?? null;
              }
            } catch {
              /* ignore */
            }
          }
        }
        if (event.event === "task_finished" && capturedSessionId) {
          const urls = buildSessionUrls(request, capturedSessionId);
          const data = event.data as Record<string, unknown>;
          data.outputs = {
            ...(data.outputs as Record<string, unknown> | undefined),
            sessionId: capturedSessionId,
            dslTitle: capturedTitle,
            dslUrl: urls.dslUrl,
            runtimeUrl: urls.runtimeUrl,
            playUrl: urls.playUrl,
          };
        }
        writer.write(event);
      }
    } catch (err) {
      const sp = await import("../../../src/core/stream-protocol.js");
      const msg = err instanceof Error ? err.message : String(err);
      writer.write(sp.createError(writer.streamContext, "CHAT_ERROR", msg, false));
      writer.write(sp.createTaskFinished(writer.streamContext, { status: "failed", error: msg, elapsedTime: 0 }));
      writer.write(sp.createDone(writer.streamContext));
    } finally {
      writer.end();
    }
  });

  app.get<{ Params: { sessionId: string } }>(
    "/api/business/scene-dsl-chorus/sessions/:sessionId/dsl",
    async (request, reply) => {
      const { sessionId } = request.params;
      const fp = getDslFilePath(sessionId);
      if (!existsSync(fp)) {
        return reply.code(404).send({ error: "dsl not found", sessionId });
      }
      const text = await readFile(fp, "utf-8");
      reply.type("application/json").send(text);
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/api/business/scene-dsl-chorus/sessions/:sessionId/play",
    async (request, reply) => {
      const { sessionId } = request.params;
      const fp = getDslFilePath(sessionId);
      if (!existsSync(fp)) {
        return reply.code(404).send({ error: "dsl not found", sessionId });
      }
      const urls = buildSessionUrls(request, sessionId);
      return reply.redirect(urls.runtimeUrl, 302);
    },
  );
}
