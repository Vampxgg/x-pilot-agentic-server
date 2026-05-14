import { getKnowledgeConfig } from "./config-helper.js";
import { RetrievalEngine } from "./retrieval-engine.js";

let engine: RetrievalEngine | null = null;

export function getKnowledgeEngine(): RetrievalEngine {
  if (!engine) {
    engine = new RetrievalEngine(getKnowledgeConfig());
  }
  return engine;
}

export function resetKnowledgeEngine(): void {
  engine = null;
}
