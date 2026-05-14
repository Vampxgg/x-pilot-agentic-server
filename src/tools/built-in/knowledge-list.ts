import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getKnowledgeEngine } from "../knowledge/engine-singleton.js";

export const knowledgeListTool = tool(
  async ({ keyword }) => {
    try {
      const engine = getKnowledgeEngine();
      const kbManager = engine.getKbManager();
      let datasets = await kbManager.listAvailable();

      if (keyword) {
        const lower = keyword.toLowerCase();
        datasets = datasets.filter(
          (d) =>
            d.name.toLowerCase().includes(lower) ||
            (d.description ?? "").toLowerCase().includes(lower),
        );
      }

      return JSON.stringify({
        success: true,
        total: datasets.length,
        datasets: datasets.map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          documentCount: d.documentCount,
          wordCount: d.wordCount,
          provider: d.provider,
          indexingTechnique: d.indexingTechnique,
          embeddingModel: d.embeddingModel,
          embeddingModelProvider: d.embeddingModelProvider,
          embeddingAvailable: d.embeddingAvailable,
          retrievalModel: d.retrievalModel,
          enableApi: d.enableApi,
          totalAvailableDocuments: d.totalAvailableDocuments,
        })),
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  {
    name: "knowledge_list",
    description:
      "List all available knowledge bases (datasets) from Dify. " +
      "Returns ID, name, description, and document/word counts for each dataset. " +
      "Use this to discover which knowledge bases exist before performing searches.",
    schema: z.object({
      keyword: z
        .string()
        .optional()
        .describe("Optional keyword to filter datasets by name or description"),
    }),
  },
);
