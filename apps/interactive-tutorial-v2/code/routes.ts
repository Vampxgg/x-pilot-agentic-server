/**
 * v2 私有路由（独立前缀 /api/business/interactive-tutorial-v2/*）。
 *
 * 与 v1 路由前缀 /api/business/interactive-tutorial/* 完全不重叠。
 *
 * 端点：
 *   POST /chat-stream                           — 主对话 SSE，调用 dsl-director
 *   GET  /sessions/:sessionId/dsl               — 取当前会话 dsl.json
 *   GET  /sessions/:sessionId/play              — 短链：302 redirect 到 runtime + dslUrl（一键打开）
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getTenantId, getUserId } from "../../../src/api/middleware/auth.js";
import { createStreamWriter, type StreamWriterOptions } from "../../../src/core/stream-writer-factory.js";
import { resolvePublicBaseUrl } from "../../../src/utils/public-url.js";
import { logger } from "../../../src/utils/logger.js";
import { getDslFilePath } from "./dsl/publisher.js";
import { getRuntimeDistPath } from "./runtime-dir.js";

// agent name = 目录名（agent-loader 用 basename(folderPath) 推导）
const V2_DIRECTOR = "dsl-director";

const RUNTIME_PREFIX = "/runtime";
const RUNTIME_HTML = "/runtime.html";

interface ChatBody {
  message: string;
  sessionId?: string;
  conversationId?: string;
}

/**
 * 拼接当前会话的所有公共 URL。
 *
 * 复用 server 现有的 resolvePublicBaseUrl()（自动读 PUBLIC_BASE_URL env，
 * 否则从 X-Forwarded-Host / Host 头推断）。
 *
 * v2 假设 react-code-rander 的 dist 已被 server 同源静态托管在 /runtime/ 前缀
 * （见 code/index.ts 的 fastifyStatic 注册）。这样 runtime 与 dsl 接口同 origin，
 * 不需要 CORS、不需要新 env、配置最简。
 */
function buildSessionUrls(request: FastifyRequest, sessionId: string): {
  base: string;
  dslUrl: string;
  runtimeUrl: string;
  playUrl: string;
} {
  const base = resolvePublicBaseUrl(request);
  const dslPath = `/api/business/interactive-tutorial-v2/sessions/${sessionId}/dsl`;
  const playPath = `/api/business/interactive-tutorial-v2/sessions/${sessionId}/play`;
  const dslUrl = `${base}${dslPath}`;
  // dslUrl 用相对路径足够（runtime 与 server 同源），简洁可读
  const runtimeUrl = `${base}${RUNTIME_PREFIX}${RUNTIME_HTML}?dslUrl=${encodeURIComponent(dslPath)}`;
  const playUrl = `${base}${playPath}`;
  return { base, dslUrl, runtimeUrl, playUrl };
}

export async function registerInteractiveTutorialV2Routes(app: FastifyInstance): Promise<void> {
  // ─── 静态托管 react-code-rander/dist 到 /runtime/ ───
  // 这样所有教程共用一份 runtime bundle，与 server 同源（无需 CORS、无需新 env）。
  // 前提：必须先在 react-code-rander 目录跑 `npm run build` 生成 dist/。
  // 若 dist/ 不存在则跳过注册（保持开发期可用 vite dev server :5174 + CORS 模式）。
  const runtimeDist = getRuntimeDistPath();
  if (existsSync(runtimeDist)) {
    await app.register(fastifyStatic, {
      root: runtimeDist,
      prefix: `${RUNTIME_PREFIX}/`,
      // 必须 false：server 已经为 /api/files/ 注册了一个 fastifyStatic，
      // 默认会装饰 reply 加 sendFile 方法；第二次注册必须 decorateReply: false 避免冲突。
      decorateReply: false,
    });
    logger.info(`[v2 routes] static runtime mounted: ${RUNTIME_PREFIX}/ → ${runtimeDist}`);
  } else {
    logger.warn(
      `[v2 routes] runtime dist not found at ${runtimeDist}; ` +
      `playUrl 将无法工作。请在 react-code-rander 目录执行 \`npm run build\` 后重启 server。`,
    );
  }

  // ─── 主对话流 ───
  app.post("/api/business/interactive-tutorial-v2/chat-stream", async (request, reply) => {
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

    const agentDef = agentRegistry.get(V2_DIRECTOR);
    if (!agentDef) {
      return reply.code(503).send({ error: `Agent not found: ${V2_DIRECTOR}` });
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
      const TUTORIAL_TOOL_NAMES = new Set([
        "start_dsl_pipeline",
        "apply_dsl_patch",
        "hot_reload_runtime",
      ]);
      let capturedTitle: string | null = null;
      let capturedSessionId: string | null = null;

      for await (const event of agentRuntime.streamAgentV2(V2_DIRECTOR, body.message, {
        threadId: conversationId,
        skipPipeline: true,
        tenantId,
        userId,
        sessionId,
        context: {
          businessType: "interactive-tutorial-v2",
          conversationId,
        },
      })) {
        if (!writer.isOpen) break;
        if (event.event === "tool_finished") {
          const data = event.data as Record<string, unknown>;
          if (TUTORIAL_TOOL_NAMES.has(data.tool_name as string)) {
            try {
              const out = typeof data.output === "string" ? JSON.parse(data.output) : data.output;
              if (out?.url) {
                // out.url 形如 "/api/business/.../sessions/{sid}/dsl"
                // 从中抽 sessionId（或者直接用 publish 阶段的 sessionId）
                capturedSessionId = (out.sessionId as string | undefined) ?? sessionId;
                capturedTitle = out.app?.name ?? out.title ?? null;
              }
            } catch { /* ignore */ }
          }
        }
        if (event.event === "task_finished" && capturedSessionId) {
          const urls = buildSessionUrls(request, capturedSessionId);
          const data = event.data as Record<string, unknown>;
          data.outputs = {
            ...(data.outputs as Record<string, unknown> | undefined),
            sessionId: capturedSessionId,
            dslTitle: capturedTitle,
            dslUrl: urls.dslUrl,            // 绝对 URL，可直接 fetch
            runtimeUrl: urls.runtimeUrl,    // 绝对 URL，可直接复制粘贴打开
            playUrl: urls.playUrl,          // 短链 redirect，一键打开（推荐用这个）
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

  // ─── 取当前会话 dsl.json ───
  app.get<{ Params: { sessionId: string } }>(
    "/api/business/interactive-tutorial-v2/sessions/:sessionId/dsl",
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

  // ─── 短链 redirect：一键打开教程 ───
  // GET /api/business/interactive-tutorial-v2/sessions/{sid}/play
  // → 302 → /runtime/runtime.html?dslUrl=/api/business/.../sessions/{sid}/dsl
  app.get<{ Params: { sessionId: string } }>(
    "/api/business/interactive-tutorial-v2/sessions/:sessionId/play",
    async (request, reply) => {
      const { sessionId } = request.params;
      const fp = getDslFilePath(sessionId);
      if (!existsSync(fp)) {
        return reply.code(404).send({ error: "dsl not found", sessionId });
      }
      const urls = buildSessionUrls(request, sessionId);
      // 用 runtimeUrl 但 dslUrl 写相对路径（同源）保持简洁
      return reply.redirect(urls.runtimeUrl, 302);
    },
  );
}
