/**
 * v2 私有工具 —— 注册到 dynamicToolRegistry，由 dsl-director 在 prompt 里调用。
 *
 * 工具：
 *   - start_dsl_pipeline：触发 v2 完整管线（clarify → research → blueprint → scenes → merge → validate → fix → publish）
 *   - apply_dsl_patch：把 dsl-edit-planner 输出的 patch 应用到当前会话 dsl 并热推
 *   - hot_reload_runtime：触发 SSE 推送一次完整 dsl（如手工编辑后重新渲染）
 *   - spawn_legacy_coder：跨域调起冻结的老 tutorial-component-coder（自定义组件逃生口）
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { logger } from "../../../src/utils/logger.js";
import { applyPatch, type PatchOp } from "./dsl/patch-applier.js";
import { publishDsl, getDslFilePath } from "./dsl/publisher.js";
import { parseDsl } from "./dsl/schema.js";
import { validateDslSemantics } from "./dsl/validator.js";
import { buildSchemaReference } from "./dsl/prompt-injection.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// agent name = 目录名（agent-loader 用 basename(folderPath) 推导）
// 详见 src/core/agent-loader.ts:188
const V2_DIRECTOR = "dsl-director";

// ─────────────────────────────────────────────────────────
// start_dsl_pipeline
// ─────────────────────────────────────────────────────────

export function createStartDslPipelineTool(
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
        const directorDef = agentRegistry.get(V2_DIRECTOR);
        if (!directorDef?.config.pipeline) {
          return JSON.stringify({ success: false, error: `Pipeline not found on ${V2_DIRECTOR}` });
        }
        const { PipelineExecutor } = await import("../../../src/core/pipeline-executor.js");
        const executor = new PipelineExecutor(agentRuntime);

        // 关键：把管线共用 schema 包（分阶段说明 + manifest）拼进 initialInput。
        // 基座对每步复用同一条 initialInput；fan-out 项由 saveDslSkeleton.sceneList[].fanOutContext 补上下文。
        const schemaRef = buildSchemaReference();
        const initialInput =
          `【DSL Generation Brief】\n${params.brief}\n\n` +
          `${schemaRef}\n`;
        const context: Record<string, unknown> = {
          businessType: "interactive-tutorial-v2",
          generationBrief: params.brief,
          topic: params.topic,
        };
        const result = await executor.execute(directorDef, initialInput, {
          tenantId,
          userId,
          sessionId,
          context,
        });
        // 找出 publish 步的输出
        const publishResult = result.steps?.publish?.result;
        if (publishResult) {
          return JSON.stringify({
            success: true,
            ...(publishResult as Record<string, unknown>),
            summary: `DSL 应用已生成。\n预览地址: @@DSL_RUNTIME_URL@@`,
          });
        }
        return JSON.stringify({ success: true, summary: "Pipeline finished, but no publish output." });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`[v2 start_dsl_pipeline] ${msg}`);
        return JSON.stringify({
          success: false,
          error: msg,
          // 给 director 明确的下一步行动提示，避免无脑重试
          next_step_hint:
            "【请勿自动重试】这是工程错误，直接重跑会得到同样结果。" +
            "把错误核心告诉用户（哪一步、为什么），询问是否需要：" +
            "1) 换个表述重新触发；2) 排查 workspace artifacts/；3) 等用户给更多线索。" +
            "如果错误信息明显是 schema/语义校验失败，等 dsl-fixer 自动接管即可，不要重新 start_dsl_pipeline。",
        });
      }
    },
    {
      name: "start_dsl_pipeline",
      description:
        "启动 v2 DSL 应用生成管线（clarify → research → pedagogy → data-pack → visual → blueprint → scenes fan-out → merge → validate → publish）。" +
        "适用于：用户首次提出生成需求、已有 dsl 但用户要求大改重做。" +
        "brief 应包含主题、目标受众、风格偏好、关键交互期望等信息。",
      schema: z.object({
        brief: z.string().describe("交给下游 agent 的完整需求摘要（中文）"),
        topic: z.string().optional().describe("主题简短标签（如『发动机原理』）"),
      }),
    },
  );
}

// ─────────────────────────────────────────────────────────
// apply_dsl_patch
// ─────────────────────────────────────────────────────────

export function createApplyDslPatchTool(
  tenantId: string,
  userId: string,
  sessionId: string,
): StructuredToolInterface {
  return tool(
    async (params) => {
      try {
        const filePath = getDslFilePath(sessionId);
        if (!existsSync(filePath)) {
          return JSON.stringify({ success: false, error: "尚无 dsl，请先 start_dsl_pipeline" });
        }
        const cur = JSON.parse(await readFile(filePath, "utf-8"));
        const next = applyPatch(cur, params.patches as PatchOp[]);
        const schemaResult = parseDsl(next);
        if (!schemaResult.valid) {
          return JSON.stringify({
            success: false,
            error: "patch 应用后 schema 校验失败",
            errors: schemaResult.errors,
          });
        }
        const sem = validateDslSemantics(schemaResult.data!, { semanticRichness: true });
        if (!sem.valid) {
          return JSON.stringify({
            success: false,
            error: "patch 应用后语义校验失败",
            semanticErrors: sem.errors,
          });
        }
        const pub = await publishDsl(sessionId, schemaResult.data!);
        // tenantId/userId 仅在未来需要做权限审计时使用，当前 publish 路径靠 sessionId 隔离
        void tenantId; void userId;
        return JSON.stringify({
          success: true,
          ...pub,
          warnings: sem.warnings,
          summary: `已应用 ${params.patches.length} 个 patch。预览: @@DSL_RUNTIME_URL@@`,
        });
      } catch (e) {
        return JSON.stringify({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    {
      name: "apply_dsl_patch",
      description:
        "把 RFC 6902 JSON Patch 应用到当前会话 dsl，自动 schema+语义校验通过后发布。" +
        "通常先调用 dsl-edit-planner（spawn_sub_agent）让它根据用户对话生成 patch，再用本工具应用。",
      schema: z.object({
        patches: z.array(z.object({
          op: z.enum(["add", "replace", "remove"]),
          path: z.string().describe("RFC 6901 JSON Pointer，如 /scenes/scene_intro/title"),
          value: z.unknown().optional(),
        })).min(1),
      }),
    },
  );
}

// ─────────────────────────────────────────────────────────
// hot_reload_runtime（v3 SSE 推送占位；v2.0 先实现存在性）
// ─────────────────────────────────────────────────────────

export function createHotReloadRuntimeTool(
  _tenantId: string,
  _userId: string,
  sessionId: string,
): StructuredToolInterface {
  return tool(
    async () => {
      // 当前只确认 dsl 存在；SSE 推送通道留给后续阶段
      const fp = getDslFilePath(sessionId);
      const exists = existsSync(fp);
      return JSON.stringify({
        success: exists,
        ...(exists ? { url: `/api/business/interactive-tutorial-v2/sessions/${sessionId}/dsl` } : { error: "dsl 不存在" }),
      });
    },
    {
      name: "hot_reload_runtime",
      description: "触发当前会话 dsl 的热更新（前端 SceneRuntime 重新加载）。",
      schema: z.object({}),
    },
  );
}
