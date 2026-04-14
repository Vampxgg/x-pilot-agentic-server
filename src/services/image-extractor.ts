/**
 * Knowledge base chunk image extractor.
 *
 * Handles two formats found in real KB data:
 *
 * Format 1 — Structured JSON (most common, Dify post-processing):
 *   { "img_link": "![](http://.../{hash}.jpg)", "img_description": "...", "img_keywords": "kw1, kw2" }
 *
 * Format 2 — Standard Markdown (fallback):
 *   ![alt text](http://.../{hash}.jpg)
 */

export interface ImageCandidate {
  url: string;
  description?: string;
  keywords?: string[];    // img_keywords split into array (Phase 1 resolve core)
  segmentId?: string;     // chunk segmentId (reserved for Phase 3 provenance matching)
  documentId?: string;
  knowledgeBaseId?: string;
}

/**
 * Extract all image candidates from a knowledge base chunk's content string.
 */
export function extractImagesFromChunk(
  content: string,
  opts?: {
    segmentId?: string;
    documentId?: string;
    knowledgeBaseId?: string;
  },
): ImageCandidate[] {
  const images: ImageCandidate[] = [];
  const seenUrls = new Set<string>();

  // Format 1: Structured JSON emitted by Dify's image post-processing pipeline
  // Example: { "img_link": "![](http://host/images/abc.jpg)", "img_description": "...", "img_keywords": "kw1, kw2, kw3" }
  const jsonRegex =
    /\{\s*"img_link"\s*:\s*"!\[.*?\]\((https?:\/\/[^)]+)\)"\s*,\s*"img_description"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"img_keywords"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;

  let match: RegExpExecArray | null;
  while ((match = jsonRegex.exec(content)) !== null) {
    const url = match[1].trim();
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const keywords = match[3]
      .split(/[,，、]/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    images.push({
      url,
      description: match[2].trim() || undefined,
      keywords: keywords.length ? keywords : undefined,
      ...opts,
    });
  }

  // Format 2: Standard Markdown images — used as fallback for simpler KB content
  const mdRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  while ((match = mdRegex.exec(content)) !== null) {
    const url = match[2].trim();
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    images.push({
      url,
      description: match[1].trim() || undefined,
      ...opts,
    });
  }

  return images;
}

/**
 * Extract images from a batch of chunks (e.g. a full materials group).
 * De-duplicates across chunks by URL.
 */
export function extractImagesFromChunks(
  chunks: Array<{
    content: string;
    source?: {
      segmentId?: string;
      documentId?: string;
      datasetId?: string;
    };
  }>,
): ImageCandidate[] {
  const seenUrls = new Set<string>();
  const results: ImageCandidate[] = [];

  for (const chunk of chunks) {
    const candidates = extractImagesFromChunk(chunk.content, {
      segmentId: chunk.source?.segmentId,
      documentId: chunk.source?.documentId,
      knowledgeBaseId: chunk.source?.datasetId,
    });

    for (const candidate of candidates) {
      if (!seenUrls.has(candidate.url)) {
        seenUrls.add(candidate.url);
        results.push(candidate);
      }
    }
  }

  return results;
}
