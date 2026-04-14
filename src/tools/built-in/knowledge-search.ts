import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { RetrievalEngine } from "../knowledge/retrieval-engine.js";
import { getKnowledgeConfig } from "../knowledge/config-helper.js";
import type { RetrievalResult } from "../knowledge/types.js";
import PQueue from "p-queue";

// Global queue to limit concurrent knowledge searches
const knowledgeSearchQueue = new PQueue({ concurrency: 3 });

let _engine: RetrievalEngine | null = null;

function getEngine(): RetrievalEngine {
  if (!_engine) {
    _engine = new RetrievalEngine(getKnowledgeConfig());
  }
  return _engine;
}

export function resetEngine(): void {
  _engine = null;
}

export const knowledgeSearchTool = tool(
  async ({
    query,
    queries,
    datasetIds,
    datasetNames,
    searchMethod,
    topK,
    scoreThreshold,
    enableRerank,
    documentFilter,
  }) => {
    try {
      const engine = getEngine();
      return await knowledgeSearchQueue.add(async () => {
        const queryList = queries?.length ? queries : [query];

        const options = {
          queries: queryList,
          ...(datasetIds?.length ? { datasetIds } : {}),
          ...(datasetNames?.length ? { datasetNames } : {}),
          ...(searchMethod ? { searchMethod } : {}),
          ...(topK ? { topK } : {}),
          ...(scoreThreshold ? { scoreThreshold } : {}),
          ...(enableRerank !== undefined ? { enableRerank } : {}),
          ...(documentFilter?.length ? { documentFilter } : {}),
        };

        const result: RetrievalResult = await engine.retrieve(options);

        return JSON.stringify(result);
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  {
    name: "knowledge_search",
    description:
      "Search knowledge base using Dify retrieval with intelligent fusion. " +
      "Supports single-query or multi-query (RRF fusion) modes. " +
      "Can target specific datasets by ID or name, and apply document-level filters. " +
      "Results include relevance scores, source metadata, and keyword highlights.",
    schema: z.object({
      query: z.string().min(1).describe("Primary search query"),
      queries: z
        .array(z.string())
        .optional()
        .describe(
          "Multiple queries for RRF fusion. When provided, 'query' is ignored. " +
          "Use multiple semantically different queries for better coverage.",
        ),
      datasetIds: z
        .array(z.string())
        .optional()
        .describe("Target specific dataset IDs. If omitted, searches all available datasets."),
      datasetNames: z
        .array(z.string())
        .optional()
        .describe("Target datasets by name (fuzzy match). Alternative to datasetIds."),
      searchMethod: z
        .enum(["hybrid_search", "semantic_search", "full_text_search", "keyword_search"])
        .optional()
        .describe("Search method. Default: auto-selected based on query characteristics."),
      topK: z.number().int().min(1).max(50).optional().describe("Max results to return (default: from config)"),
      scoreThreshold: z.number().min(0).max(1).optional().describe("Minimum relevance score filter"),
      enableRerank: z.boolean().optional().describe("Enable external reranker for score refinement"),
      documentFilter: z
        .array(z.string())
        .optional()
        .describe("Filter results to specific document names within datasets"),
    }),
  },
);
