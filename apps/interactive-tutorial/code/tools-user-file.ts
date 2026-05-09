import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { fileObjectService } from "../../../src/services/file-object-service.js";
import { getFile, listFiles } from "./uploads/uploads-service.js";
import { toSummary } from "./uploads/types.js";

const READ_DEFAULT = 30_000;
const READ_HARD_CAP = 60_000;

/**
 * Sandboxed file access for the interactive-tutorial researcher.
 * Replaces the generic `file_read` tool — the agent never sees raw paths.
 *   action="list"  → manifest summary (no body content)
 *   action="read"  → lazy text extraction + on-disk cache, with offset/maxChars paging
 */
export function createUserFileTool(
  tenantId: string,
  userId: string,
  sessionId: string,
): StructuredToolInterface {
  return tool(
    async (input) => {
      try {
        if (input.action === "list") {
          const files = await listFiles(tenantId, userId, sessionId);
          return JSON.stringify({ files: files.map(toSummary) });
        }

        if (!input.fileId) {
          return JSON.stringify({ error: "fileId is required when action='read'" });
        }
        const file = await getFile(tenantId, userId, sessionId, input.fileId);
        if (!file) {
          return JSON.stringify({ error: `unknown fileId: ${input.fileId}` });
        }
        if (file.unreadable) {
          return JSON.stringify({
            error: file.unreadableReason ?? "binary asset",
            url: file.url,
            hint: "Reference this file via the URL (e.g. <img src> or <a href>) instead of reading it as text.",
          });
        }

        let text: string;
        try {
          text = await fileObjectService.readText(file);
        } catch (err) {
          return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
            url: file.url,
          });
        }

        const offset = input.offset ?? 0;
        const max = Math.min(input.maxChars ?? READ_DEFAULT, READ_HARD_CAP);
        const slice = text.slice(offset, offset + max);
        return JSON.stringify({
          fileId: file.fileId,
          name: file.name,
          mimeType: file.mimeType,
          url: file.url,
          offset,
          totalChars: text.length,
          content: slice,
          truncated: offset + max < text.length,
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      name: "tutorial_user_file",
      description:
        "读取本次会话内用户上传的参考文件。" +
        "action='list' 列出所有附件元数据；" +
        "action='read' 按 fileId 读取正文（首次自动抽取，后续命中缓存）。" +
        "支持 offset/maxChars 分页，单次最多返回 60000 字符。" +
        "对图片/音视频等二进制资源，返回错误并附 URL，请改用 <img>/<a> 直接引用。",
      schema: z.object({
        action: z.enum(["list", "read"]).describe("'list' 列出附件，'read' 读取单个附件正文"),
        fileId: z.string().optional().describe("action='read' 时必填，对应 manifest 里的 fileId"),
        offset: z.number().int().min(0).optional().describe("从第几个字符开始读，默认 0"),
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(READ_HARD_CAP)
          .optional()
          .describe(`最大返回字符数，默认 ${READ_DEFAULT}，硬上限 ${READ_HARD_CAP}`),
      }),
    },
  );
}
