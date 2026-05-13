import { existsSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { reassembleForSession } from "./handlers.js";
import { logger } from "../../../src/utils/logger.js";
import { runGenerationPipeline } from "./generation-facade.js";
import { getTutorialPaths, tutorialPublicFileUrl } from "./build/paths.js";

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
        const { distDir } = getTutorialPaths(sessionId);
        const stableUrl = existsSync(join(distDir, "index.html"))
          ? tutorialPublicFileUrl(sessionId)
          : undefined;
        return JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          stableUrl,
          action_hint: stableUrl
            ? "本次重建失败，但上一次成功版本仍可访问；请检查组件代码后重试。"
            : "如果从未生成过教材，请调用 start_generation_pipeline；如果已生成但构建失败，请检查组件代码后重试。",
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
  abortSignal?: AbortSignal,
): StructuredToolInterface {
  return tool(
    async (params) => {
      try {
        if (abortSignal?.aborted) {
          throw new Error("Run cancelled");
        }
        const result = await runGenerationPipeline(tenantId, userId, sessionId, params, { abortSignal });
        return JSON.stringify(result);
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
          userFiles: z.array(z.object({
            fileId: z.string(),
            name: z.string(),
            mimeType: z.string(),
            kind: z.enum(["doc", "image", "audio", "video", "data", "unknown"]),
            byteSize: z.number().optional(),
            url: z.string(),
            textChars: z.number().optional(),
            unreadable: z.boolean().optional(),
          })).optional().describe(
            "用户上传的文件清单。当 Task Context.userFiles 非空时，必须原样透传到此字段；" +
            "下游 Researcher 用 tutorial_user_file 工具按需读取正文，图片等二进制资源由 Coder 通过 url 直接引用。",
          ),
        }).optional().describe("系统能力开关与素材清单，影响下游 Agent 的工具配置和数据访问"),
      }),
    },
  );
}
