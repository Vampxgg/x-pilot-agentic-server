import type { KnowledgeConfig } from "./types.js";

export function getKnowledgeConfig(): KnowledgeConfig {
  return {
    dify: {
      baseUrl: process.env.DIFY_API_BASE_URL ?? "http://119.45.167.133:5125/v1",
      apiKey: process.env.DIFY_DATASET_API_KEY ?? "",
    },
    retrieval: {
      defaultSearchMethod:
        (process.env.KNOWLEDGE_DEFAULT_SEARCH_METHOD as KnowledgeConfig["retrieval"]["defaultSearchMethod"]) ??
        "hybrid_search",
      defaultTopK: parseInt(process.env.KNOWLEDGE_DEFAULT_TOP_K ?? "10", 10),
      scoreThreshold: parseFloat(process.env.KNOWLEDGE_SCORE_THRESHOLD ?? "0"),
      maxTokens: parseInt(process.env.KNOWLEDGE_MAX_TOKENS ?? "8000", 10),
      timeout: parseInt(process.env.KNOWLEDGE_TIMEOUT ?? "45000", 10),
      allowUnscopedSearch: process.env.KNOWLEDGE_ALLOW_UNSCOPED_SEARCH === "true",
      maxDatasets: parseInt(process.env.KNOWLEDGE_MAX_DATASETS ?? "20", 10),
      difyTopKMax: parseInt(process.env.KNOWLEDGE_DIFY_TOP_K_MAX ?? "50", 10),
      fallbackSearchMethod:
        (process.env.KNOWLEDGE_FALLBACK_SEARCH_METHOD as KnowledgeConfig["retrieval"]["fallbackSearchMethod"]) ??
        "keyword_search",
    },
    rerank: {
      enabled: process.env.RERANK_ENABLED !== "false",
      provider: process.env.RERANK_PROVIDER ?? "siliconflow",
      model: process.env.RERANK_MODEL ?? "BAAI/bge-reranker-v2-m3",
      apiKey: process.env.SILICONFLOW_API_KEY ?? "",
      apiUrl: process.env.RERANK_API_URL ?? "https://api.siliconflow.cn/v1/rerank",
      timeout: parseInt(process.env.RERANK_TIMEOUT ?? "30000", 10),
    },
    cache: {
      datasetTTL: parseInt(process.env.KNOWLEDGE_CACHE_DATASET_TTL ?? "300000", 10),
      documentTTL: parseInt(process.env.KNOWLEDGE_CACHE_DOCUMENT_TTL ?? "600000", 10),
    },
  };
}
