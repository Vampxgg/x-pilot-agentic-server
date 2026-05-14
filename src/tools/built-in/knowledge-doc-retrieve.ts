import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getKnowledgeEngine } from "../knowledge/engine-singleton.js";

export const knowledgeDocRetrieveTool = tool(
  async ({ datasetId, documentId }) => {
    try {
      const engine = getKnowledgeEngine();
      const docInfo = await engine.retrieveFullDocument(datasetId, documentId);

      if (!docInfo) {
        return JSON.stringify({
          success: false,
          error: "Document not found or contains no segments",
        });
      }

      return JSON.stringify({
        success: true,
        document: {
          documentId: docInfo.documentId,
          documentName: docInfo.documentName,
          sourceType: docInfo.sourceType,
          totalBlocks: docInfo.contentBlocks.length,
          ...(docInfo.videoUrl ? { videoUrl: docInfo.videoUrl } : {}),
          ...(docInfo.duration ? { duration: docInfo.duration } : {}),
          contentBlocks: docInfo.contentBlocks,
          metadata: docInfo.docMetadata,
        },
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  {
    name: "knowledge_doc_retrieve",
    description:
      "Retrieve the full content of a specific document from a knowledge base. " +
      "Returns all segments in position order. " +
      "Use when you need the complete content of a known document, not search results.",
    schema: z.object({
      datasetId: z.string().min(1).describe("The dataset (knowledge base) ID"),
      documentId: z.string().min(1).describe("The document ID within the dataset"),
    }),
  },
);
