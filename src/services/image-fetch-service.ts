import { imageService } from "./image-service.js";
import type { SmartMatchResult, ImageMetadata } from "./image-service.js";
import { generateImageBuffer } from "./image-generator.js";
import { extractImagesFromChunks } from "./image-extractor.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageSearchFilters {
  size?: "large" | "medium" | "icon" | "larger_than_400x300" | "larger_than_640x480" | "larger_than_800x600" | "larger_than_1024x768" | "larger_than_2mp";
  color?: "black_and_white" | "color" | "transparent" | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink" | "white" | "gray" | "black" | "brown";
  imageType?: "clipart" | "line_drawing" | "gif" | "face" | "photo";
  aspectRatio?: "square" | "tall" | "wide" | "panoramic";
}

export interface FetchImagesRequest {
  keywords: string[];
  count: number;
  domain?: string;
  databaseId?: string;
  enableWebSearch?: boolean;
  autoGenerate?: boolean;
  generateStyle?: string;
  imageFilters?: ImageSearchFilters;
  tenantId: string;
  userId: string;
  sessionId?: string;
}

export interface FetchedImage {
  imageId: string;
  url: string;
  source: ImageMetadata["source"];
  matchScore: number;
  keywords: string[];
}

export interface FetchImagesResult {
  images: FetchedImage[];
  fromLibrary: number;
  fromKnowledgeBase: number;
  fromWebSearch: number;
  aiGenerated: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Four-tier pipeline
// ---------------------------------------------------------------------------

export async function fetchImages(req: FetchImagesRequest): Promise<FetchImagesResult> {
  const { keywords, count, domain, tenantId, userId, sessionId } = req;
  const collected: FetchedImage[] = [];
  let fromLibrary = 0;
  let fromKB = 0;
  let fromWeb = 0;
  let aiGenerated = 0;
  let failed = 0;

  const collectedIds = new Set<string>();
  const remaining = () => count - collected.length;

  logger.info(`[image-fetch] Starting fetch: keywords=[${keywords.join(",")}] count=${count}`);

  // --- Step 1: Match from existing library ---
  if (remaining() > 0) {
    const matched = await imageService.smartMatch({
      keywords,
      count: remaining(),
      domain,
    });
    for (const m of matched) {
      collected.push(m);
      collectedIds.add(m.imageId);
    }
    fromLibrary = matched.length;
    logger.info(`[image-fetch] Step 1 (library): matched ${matched.length}`);
  }

  // --- Step 2: Harvest from knowledge base ---
  if (remaining() > 0 && req.databaseId) {
    const kbImages = await harvestFromKnowledgeBase(
      keywords, req.databaseId, remaining(), tenantId, userId, sessionId, domain, collectedIds,
    );
    for (const img of kbImages) {
      collected.push(img);
      collectedIds.add(img.imageId);
    }
    fromKB = kbImages.length;
    logger.info(`[image-fetch] Step 2 (KB harvest): imported ${kbImages.length}`);
  }

  // --- Step 3: Web image search ---
  if (remaining() > 0 && req.enableWebSearch !== false) {
    const webImages = await harvestFromWebSearch(
      keywords, remaining(), tenantId, userId, sessionId, domain, collectedIds, req.imageFilters,
    );
    for (const img of webImages) {
      collected.push(img);
      collectedIds.add(img.imageId);
    }
    fromWeb = webImages.length;
    logger.info(`[image-fetch] Step 3 (web search): imported ${webImages.length}`);
  }

  // --- Step 4: AI generation ---
  if (remaining() > 0 && req.autoGenerate !== false) {
    const gap = remaining();
    const genResults = await generateMissingImages(
      keywords, gap, req.generateStyle, tenantId, userId, sessionId,
    );
    for (const img of genResults.images) {
      collected.push(img);
      collectedIds.add(img.imageId);
    }
    aiGenerated = genResults.images.length;
    failed = genResults.failed;
    logger.info(`[image-fetch] Step 4 (AI generate): created ${aiGenerated}, failed ${failed}`);
  }

  logger.info(
    `[image-fetch] Done: total=${collected.length} (lib=${fromLibrary} kb=${fromKB} web=${fromWeb} ai=${aiGenerated} fail=${failed})`,
  );

  return { images: collected, fromLibrary, fromKnowledgeBase: fromKB, fromWebSearch: fromWeb, aiGenerated, failed };
}

// ---------------------------------------------------------------------------
// Step 2: Knowledge base harvest
// ---------------------------------------------------------------------------

async function harvestFromKnowledgeBase(
  keywords: string[],
  databaseId: string,
  needed: number,
  tenantId: string,
  userId: string,
  sessionId: string | undefined,
  domain: string | undefined,
  excludeIds: Set<string>,
): Promise<FetchedImage[]> {
  try {
    const { knowledgeSearchTool } = await import("../tools/built-in/knowledge-search.js");

    const raw: string = await knowledgeSearchTool.invoke({
      query: keywords.join(" "),
      queries: keywords.length > 1 ? keywords : undefined,
      datasetIds: [databaseId],
      searchMethod: "hybrid_search" as const,
      topK: 8,
      enableRerank: true,
    }) as string;

    const result = JSON.parse(raw) as {
      success: boolean;
      results?: Array<{ content: string; source: { datasetId: string; documentId: string; segmentId: string } }>;
    };

    if (!result.success || !result.results?.length) return [];

    const candidates = extractImagesFromChunks(
      result.results.map(r => ({
        content: r.content,
        source: { segmentId: r.source.segmentId, documentId: r.source.documentId, datasetId: r.source.datasetId },
      })),
    );

    if (!candidates.length) return [];

    const imported: FetchedImage[] = [];
    const importJobs = candidates.slice(0, needed + 3).map(async (c) => {
      const meta = await imageService.importFromUrl(c.url, {
        tenantId,
        userId,
        sessionId,
        source: "knowledge_recall",
        sourceDetail: {
          originalUrl: c.url,
          imgKeywords: c.keywords,
          imgDescription: c.description,
          segmentId: c.segmentId,
          documentId: c.documentId,
          knowledgeBaseId: c.knowledgeBaseId,
        },
        tags: c.keywords ?? [],
        domain,
        description: c.description,
        visibility: "shared",
      });
      return meta;
    });

    const results = await Promise.allSettled(importJobs);
    for (const r of results) {
      if (r.status === "fulfilled" && r.value && !excludeIds.has(r.value.id)) {
        imported.push({
          imageId: r.value.id,
          url: imageService.getAbsoluteImageUrl(r.value),
          source: r.value.source,
          matchScore: 0,
          keywords: r.value.sourceDetail?.imgKeywords ?? [],
        });
        if (imported.length >= needed) break;
      }
    }

    return imported;
  } catch (err) {
    logger.warn(`[image-fetch] KB harvest failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 3: Web image search (via webSearchTool with search_type="image")
// ---------------------------------------------------------------------------

async function harvestFromWebSearch(
  keywords: string[],
  needed: number,
  tenantId: string,
  userId: string,
  sessionId: string | undefined,
  domain: string | undefined,
  excludeIds: Set<string>,
  imageFilters?: ImageSearchFilters,
): Promise<FetchedImage[]> {
  const query = keywords.join(" ");
  const seenUrls = new Set<string>();
  const allImageUrls: string[] = [];

  try {
    const { webSearchTool } = await import("../tools/built-in/web-search.js");
    const raw = await webSearchTool.invoke({
      query,
      search_type: "image",
      num: Math.min(needed + 5, 20),
      timeout: 20_000,
      gl: "cn",
      hl: "zh-cn",
      image_size: imageFilters?.size,
      image_color: imageFilters?.color,
      image_type: imageFilters?.imageType,
      aspect_ratio: imageFilters?.aspectRatio,
    }) as string;

    const result = JSON.parse(raw) as {
      organic_results?: Array<{
        link?: string;
        thumbnail?: string;
      }>;
      error?: string;
    };

    if (result.error) {
      logger.warn(`[image-fetch] Web search returned error: ${result.error}`);
    } else {
      for (const r of result.organic_results ?? []) {
        const url = r.link || r.thumbnail;
        if (url && typeof url === "string" && url.startsWith("http") && !seenUrls.has(url)) {
          seenUrls.add(url);
          allImageUrls.push(url);
        }
      }
    }
  } catch (err) {
    logger.warn(`[image-fetch] Web search tool invocation failed: ${err instanceof Error ? err.message : err}`);
  }

  if (!allImageUrls.length) return [];

  logger.info(`[image-fetch] Web search found ${allImageUrls.length} candidate image URLs`);

  const imported: FetchedImage[] = [];
  const importJobs = allImageUrls.slice(0, needed + 5).map(async (url) => {
    return imageService.importFromUrl(url, {
      tenantId,
      userId,
      sessionId,
      source: "web_import",
      sourceDetail: { originalUrl: url, imgKeywords: keywords },
      tags: keywords,
      domain,
      description: keywords.join(", "),
      visibility: "shared",
    });
  });

  const results = await Promise.allSettled(importJobs);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value && !excludeIds.has(r.value.id)) {
      imported.push({
        imageId: r.value.id,
        url: imageService.getAbsoluteImageUrl(r.value),
        source: r.value.source,
        matchScore: 0,
        keywords,
      });
      if (imported.length >= needed) break;
    }
  }

  return imported;
}

function extractImageUrlsFromContent(content: string): string[] {
  const urls: string[] = [];

  // Markdown images: ![...](url)
  const mdRegex = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdRegex.exec(content)) !== null) {
    if (isImageUrl(match[1])) urls.push(match[1]);
  }

  // HTML img tags: <img src="url"> or <img ... src='url'>
  const imgTagRegex = /<img[^>]+src=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
  while ((match = imgTagRegex.exec(content)) !== null) {
    if (isImageUrl(match[1])) urls.push(match[1]);
  }

  return urls;
}

function isImageUrl(url: string): boolean {
  if (!url.startsWith("http")) return false;
  const lower = url.toLowerCase();
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp)(\?|$)/i.test(lower) ||
    lower.includes("/image") || lower.includes("/photo") || lower.includes("/img");
}

// ---------------------------------------------------------------------------
// Step 4: AI generation
// ---------------------------------------------------------------------------

async function generateMissingImages(
  keywords: string[],
  count: number,
  generateStyle: string | undefined,
  tenantId: string,
  userId: string,
  sessionId: string | undefined,
): Promise<{ images: FetchedImage[]; failed: number }> {
  const images: FetchedImage[] = [];
  let failed = 0;

  const styleSuffix = generateStyle ? `，${generateStyle}` : "，教学配图，清晰专业";

  const jobs = Array.from({ length: count }, (_, i) => {
    const kw = keywords[i % keywords.length] ?? keywords[0];
    const prompt = `${kw}${styleSuffix}`;

    return generateImageBuffer(prompt).then(async (result) => {
      const meta = await imageService.importFromBuffer(result.buffer, {
        tenantId,
        userId,
        sessionId,
        filename: `gen-${Date.now()}-${i}.${result.mimeType.split("/")[1] ?? "jpg"}`,
        mimeType: result.mimeType,
        source: "ai_generated",
        sourceDetail: {
          generationPrompt: prompt,
          generationModel: result.model,
          imgKeywords: keywords,
        },
        tags: keywords,
        description: prompt,
        visibility: "shared",
      });

      return {
        imageId: meta.id,
        url: imageService.getAbsoluteImageUrl(meta),
        source: meta.source as FetchedImage["source"],
        matchScore: 0,
        keywords,
      };
    });
  });

  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === "fulfilled") {
      images.push(r.value);
    } else {
      failed++;
      logger.warn(`[image-fetch] AI generation failed: ${r.reason}`);
    }
  }

  return { images, failed };
}
