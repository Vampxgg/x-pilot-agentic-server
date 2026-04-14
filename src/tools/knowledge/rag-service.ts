import { logger } from "../../utils/logger.js";
import type { CleanChunk, RerankConfig } from "./types.js";

/**
 * RAG algorithm core — ported from the original Dify Pipeline's RagService.
 *
 * Two key algorithms:
 * 1. Reciprocal Rank Fusion (RRF) — merges results from multiple queries
 * 2. External Reranker — calls SiliconFlow BGE-reranker for score refinement
 */
export class RagService {
  // ---------------------------------------------------------------------------
  // RRF (Reciprocal Rank Fusion)
  // Ported from original Pipeline: RagService.reciprocal_rank_fusion
  //
  // Input: N ranked lists (one per query)
  // Logic: parallel voting — rank n in each list gets equal weight
  // Output: deduplicated chunks sorted by fused score descending
  // ---------------------------------------------------------------------------

  static reciprocalRankFusion(listOfLists: CleanChunk[][], k = 60): CleanChunk[] {
    const scores = new Map<string, number>();
    const objMap = new Map<string, CleanChunk>();

    for (const rankedList of listOfLists) {
      if (!rankedList?.length) continue;
      for (let rank = 0; rank < rankedList.length; rank++) {
        const item = rankedList[rank]!;
        const cid = item.chunkId;
        if (!cid) continue;

        if (!objMap.has(cid)) objMap.set(cid, item);
        scores.set(cid, (scores.get(cid) ?? 0) + 1.0 / (k + rank));
      }
    }

    const sortedIds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

    return sortedIds
      .map((id) => objMap.get(id))
      .filter((c): c is CleanChunk => c !== undefined);
  }

  // ---------------------------------------------------------------------------
  // External Reranker
  // Ported from original Pipeline: RagService.compute_rerank_scores
  //
  // Calls SiliconFlow API with BAAI/bge-reranker-v2-m3
  // Full-scoring (top_n = len), no truncation at rerank stage
  // Fallback: returns original chunks on failure
  // ---------------------------------------------------------------------------

  static async computeRerankScores(
    query: string,
    chunks: CleanChunk[],
    config: RerankConfig,
  ): Promise<CleanChunk[]> {
    if (!chunks.length) return [];
    if (!config.enabled || !config.apiKey) return chunks;

    const candidates = chunks.slice(0, 100);
    const docContents = candidates.map((c) => c.content);

    const payload = {
      model: config.model,
      query,
      documents: docContents,
      return_documents: false,
      top_n: docContents.length,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeout);

    try {
      const resp = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        logger.warn(`Rerank API returned ${resp.status}: ${text.slice(0, 200)}. Falling back to RRF results.`);
        return chunks;
      }

      const data = (await resp.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
      };

      const results = data.results ?? [];
      const scoredChunks: CleanChunk[] = [];

      for (const item of results) {
        const original = candidates[item.index];
        if (!original) continue;
        scoredChunks.push({
          ...original,
          score: Math.round(item.relevance_score * 10000) / 10000,
        });
      }

      scoredChunks.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return scoredChunks;
    } catch (err) {
      logger.warn(`Rerank failed: ${err}. Falling back to RRF results.`);
      return chunks;
    } finally {
      clearTimeout(timer);
    }
  }
}
