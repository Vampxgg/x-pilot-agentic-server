import { afterEach, describe, expect, it, vi } from "vitest";
import { DifyApiError, DifyClient } from "../../src/tools/knowledge/dify-client.js";
import { getKnowledgeEngine, resetKnowledgeEngine } from "../../src/tools/knowledge/index.js";
import { KnowledgeBaseManager } from "../../src/tools/knowledge/kb-manager.js";
import { RetrievalEngine } from "../../src/tools/knowledge/retrieval-engine.js";
import type { CachedDataset, KnowledgeConfig } from "../../src/tools/knowledge/types.js";

function createConfig(overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
  return {
    dify: {
      baseUrl: "https://dify.example/v1",
      apiKey: "test-key",
    },
    retrieval: {
      defaultSearchMethod: "hybrid_search",
      defaultTopK: 10,
      scoreThreshold: 0,
      maxTokens: 8000,
      timeout: 1000,
      allowUnscopedSearch: false,
      maxDatasets: 20,
      difyTopKMax: 50,
      fallbackSearchMethod: "keyword_search",
    },
    rerank: {
      enabled: false,
      provider: "siliconflow",
      model: "BAAI/bge-reranker-v2-m3",
      apiKey: "",
      apiUrl: "https://api.siliconflow.cn/v1/rerank",
      timeout: 1000,
    },
    cache: {
      datasetTTL: 300_000,
      documentTTL: 600_000,
    },
    ...overrides,
  } as KnowledgeConfig;
}

function createDataset(overrides: Partial<CachedDataset> = {}): CachedDataset {
  return {
    id: "dataset-1",
    name: "Dataset 1",
    description: null,
    documentCount: 1,
    wordCount: 100,
    provider: "vendor",
    indexingTechnique: "high_quality",
    embeddingModel: "embedding-model",
    embeddingModelProvider: "siliconflow",
    embeddingAvailable: true,
    retrievalModel: {
      search_method: "hybrid_search",
      reranking_enable: false,
      top_k: 3,
      score_threshold_enabled: false,
      score_threshold: null,
      weights: null,
    },
    enableApi: true,
    totalAvailableDocuments: 1,
    externalRetrievalModel: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Dify knowledge retrieval tools", () => {
  it("shares one knowledge engine instance across built-in tools", () => {
    resetKnowledgeEngine();
    const first = getKnowledgeEngine();
    const second = getKnowledgeEngine();

    expect(second).toBe(first);

    resetKnowledgeEngine();
    expect(getKnowledgeEngine()).not.toBe(first);
  });

  it("requires an explicit knowledge scope by default", async () => {
    const engine = new RetrievalEngine(createConfig());
    const result = await engine.retrieve({ queries: ["智能整车架构"] });

    expect(result.success).toBe(false);
    expect(result.totalResults).toBe(0);
    expect(result.metadata.scopeRequired).toBe(true);
    expect(result.metadata.errorCode).toBe("scope_required");
  });

  it("builds retrieve requests according to Dify retrieval_model semantics", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.query).toHaveLength(250);
      expect(body.retrieval_model).toMatchObject({
        search_method: "hybrid_search",
        reranking_enable: false,
        top_k: 5,
        score_threshold_enabled: true,
        score_threshold: 0.42,
        metadata_filtering_conditions: {
          logical_operator: "and",
          conditions: [
            {
              name: "document_name",
              comparison_operator: "is",
              value: "guide.md",
            },
          ],
        },
      });
      return new Response(JSON.stringify({ query: { content: body.query }, records: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new DifyClient({ baseUrl: "https://dify.example/v1", apiKey: "test-key" });
    await client.retrieveChunks("dataset-1", "x".repeat(300), {
      searchMethod: "hybrid_search",
      topK: 5,
      scoreThreshold: 0.42,
      metadataFilteringConditions: {
        logical_operator: "and",
        conditions: [{ name: "document_name", comparison_operator: "is", value: "guide.md" }],
      },
      retrievalModel: {
        search_method: "semantic_search",
        reranking_enable: false,
        top_k: 3,
        score_threshold_enabled: false,
        score_threshold: null,
        weights: null,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves dataset health fields from Dify list responses", async () => {
    const client = {
      listDatasets: vi.fn(async () => ({
        data: [
          {
            id: "dataset-1",
            name: "Dataset 1",
            description: "demo",
            provider: "vendor",
            permission: "only_me",
            data_source_type: null,
            indexing_technique: "high_quality",
            app_count: 0,
            document_count: 2,
            word_count: 100,
            created_by: "user",
            created_at: 1,
            updated_by: "user",
            updated_at: 1,
            embedding_model: "BAAI/bge-m3",
            embedding_model_provider: "siliconflow",
            embedding_available: false,
            retrieval_model_dict: {
              search_method: "hybrid_search",
              reranking_enable: false,
              top_k: 3,
              score_threshold_enabled: false,
              score_threshold: null,
              weights: null,
            },
            enable_api: true,
            total_available_documents: 2,
            external_retrieval_model: null,
          },
        ],
        has_more: false,
        limit: 100,
        total: 1,
        page: 1,
      })),
    };

    const manager = new KnowledgeBaseManager(client as unknown as DifyClient);
    const datasets = await manager.listAvailable();

    expect(datasets[0]).toMatchObject({
      id: "dataset-1",
      provider: "vendor",
      indexingTechnique: "high_quality",
      embeddingModelProvider: "siliconflow",
      embeddingAvailable: false,
      enableApi: true,
      totalAvailableDocuments: 2,
    });
    expect(datasets[0]?.retrievalModel?.search_method).toBe("hybrid_search");
  });

  it("falls back per dataset when Dify embedding retrieval is forbidden", async () => {
    const engine = new RetrievalEngine(createConfig());
    const dataset = createDataset();

    (engine as unknown as { kbManager: unknown }).kbManager = {
      resolveDatasets: vi.fn(async () => [dataset]),
      getDatasetNameById: vi.fn(() => dataset.name),
      injectMetadataFromChunks: vi.fn(),
    };
    (engine as unknown as { client: unknown }).client = {
      retrieveChunks: vi.fn(async (_datasetId: string, _query: string, options: { searchMethod?: string }) => {
        if (options.searchMethod === "hybrid_search") {
          throw new DifyApiError(
            "Dify API POST /datasets/dataset-1/retrieve returned 400",
            400,
            "{\"message\":\"403 Client Error: Forbidden for url: https://api.siliconflow.cn/v1/embeddings\"}",
            "embedding_forbidden",
          );
        }
        return [
          {
            id: "segment-1",
            chunkId: "segment-1",
            content: "fallback content",
            score: 0.8,
            datasetId: "dataset-1",
            documentId: "doc-1",
            documentName: "doc.md",
            position: 1,
            docMetadata: {},
            keywords: [],
          },
        ];
      }),
    };

    const result = await engine.retrieve({
      queries: ["智能整车架构"],
      datasetIds: ["dataset-1"],
      searchMethod: "hybrid_search",
    });

    expect(result.success).toBe(true);
    expect(result.totalResults).toBe(1);
    expect(result.metadata.fallbackUsed).toBe(true);
    expect(result.metadata.failedDatasets).toEqual([]);
    expect(result.metadata.warnings?.[0]).toContain("fallback");
  });
});
