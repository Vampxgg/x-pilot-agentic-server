import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { imageService } from "../../services/image-service.js";
import { extractImagesFromChunk } from "../../services/image-extractor.js";
import { fetchImages } from "../../services/image-fetch-service.js";

// ---------------------------------------------------------------------------
// Factory — creates a session-aware image_library tool
// ---------------------------------------------------------------------------

export function createImageLibraryTool(tenantId: string, userId: string, sessionId?: string): StructuredToolInterface {
  return tool(
    async ({ action, query, tags, context, imageId, sourceUrl, imgKeywords, imgDescription, domain, segmentId, documentId, knowledgeBaseId }) => {
      try {
        switch (action) {
          case "resolve": {
            if (!context) {
              return JSON.stringify({ success: false, error: "context is required for resolve action" });
            }
            const result = await imageService.resolve({
              sectionTitle: context.sectionTitle,
              sectionId: context.sectionId,
              domain: context.domain,
              imageCount: context.imageCount,
              keywords: context.keywords,
            });
            return JSON.stringify({ success: true, ...result });
          }

          case "search": {
            const list = await imageService.list({
              domain,
              tags,
              limit: 20,
            });
            // Filter by query keywords if provided
            const filtered = query
              ? list.filter(m => {
                  const haystack = [
                    ...(m.sourceDetail?.imgKeywords ?? []),
                    ...(m.tags ?? []),
                    m.description ?? "",
                    m.domain ?? "",
                  ].join(" ").toLowerCase();
                  return query.toLowerCase().split(/\s+/).some(kw => haystack.includes(kw));
                })
              : list;
            return JSON.stringify({
              success: true,
              items: filtered.map(m => ({
                imageId: m.id,
                url: imageService.getImageUrl(m),
                source: m.source,
                description: m.description,
                imgKeywords: m.sourceDetail?.imgKeywords,
                tags: m.tags,
                domain: m.domain,
                usageCount: m.usageCount,
              })),
              total: filtered.length,
            });
          }

          case "get": {
            if (!imageId) return JSON.stringify({ success: false, error: "imageId is required for get action" });
            const meta = await imageService.getById(imageId);
            if (!meta) return JSON.stringify({ success: false, error: "Image not found" });
            return JSON.stringify({ success: true, ...meta, url: imageService.getImageUrl(meta) });
          }

          case "save": {
            if (!sourceUrl) return JSON.stringify({ success: false, error: "sourceUrl is required for save action" });

            // Extract structured info from the URL's surrounding chunk content if available
            const keywords = imgKeywords
              ? imgKeywords.split(/[,，、]/).map((s: string) => s.trim()).filter(Boolean)
              : undefined;

            const meta = await imageService.importFromUrl(sourceUrl, {
              tenantId,
              userId,
              sessionId,
              source: "knowledge_recall",
              sourceDetail: {
                originalUrl: sourceUrl,
                imgKeywords: keywords,
                imgDescription,
                segmentId,
                documentId,
                knowledgeBaseId,
              },
              tags: tags ?? [],
              domain,
              description: imgDescription,
              visibility: "shared",
            });

            if (!meta) return JSON.stringify({ success: false, error: "Failed to save image from URL" });
            return JSON.stringify({ success: true, imageId: meta.id, url: imageService.getImageUrl(meta) });
          }

          case "fetch": {
            const kws = context?.keywords ?? (query ? query.split(/\s+/) : []);
            if (!kws.length) {
              return JSON.stringify({ success: false, error: "keywords (via context.keywords or query) required for fetch" });
            }
            const fetchResult = await fetchImages({
              keywords: kws,
              count: context?.imageCount ?? 1,
              domain: context?.domain ?? domain,
              autoGenerate: true,
              enableWebSearch: true,
              imageFilters: context?.imageFilters,
              tenantId,
              userId,
              sessionId,
            });
            return JSON.stringify({ success: true, ...fetchResult });
          }

          default:
            return JSON.stringify({ success: false, error: `Unknown action: ${action}` });
        }
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      name: "image_library",
      description:
        "Search, match and manage images from the global image library. " +
        "Use 'fetch' for one-stop image retrieval: matches library → harvests KB → web search → AI generates missing (returns ready-to-use URLs). " +
        "Use 'resolve' to find the best images for a blueprint section (returns matched images + how many still need AI generation). " +
        "Use 'search' for keyword-based discovery. " +
        "Use 'save' to import a knowledge-base image URL into the library. " +
        "Always call resolve or fetch BEFORE image_generate to avoid redundant AI generation costs.",
      schema: z.object({
        action: z.enum(["fetch", "resolve", "search", "get", "save"]).describe(
          "fetch: one-stop retrieval (library→KB→web→AI) | resolve: match by section context | search: keyword search | get: get by ID | save: import from URL"
        ),
        // For resolve
        context: z.object({
          sectionTitle: z.string().describe("Section title from blueprint"),
          sectionId: z.string().optional().describe("Blueprint component ID"),
          domain: z.string().optional().describe("Knowledge domain, e.g. '电子电工'"),
          imageCount: z.number().int().min(1).describe("How many images are needed"),
          keywords: z.array(z.string()).optional().describe("Additional keywords for matching"),
          imageFilters: z.object({
            size: z.enum(["large", "medium", "icon"]).optional().describe("Image size filter"),
            color: z.enum(["black_and_white", "color", "transparent"]).optional().describe("Image color filter"),
            imageType: z.enum(["clipart", "line_drawing", "gif", "face", "photo"]).optional().describe("Image type filter"),
            aspectRatio: z.enum(["square", "tall", "wide", "panoramic"]).optional().describe("Aspect ratio filter for web image search"),
          }).optional().describe("Filters for web image search (Google Images)"),
        }).optional(),
        // For search
        query: z.string().optional().describe("Keyword query for search action"),
        tags: z.array(z.string()).optional().describe("Tag filter"),
        domain: z.string().optional().describe("Domain filter"),
        // For get
        imageId: z.string().optional().describe("Image ID for get action"),
        // For save
        sourceUrl: z.string().optional().describe("Source URL for save action"),
        imgKeywords: z.string().optional().describe("Comma-separated keywords from knowledge base img_keywords field"),
        imgDescription: z.string().optional().describe("Description from knowledge base img_description field"),
        segmentId: z.string().optional().describe("Source chunk segment ID"),
        documentId: z.string().optional().describe("Source document ID"),
        knowledgeBaseId: z.string().optional().describe("Source knowledge base ID"),
      }),
    },
  );
}

// Backwards-compatible static export for tool registry
export const imageLibraryTool = createImageLibraryTool("default", "default");
