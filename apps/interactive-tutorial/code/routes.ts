import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getTenantId, getUserId } from "../../../src/api/middleware/auth.js";
import { createStreamWriter, type StreamWriterOptions } from "../../../src/core/stream-writer-factory.js";
import type { ChatRequest, GenerateRequest, EditRequest, RuntimeErrorReport } from "./types.js";

const DIRECTOR_AGENT = "interactive-tutorial-director";

export function registerInteractiveTutorialRoutes(app: FastifyInstance): void {
  // ─── 统一对话端点（SSE 流式） ───
  app.post("/api/business/interactive-tutorial/chat-stream", async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const body = request.body as ChatRequest;

    if (!body.message) {
      return reply.code(400).send({ error: "message is required" });
    }

    const [{ agentRegistry }, { agentRuntime }, { workspaceManager }] = await Promise.all([
      import("../../../src/core/agent-registry.js"),
      import("../../../src/core/agent-runtime.js"),
      import("../../../src/core/workspace.js"),
    ]);

    const agentDef = agentRegistry.get(DIRECTOR_AGENT);
    if (!agentDef) {
      return reply.code(503).send({ error: `Agent not found: ${DIRECTOR_AGENT}` });
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
      const TUTORIAL_TOOL_NAMES = new Set(["start_generation_pipeline", "reassemble_app"]);
      let capturedTutorialUrl: string | null = null;
      let capturedTutorialTitle: string | null = null;

      for await (const event of agentRuntime.streamAgentV2(DIRECTOR_AGENT, body.message, {
        threadId: conversationId,
        skipPipeline: true,
        tenantId,
        userId,
        sessionId,
        context: {
          businessType: "interactive-tutorial",
          conversationId,
          databaseId: body.databaseId,
          smartSearch: body.smartSearch,
        },
      })) {
        if (!writer.isOpen) break;

        if (event.event === "tool_finished") {
          const data = event.data as Record<string, unknown>;
          if (TUTORIAL_TOOL_NAMES.has(data.tool_name as string)) {
            try {
              const output = typeof data.output === "string" ? JSON.parse(data.output) : data.output;
              if (output?.url) {
                capturedTutorialUrl = output.url;
                capturedTutorialTitle = output.title ?? null;
              }
            } catch { /* ignore parse errors */ }
          }
        }

        if (event.event === "task_finished" && capturedTutorialUrl) {
          const taskData = event.data as Record<string, unknown>;
          taskData.outputs = {
            ...(taskData.outputs as Record<string, unknown> | undefined),
            tutorialUrl: capturedTutorialUrl,
            tutorialTitle: capturedTutorialTitle,
          };
        }

        writer.write(event);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const sp = await import("../../../src/core/stream-protocol.js");
      writer.write(sp.createError(writer.streamContext, "CHAT_ERROR", msg, false));
      writer.write(sp.createTaskFinished(writer.streamContext, {
        status: "failed",
        error: msg,
        elapsedTime: 0,
      }));
      writer.write(sp.createDone(writer.streamContext));
    } finally {
      writer.end();
    }
  });

  // ─── [DEPRECATED] 生成教材（SSE 流式） ───
  app.post("/api/business/interactive-tutorial/generate-stream", async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const body = request.body as GenerateRequest;

    if (!body.topic) {
      return reply.code(400).send({ error: "topic is required" });
    }

    const [{ agentRegistry }, { agentRuntime }, { workspaceManager }] = await Promise.all([
      import("../../../src/core/agent-registry.js"),
      import("../../../src/core/agent-runtime.js"),
      import("../../../src/core/workspace.js"),
    ]);

    const agentDef = agentRegistry.get(DIRECTOR_AGENT);
    if (!agentDef) {
      return reply.code(503).send({ error: `Agent not found: ${DIRECTOR_AGENT}` });
    }

    const sessionId = await workspaceManager.create(tenantId, userId, body.sessionId);
    const conversationId = body.conversationId ?? randomUUID();
    const taskId = `task_${randomUUID().slice(0, 8)}`;

    const message = body.userPrompt
      ? `请生成一个关于「${body.topic}」的互动教材。\n补充需求：${body.userPrompt}`
      : `请生成一个关于「${body.topic}」的互动教材。`;

    const writerOpts: StreamWriterOptions = {
      taskId,
      sessionId,
      userId,
      query: message,
      tenantId,
      inputs: { topic: body.topic, userPrompt: body.userPrompt },
      hideThinkOutput: agentDef.config.hideThinkOutput,
    };

    const writer = createStreamWriter(reply.raw, writerOpts);

    try {
      for await (const event of agentRuntime.streamAgentV2(DIRECTOR_AGENT, message, {
        threadId: conversationId,
        skipPipeline: true,
        tenantId,
        userId,
        sessionId,
        context: {
          businessType: "interactive-tutorial",
          conversationId,
          databaseId: body.databaseId,
          smartSearch: body.smartSearch,
        },
      })) {
        if (!writer.isOpen) break;
        writer.write(event);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const sp = await import("../../../src/core/stream-protocol.js");
      writer.write(sp.createError(writer.streamContext, "GENERATION_ERROR", msg, false));
      writer.write(sp.createTaskFinished(writer.streamContext, {
        status: "failed",
        error: msg,
        elapsedTime: 0,
      }));
      writer.write(sp.createDone(writer.streamContext));
    } finally {
      writer.end();
    }
  });

  // ─── [DEPRECATED] 编辑教材（SSE 流式） ───
  app.post("/api/business/interactive-tutorial/edit-stream", async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const body = request.body as EditRequest;

    if (!body.sessionId || !body.editPrompt) {
      return reply.code(400).send({ error: "sessionId and editPrompt are required" });
    }

    const [{ agentRegistry }, { agentRuntime }] = await Promise.all([
      import("../../../src/core/agent-registry.js"),
      import("../../../src/core/agent-runtime.js"),
    ]);

    const agentDef = agentRegistry.get(DIRECTOR_AGENT);
    if (!agentDef) {
      return reply.code(503).send({ error: `Agent not found: ${DIRECTOR_AGENT}` });
    }

    const conversationId = body.conversationId ?? randomUUID();
    const taskId = `task_${randomUUID().slice(0, 8)}`;

    const writerOpts: StreamWriterOptions = {
      taskId,
      sessionId: body.sessionId,
      userId,
      query: body.editPrompt,
      tenantId,
      hideThinkOutput: agentDef.config.hideThinkOutput,
    };

    const writer = createStreamWriter(reply.raw, writerOpts);

    try {
      for await (const event of agentRuntime.streamAgentV2(DIRECTOR_AGENT, body.editPrompt, {
        threadId: conversationId,
        skipPipeline: true,
        tenantId,
        userId,
        sessionId: body.sessionId,
        context: {
          businessType: "interactive-tutorial",
          conversationId,
        },
      })) {
        if (!writer.isOpen) break;
        writer.write(event);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const sp = await import("../../../src/core/stream-protocol.js");
      writer.write(sp.createError(writer.streamContext, "EDIT_ERROR", msg, false));
      writer.write(sp.createTaskFinished(writer.streamContext, {
        status: "failed",
        error: msg,
        elapsedTime: 0,
      }));
      writer.write(sp.createDone(writer.streamContext));
    } finally {
      writer.end();
    }
  });

  // ─── 运行时错误上报与自动修复 ───
  app.post("/api/business/interactive-tutorial/report-runtime-error", async (request, reply) => {
    const body = request.body as RuntimeErrorReport;
    if (!body.sessionId || typeof body.error?.message !== 'string') {
      return reply.code(400).send({ error: "sessionId and error.message are required" });
    }

    const { logger } = await import("../../../src/utils/logger.js");
    logger.info(`[runtime-error] Received error report for session=${body.sessionId}: ${body.error.message}`);

    try {
      const TUTORIALS_DIR = resolve(process.cwd(), "data", "tutorials");
      const tutorialDir = body.sessionId;
      const sourceDir = join(TUTORIALS_DIR, tutorialDir, "source");
      const distDir = join(TUTORIALS_DIR, tutorialDir, "dist");

      if (!existsSync(sourceDir)) {
        return reply.send({ fixed: false, reason: "source directory not found" });
      }

      const componentsDir = join(sourceDir, "src", "components");
      const appFile = join(sourceDir, "src", "App.tsx");

      // Try to locate the failing component from componentStack
      const filesToRepair: string[] = [];
      if (body.error.componentStack) {
        const componentMatches = body.error.componentStack.matchAll(/at\s+([A-Z]\w+)/g);
        const seen = new Set<string>();
        for (const m of componentMatches) {
          const name = m[1]!;
          if (seen.has(name)) continue;
          seen.add(name);
          const candidatePath = join(componentsDir, `${name}.tsx`);
          if (existsSync(candidatePath)) {
            filesToRepair.push(candidatePath);
          }
        }
      }

      // If we couldn't find specific files, include App.tsx and all components
      if (filesToRepair.length === 0) {
        if (existsSync(appFile)) filesToRepair.push(appFile);
        if (existsSync(componentsDir)) {
          const entries = await readdir(componentsDir, { withFileTypes: true });
          for (const e of entries) {
            if (!e.isDirectory() && (e.name.endsWith(".tsx") || e.name.endsWith(".ts"))) {
              filesToRepair.push(join(componentsDir, e.name));
            }
          }
        }
      }

      if (filesToRepair.length === 0) {
        return reply.send({ fixed: false, reason: "no source files found to repair" });
      }

      const { repairFile } = await import("./ai-repair.js");
      const { rmSync } = await import("node:fs");

      let anyFixed = false;
      const errorContext = [
        `Runtime Error: ${body.error.message}`,
        body.error.stack ? `Stack: ${body.error.stack.split("\n").slice(0, 5).join("\n")}` : "",
        body.error.componentStack ? `Component Stack: ${body.error.componentStack}` : "",
      ].filter(Boolean).join("\n\n");

      for (const filePath of filesToRepair) {
        const sourceCode = await readFile(filePath, "utf-8");
        const result = await repairFile({ filePath, sourceCode, errors: errorContext });
        if (result.fixed && result.fixedCode) {
          await writeFile(filePath, result.fixedCode, "utf-8");
          anyFixed = true;
          logger.info(`[runtime-error] AI repaired: ${filePath}`);
        }
      }

      if (!anyFixed) {
        return reply.send({ fixed: false, reason: "AI could not produce a fix" });
      }

      // Rebuild after repair
      const { exec: execCb } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execCb);
      const TEMPLATE_DIR = resolve(process.cwd(), "..", "react-code-rander");

      if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });

      const viteBin = join(TEMPLATE_DIR, "node_modules", ".bin", "vite.cmd");
      const viteCmd = existsSync(viteBin)
        ? `"${viteBin}" build --outDir "${distDir}" --minify false`
        : `npx vite build --outDir "${distDir}" --minify false`;

      try {
        await execAsync(viteCmd, {
          cwd: sourceDir,
          timeout: 120_000,
          env: { ...process.env, NODE_ENV: "production" },
        });
      } catch (buildErr: any) {
        logger.warn(`[runtime-error] Rebuild failed: ${buildErr.message}`);
        return reply.send({ fixed: false, reason: "rebuild failed after repair" });
      }

      if (!existsSync(join(distDir, "index.html"))) {
        return reply.send({ fixed: false, reason: "rebuild did not produce output" });
      }

      const url = `/api/files/tutorials/${tutorialDir}/dist/index.html`;
      logger.info(`[runtime-error] Fix applied and rebuilt: ${url}`);
      return reply.send({ fixed: true, url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[runtime-error] Handler error: ${msg}`);
      return reply.code(500).send({ fixed: false, reason: msg });
    }
  });
}
