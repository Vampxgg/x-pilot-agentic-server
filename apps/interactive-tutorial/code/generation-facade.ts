import { logger } from "../../../src/utils/logger.js";
import { collectSessionTimeline, type TimelineEntry } from "./session-events.js";

export interface StartGenerationParams {
  topic: string;
  brief: string;
  capabilities?: {
    databaseId?: string;
    smartSearch?: boolean;
  };
}

export interface GenerationPipelineResult {
  success: boolean;
  url: string | null;
  title: string;
  fileCount: number;
  summary: string;
  warnings?: unknown;
  teachingGuide?: unknown;
  timeline: TimelineEntry[];
  metrics: { totalMs: number; firstPreviewMs: number | null };
  error?: string;
}

export async function runGenerationPipeline(
  tenantId: string,
  userId: string,
  sessionId: string,
  params: StartGenerationParams,
): Promise<GenerationPipelineResult> {
  const [{ agentRegistry }, { agentRuntime }] = await Promise.all([
    import("../../../src/core/agent-registry.js"),
    import("../../../src/core/agent-runtime.js"),
  ]);

  const directorDef = agentRegistry.get("interactive-tutorial-director");
  if (!directorDef?.config.pipeline) {
    return {
      success: false,
      url: null,
      title: params.topic,
      fileCount: 0,
      summary: "教材生成失败: Pipeline config not found on director agent",
      timeline: [],
      metrics: { totalMs: 0, firstPreviewMs: null },
      error: "Pipeline config not found on director agent",
    };
  }

  const { PipelineExecutor } = await import("../../../src/core/pipeline-executor.js");
  const executor = new PipelineExecutor(agentRuntime);
  const context: Record<string, unknown> = {
    businessType: "interactive-tutorial",
    generationBrief: params.brief,
    topic: params.topic,
  };
  if (params.capabilities?.databaseId) context.databaseId = params.capabilities.databaseId;
  if (params.capabilities?.smartSearch) context.smartSearch = params.capabilities.smartSearch;

  const initialInput = `【Generation Brief — 由总导演整理】\n${params.brief}`;
  const startedAt = Date.now();
  logger.info(`[start_generation_pipeline] topic="${params.topic}" session=${sessionId}`);

  try {
    const { result, timeline, firstPreviewMs, previewUrl } = await collectSessionTimeline(sessionId, () =>
      executor.execute(directorDef, initialInput, {
        tenantId,
        userId,
        sessionId,
        context,
      }),
    );

    const assembleOutput = result.steps.assemble;
    const meta = assembleOutput?.result as Record<string, unknown> | undefined;
    const finalUrl = (meta?.url as string | undefined) ?? previewUrl ?? null;

    return {
      success: result.taskResult.success,
      url: finalUrl,
      title: (meta?.title as string | undefined) ?? params.topic,
      fileCount: (meta?.fileCount as number | undefined) ?? 0,
      summary: finalUrl
        ? `教材「${(meta?.title as string | undefined) ?? params.topic}」已生成，包含 ${(meta?.fileCount as number | undefined) ?? "若干"} 个互动组件。\n预览地址: @@TUTORIAL_URL@@`
        : "教材生成流程已完成，但未获取到预览地址。",
      warnings: meta?.warnings,
      teachingGuide: meta?.teachingGuide,
      timeline,
      metrics: {
        totalMs: Date.now() - startedAt,
        firstPreviewMs,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[start_generation_pipeline] Failed: ${msg}`);
    return {
      success: false,
      url: null,
      title: params.topic,
      fileCount: 0,
      summary: `教材生成失败: ${msg}`,
      timeline: [],
      metrics: { totalMs: Date.now() - startedAt, firstPreviewMs: null },
      error: msg,
    };
  }
}
