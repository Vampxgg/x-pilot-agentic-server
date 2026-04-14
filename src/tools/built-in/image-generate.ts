import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { imageService } from "../../services/image-service.js";
import { generateAndSaveToWorkspace } from "../../services/image-generator.js";

// ---------------------------------------------------------------------------
// Factory — creates a session-aware image_generate tool
// ---------------------------------------------------------------------------

export function createImageGenerateTool(tenantId: string, userId: string, sessionId?: string): StructuredToolInterface {
  return tool(
    async ({ prompt, timeout }) => {
      try {
        const result = await generateAndSaveToWorkspace(prompt, tenantId, userId, sessionId, {
          timeoutMs: timeout,
        });

        // Auto-import generated image into global image library (non-blocking)
        void imageService.importFromFilePath(result.filePath, {
          tenantId,
          userId,
          sessionId,
          filename: result.fileName,
          source: "ai_generated",
          sourceDetail: {
            generationPrompt: result.prompt,
            generationModel: result.model,
          },
          tags: [],
          visibility: "shared",
        }).catch(() => { /* ignore */ });

        return JSON.stringify({
          success: true,
          imageUrl: result.imageUrl,
          filePath: result.filePath,
          fileName: result.fileName,
          markdownImage: `![${prompt.slice(0, 60)}](${result.imageUrl})`,
        });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      name: "image_generate",
      description:
        "Generate an image via AI (Gemini on OpenRouter or DALL-E compatible API). " +
        "Images are automatically saved to the session workspace. " +
        "Returns a file path and ready-to-use Markdown image tag. " +
        "Use when knowledge base and web searches yield no suitable image for a section.",
      schema: z.object({
        prompt: z.string().min(1).describe("Descriptive prompt for the image, in English preferred for best results"),
        timeout: z.number().int().min(5000).max(180_000).describe("Request timeout in ms (default 90s)"),
      }),
    },
  );
}

// Backwards-compatible static export for tool registry (placeholder only)
export const imageGenerateTool = createImageGenerateTool("default", "default");
