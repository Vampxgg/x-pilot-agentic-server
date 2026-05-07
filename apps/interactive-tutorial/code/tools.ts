import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { reassembleForSession } from "./handlers.js";
import { logger } from "../../../src/utils/logger.js";
import { eventBus, type AgentEvent } from "../../../src/core/event-bus.js";

export function createReassembleAppTool(
  tenantId: string,
  userId: string,
  sessionId: string,
): StructuredToolInterface {
  return tool(
    async () => {
      try {
        const result = await reassembleForSession(tenantId, userId, sessionId) as Record<string, unknown>;
        return JSON.stringify({
          success: true,
          url: result.url,
          title: result.title,
          fileCount: result.fileCount,
          summary: `教材应用已重建成功。\n预览地址: @@TUTORIAL_URL@@`,
          warnings: result.warnings,
        });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          action_hint: "如果从未生成过教材，请调用 start_generation_pipeline；如果已生成但构建失败，请检查组件代码后重试。",
        });
      }
    },
    {
      name: "reassemble_app",
      description:
        "编辑完成后重建教材应用。同步 workspace 中的 App.tsx、components/ 和 pages/ 到构建目录，" +
        "运行 Vite 生产构建，更新 tutorial-meta.json。" +
        "返回更新后的教材预览 URL。在所有文件编辑完成后调用。",
      schema: z.object({}),
    },
  );
}

export function createStartGenerationPipelineTool(
  tenantId: string,
  userId: string,
  sessionId: string,
): StructuredToolInterface {
  return tool(
    async (params) => {
      try {
        const [{ agentRegistry }, { agentRuntime }] = await Promise.all([
          import("../../../src/core/agent-registry.js"),
          import("../../../src/core/agent-runtime.js"),
        ]);

        const directorDef = agentRegistry.get("interactive-tutorial-director");
        if (!directorDef?.config.pipeline) {
          return JSON.stringify({ success: false, error: "Pipeline config not found on director agent" });
        }

        const { PipelineExecutor } = await import("../../../src/core/pipeline-executor.js");
        const executor = new PipelineExecutor(agentRuntime);

        const briefHeader = `【Generation Brief — 由总导演整理】\n${params.brief}`;
        const initialInput = briefHeader;

        const context: Record<string, unknown> = {
          businessType: "interactive-tutorial",
          generationBrief: params.brief,
          topic: params.topic,
        };

        if (params.capabilities?.databaseId) {
          context.databaseId = params.capabilities.databaseId;
        }
        if (params.capabilities?.smartSearch) {
          context.smartSearch = params.capabilities.smartSearch;
        }

        logger.info(`[start_generation_pipeline] topic="${params.topic}" session=${sessionId}`);

        // Task 8 — collect pipeline progress events as a lightweight timeline so the
        // director's response can describe what happened to the user. The same events
        // also stream live through /api/sessions/:sessionId/events for the frontend.
        type TimelineEntry = {
          ts: string;
          stage?: string;
          phase?: string;
          message?: string;
          url?: string;
          durationMs?: number;
          count?: number;
          successCount?: number;
        };
        const timeline: TimelineEntry[] = [];
        let previewUrl: string | null = null;
        let firstPreviewAt: number | null = null;
        const pipelineStart = Date.now();

        const handler = (event: AgentEvent) => {
          if (event.type !== "progress") return;
          const data = (event.data ?? {}) as Record<string, unknown>;
          const entry: TimelineEntry = {
            ts: event.timestamp,
            stage: typeof data.stage === "string" ? data.stage : undefined,
            phase: typeof data.phase === "string" ? data.phase : undefined,
            message: typeof data.message === "string" ? data.message : undefined,
            url: typeof data.url === "string" ? data.url : undefined,
            durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
            count: typeof data.count === "number" ? data.count : undefined,
            successCount: typeof data.successCount === "number" ? data.successCount : undefined,
          };
          timeline.push(entry);
          if (entry.stage === "preview_ready" && entry.url && !previewUrl) {
            previewUrl = entry.url;
            firstPreviewAt = Date.now() - pipelineStart;
            logger.info(`[start_generation_pipeline] preview_ready captured (+${firstPreviewAt}ms): ${previewUrl}`);
          }
          // Cap timeline length defensively
          if (timeline.length > 200) timeline.splice(0, timeline.length - 200);
        };
        eventBus.onSession(sessionId, handler);

        let result;
        try {
          result = await executor.execute(directorDef, initialInput, {
            tenantId,
            userId,
            sessionId,
            context,
          });
        } finally {
          eventBus.offSession(sessionId, handler);
        }

        const assembleOutput = result.steps.assemble;
        const meta = assembleOutput?.result as Record<string, unknown> | undefined;
        const finalUrl = (meta?.url as string | undefined) ?? previewUrl ?? null;

        return JSON.stringify({
          success: result.taskResult.success,
          url: finalUrl,
          title: meta?.title ?? params.topic,
          fileCount: meta?.fileCount ?? 0,
          summary: finalUrl
            ? `教材「${meta?.title ?? params.topic}」已生成，包含 ${meta?.fileCount ?? "若干"} 个互动组件。\n预览地址: @@TUTORIAL_URL@@`
            : "教材生成流程已完成，但未获取到预览地址。",
          warnings: meta?.warnings,
          teachingGuide: meta?.teachingGuide,
          timeline,
          metrics: {
            totalMs: Date.now() - pipelineStart,
            firstPreviewMs: firstPreviewAt,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[start_generation_pipeline] Failed: ${msg}`);
        return JSON.stringify({
          success: false,
          error: msg,
          summary: `教材生成失败: ${msg}`,
        });
      }
    },
    {
      name: "start_generation_pipeline",
      description:
        "当你确认用户需求明确、可以开始生成教材时调用此工具。" +
        "触发完整的生成流程：研究 → 架构设计 → 编码 → 构建。" +
        "brief 参数是核心：必须包含你对用户需求的完整自然语言理解，" +
        "包括主题方向、目标受众、风格偏好、难度要求、特殊约束等所有信息。" +
        "brief 将直接传递给下游 Agent（研究员、架构师、编码器）作为核心工作指引。",
      schema: z.object({
        topic: z.string().describe("教材主题（用于系统标识和日志）"),
        brief: z.string().describe(
          "你对用户需求的完整自然语言描述。包含主题方向、目标受众、" +
          "风格偏好、难度要求、交互期望、特殊约束等所有你理解到的信息。" +
          "这段文字将直接传递给下游 Agent 作为核心工作指引，写得越完整越好。"
        ),
        capabilities: z.object({
          databaseId: z.string().optional().describe("知识库 ID，有值时下游 Researcher 可使用 knowledge_search"),
          smartSearch: z.boolean().optional().describe("是否启用联网搜索，为 true 时下游 Researcher 可使用 web_search"),
        }).optional().describe("系统能力开关，影响下游 Agent 的工具配置"),
      }),
    },
  );
}
