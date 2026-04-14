import type { CleanChunk, CachedDocumentMeta, DocumentInfo, ContentBlock } from "./types.js";

/**
 * Multi-modal content formatter — ported from original Pipeline's ContentFormatter.
 *
 * Dispatches chunk formatting based on doc_metadata.source_type:
 * - text → sorted by score (excerpt) or position (full document)
 * - video → parses frame info (segment URL, timestamps, description)
 * - default → falls back to text
 */
export class ContentFormatter {
  /**
   * Main dispatcher: decides which formatter to use based on metadata.
   * context: 'rag' → excerpt (score-sorted), 'full_doc' → document (position-sorted)
   */
  static formatDocument(
    chunks: CleanChunk[],
    meta: CachedDocumentMeta | undefined,
    context: "rag" | "full_doc",
  ): DocumentInfo | null {
    if (!chunks.length) return null;

    const docMeta = meta?.docMetadata ?? {};
    const inherentType =
      (docMeta.source_type as string | undefined) ??
      (docMeta.doc_type as string | undefined);

    if (inherentType === "video") {
      return this.formatVideoDocument(chunks, meta);
    }

    const finalType = context === "full_doc" ? "document" : "excerpt";
    return this.formatTextDocument(chunks, meta, finalType);
  }

  // ---------------------------------------------------------------------------
  // Text document formatter
  // ---------------------------------------------------------------------------

  private static formatTextDocument(
    chunks: CleanChunk[],
    meta: CachedDocumentMeta | undefined,
    sourceType: "excerpt" | "document",
  ): DocumentInfo {
    const sorted = [...chunks];
    if (sourceType === "excerpt") {
      sorted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    } else {
      sorted.sort((a, b) => a.position - b.position);
    }

    return {
      docMetadata: meta?.docMetadata ?? {},
      documentId: chunks[0]!.documentId,
      documentName: meta?.name ?? chunks[0]!.documentName ?? "Unknown",
      sourceType,
      contentBlocks: sorted.map((c) => ({
        content: c.content,
        position: c.position,
        score: c.score,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Video document formatter — ported from original Pipeline
  // ---------------------------------------------------------------------------

  private static formatVideoDocument(
    chunks: CleanChunk[],
    meta: CachedDocumentMeta | undefined,
  ): DocumentInfo {
    const sorted = [...chunks].sort((a, b) => a.position - b.position);
    const contentBlocks: ContentBlock[] = [];
    let videoInfo: Record<string, unknown> = {};

    for (const chunk of sorted) {
      const raw = parseKeyValueString(chunk.content);

      if (!videoInfo.videoUrl) {
        videoInfo = {
          duration: safeFloat(raw["视频时长"]),
          videoUrl: raw["视频链接"] ?? "",
          videoName: raw["视频名称"] ?? "",
        };
      }

      contentBlocks.push({
        content: chunk.content,
        position: chunk.position,
        score: chunk.score,
        frameId: raw["视频片段ID"],
        frameName: raw["视频片段名称"],
        frameUrl: raw["视频片段分段URL"],
        frameImageUrl: raw["视频片段帧图片URL"],
        startTime: safeFloat(raw["开始时间"]),
        endTime: safeFloat(raw["结束时间"]),
        frameDuration: safeFloat(raw["视频片段时长"]),
        description: raw["视频片段描述"] ?? "",
      });
    }

    const docMeta = meta?.docMetadata ?? {};
    let docName = meta?.name ?? chunks[0]!.documentName ?? (videoInfo.videoName as string) ?? "Unknown";
    const targetExt = docMeta.extension as string | undefined;
    if (targetExt && docName.includes(".")) {
      docName = `${docName.replace(/\.[^.]+$/, "")}.${targetExt}`;
    }

    return {
      docMetadata: docMeta,
      documentId: chunks[0]!.documentId,
      documentName: docName,
      sourceType: "video",
      duration: videoInfo.duration as number | undefined,
      videoUrl: videoInfo.videoUrl as string | undefined,
      contentBlocks,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseKeyValueString(content: string): Record<string, string> {
  const data: Record<string, string> = {};
  if (typeof content !== "string") return data;

  for (const pair of content.split(";")) {
    const idx = pair.indexOf(":");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim().replace(/^"|"$/g, "");
    const val = pair.slice(idx + 1).trim().replace(/^"|"$/g, "");
    data[key] = val;
  }
  return data;
}

function safeFloat(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
