import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { RetrievalEngine } from "../knowledge/retrieval-engine.js";
import { getKnowledgeConfig } from "../knowledge/config-helper.js";

let _engine: RetrievalEngine | null = null;

function getEngine(): RetrievalEngine {
  if (!_engine) {
    _engine = new RetrievalEngine(getKnowledgeConfig());
  }
  return _engine;
}

export const knowledgeListTool = tool(
  async ({ keyword }) => {
    try {
      const engine = getEngine();
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
