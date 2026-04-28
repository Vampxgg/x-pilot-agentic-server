/**
 * Chorus 动态工具 —— start_chorus_pipeline
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { logger } from "../../../src/utils/logger.js";
import { buildChorusPipelineSchemaRef, buildChorusWeaverPack } from "./chorus/prompt-pack.js";

const CHORUS_DIRECTOR = "chorus-director";

export function createStartChorusPipelineTool(
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
        const directorDef = agentRegistry.get(CHORUS_DIRECTOR);
        if (!directorDef?.config.pipeline) {
          return JSON.stringify({ success: false, error: `Pipeline not found on ${CHORUS_DIRECTOR}` });
        }
        const { PipelineExecutor } = await import("../../../src/core/pipeline-executor.js");
        const executor = new PipelineExecutor(agentRuntime);

        const schemaRef = buildChorusPipelineSchemaRef();
        const weaverHint = `\n## ui-weaver 组件手册（摘录）\n${buildChorusWeaverPack(7000)}\n`;

        const initialInput =
          `【Chorus DSL Generation Brief】\n${params.brief}\n\n` +
          `${schemaRef}\n` +
          `${weaverHint}\n`;

        const context: Record<string, unknown> = {
          businessType: "scene-dsl-chorus",
          generationBrief: params.brief,
          topic: params.topic,
        };
        const result = await executor.execute(directorDef, initialInput, {
          tenantId,
          userId,
          sessionId,
          context,
        });
        const publishResult = result.steps?.publish?.result;
        if (publishResult) {
          return JSON.stringify({
            success: true,
            ...(publishResult as Record<string, unknown>),
            summary: `Chorus DSL 已生成。\n预览: @@DSL_RUNTIME_URL@@`,
          });
        }
        return JSON.stringify({ success: true, summary: "Pipeline finished, but no publish output." });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`[chorus start_chorus_pipeline] ${msg}`);
        return JSON.stringify({ success: false, error: msg });
      }
    },
    {
      name: "start_chorus_pipeline",
      description:
        "启动 Chorus 多角色 DSL 生成管线。" +
        "若失败且错误含 actions.* 与 invalid_union：多为 playwright 输出的 action 缺少顶层 type（应为 set_context/navigate/emit/compute_step/compound）。" +
        "含 transitions.*.from：多为漏写 from 字段。",
      schema: z.object({
        brief: z.string().describe("完整需求摘要（中文）"),
        topic: z.string().optional().describe("短主题标签"),
      }),
    },
  );
}
