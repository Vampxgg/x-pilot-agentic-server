import { logger } from "../../utils/logger.js";
import { DifyClient } from "./dify-client.js";
import { KnowledgeBaseManager } from "./kb-manager.js";
import { RagService } from "./rag-service.js";
import { ContentFormatter } from "./content-formatter.js";
import type {
  CleanChunk,
  RetrievalOptions,
  RetrievalResult,
  FormattedChunk,
  RetrievalJob,
  SearchMethod,
  RerankConfig,
  KnowledgeConfig,
  DifyMetadataFilter,
  DocumentInfo,
} from "./types.js";

/**
 * Retrieval orchestrator — ported and upgraded from the original Dify
 * Pipeline's RetrievalOrchestrator.
 *
 * Pipeline: Queries → Analyze → Plan → Parallel Retrieve → RRF → Rerank → Format
 */
export class RetrievalEngine {
  private client: DifyClient;
  private kbManager: KnowledgeBaseManager;
  private rerankConfig: RerankConfig;
  private defaultSearchMethod: SearchMethod;
  private defaultTopK: number;
  private defaultScoreThreshold: number;
  private defaultMaxTokens: number;
  private retrieveConcurrency: number;

  constructor(config: KnowledgeConfig) {
    this.client = new DifyClient({
      baseUrl: config.dify.baseUrl,
      apiKey: config.dify.apiKey,
      timeout: config.retrieval.timeout,
    });
    this.kbManager = new KnowledgeBaseManager(
      this.client,
      config.cache.datasetTTL,
      config.cache.documentTTL,
    );
    this.rerankConfig = config.rerank;
    this.defaultSearchMethod = config.retrieval.defaultSearchMethod;
    this.defaultTopK = config.retrieval.defaultTopK;
    this.defaultScoreThreshold = config.retrieval.scoreThreshold;
    this.defaultMaxTokens = config.retrieval.maxTokens;
    this.retrieveConcurrency = Math.max(
      1,
      parseInt(process.env.KNOWLEDGE_RETRIEVE_CONCURRENCY ?? "6", 10),
    );
  }

  getKbManager(): KnowledgeBaseManager {
    return this.kbManager;
  }

  getClient(): DifyClient {
    return this.client;
  }

  // ---------------------------------------------------------------------------
  // Main entry point — handles both single-query and multi-query (RRF) modes
  // ---------------------------------------------------------------------------

  async retrieve(options: RetrievalOptions): Promise<RetrievalResult> {
    const startTime = Date.now();
    const queries = options.queries.filter((q) => q.trim());
    if (queries.length === 0) {
      return emptyResult(options.queries, startTime);
    }

    const searchMethod = options.searchMethod ?? this.analyzeQuery(queries[0]!);
    const topK = options.topK ?? this.defaultTopK;
    const scoreThreshold = options.scoreThreshold ?? this.defaultScoreThreshold;
    const enableRerank = options.enableRerank ?? this.rerankConfig.enabled;
    const maxTokens = options.maxTokens ?? this.defaultMaxTokens;

    try {
      // Step 1: Resolve target datasets
      const datasetIds = await this.kbManager.resolveDatasetIds({
        ids: options.datasetIds,
        names: options.datasetNames,
      });
      const maxDatasets = parseInt(process.env.KNOWLEDGE_MAX_DATASETS ?? "20", 10);
      const scopedDatasetIds = datasetIds.slice(0, Math.max(1, maxDatasets));
      if (scopedDatasetIds.length < datasetIds.length) {
        logger.warn(
          `RetrievalEngine: limiting datasets from ${datasetIds.length} to ${scopedDatasetIds.length} ` +
          `(set KNOWLEDGE_MAX_DATASETS to adjust)`,
        );
      }

      if (scopedDatasetIds.length === 0) {
        logger.warn("RetrievalEngine: no datasets resolved for query");
        return emptyResult(queries, startTime);
      }

      // Step 2: Build execution plan (merge same-DB requests)
      const jobs = this.buildExecutionPlan(scopedDatasetIds, options.documentFilter);

      // Step 3: Parallel retrieval — (queries × jobs) concurrent requests
      const allResults = await this.executeRetrieval(queries, jobs, searchMethod);
      const useRRF = queries.length > 1;

      // Step 4: RRF fusion (if multi-query)
      let fused: CleanChunk[];
      if (useRRF) {
        const validResults = allResults.filter((r) => r.length > 0);
        fused = RagService.reciprocalRankFusion(validResults);
      } else {
        fused = allResults.flat();
        fused.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        // Deduplicate by chunkId
        const seen = new Set<string>();
        fused = fused.filter((c) => {
          if (seen.has(c.chunkId)) return false;
          seen.add(c.chunkId);
          return true;
        });
      }

      // Step 5: External reranking
      let usedRerank = false;
      if (enableRerank && fused.length > 2) {
        const rerankQuery = queries.join(" ");
        fused = await RagService.computeRerankScores(rerankQuery, fused, this.rerankConfig);
        usedRerank = true;
      }

      // Step 6: Inject document metadata from search results
      this.kbManager.injectMetadataFromChunks(fused);

      // Step 7: Score filtering
      if (scoreThreshold > 0) {
        fused = fused.filter((c) => c.score === null || c.score >= scoreThreshold);
      }

      // Step 8: Top-K slicing
      fused = fused.slice(0, topK);

      // Step 9: Token budget truncation
      fused = truncateByTokenBudget(fused, maxTokens);

      // Step 10: Format output
      const results = this.formatResults(fused);

      return {
        success: true,
        query: queries.length === 1 ? queries[0]! : queries,
        totalResults: results.length,
        results,
        metadata: {
          datasetsSearched: scopedDatasetIds.length,
          searchMethod,
          rerankUsed: usedRerank,
          rrfUsed: useRRF,
          durationMs: Date.now() - startTime,
        },
      };
    } catch (err) {
      logger.error(`RetrievalEngine error: ${err}`);
      return {
        success: false,
        query: queries.length === 1 ? queries[0]! : queries,
        totalResults: 0,
        results: [],
        metadata: {
          datasetsSearched: 0,
          searchMethod,
          rerankUsed: false,
          rrfUsed: false,
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Full document retrieval — ported from process_full_document_task
  // ---------------------------------------------------------------------------

  async retrieveFullDocument(
    datasetId: string,
    documentId: string,
  ): Promise<DocumentInfo | null> {
    try {
      await this.kbManager.prefetchDocumentMeta([{ databaseId: datasetId, documentId }]);
      const allSegments = await this.client.getAllSegments(datasetId, documentId);

      if (allSegments.length === 0) return null;

      const meta = this.kbManager.getDocumentMeta(datasetId, documentId);

      const chunks: CleanChunk[] = allSegments.map((s) => ({
        id: s.id,
        chunkId: s.id,
        content: s.content,
        score: null,
        databaseId: datasetId,
        documentId,
        documentName: meta?.name ?? "",
        position: s.position,
        docMetadata: meta?.docMetadata ?? {},
        keywords: s.keywords ?? [],
      }));

      return ContentFormatter.formatDocument(chunks, meta, "full_doc");
    } catch (err) {
      logger.error(`Full document retrieval failed: ${err}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Query analysis — adaptive search method selection
  // ---------------------------------------------------------------------------

  private analyzeQuery(query: string): SearchMethod {
    const words = query.trim().split(/\s+/);

    if (words.length <= 2) return "keyword_search";

    const hasSpecificTerms = /[A-Z]{2,}|[a-zA-Z]+-\d+|\d{3,}|型号|版本|V\d/.test(query);
    if (hasSpecificTerms) return "full_text_search";

    const conceptualPatterns = /什么是|如何|为什么|怎样|原理|概念|区别|比较|介绍|理解/;
    if (conceptualPatterns.test(query)) return "semantic_search";

    return this.defaultSearchMethod;
  }

  // ---------------------------------------------------------------------------
  // Execution plan — merge same-DB requests, build metadata filters
  // ---------------------------------------------------------------------------

  private buildExecutionPlan(
    datasetIds: string[],
    documentFilter?: string[],
  ): RetrievalJob[] {
    if (!documentFilter?.length) {
      return datasetIds.map((id) => ({ databaseId: id }));
    }

    const filter: DifyMetadataFilter = {
      logical_operator: documentFilter.length > 1 ? "or" : "and",
      conditions: documentFilter.map((name) => ({
        name: "document_name",
        comparison_operator: "is",
        value: name,
      })),
    };

    return datasetIds.map((id) => ({
      databaseId: id,
      metadataFilteringConditions: filter,
    }));
  }

  // ---------------------------------------------------------------------------
  // Parallel retrieval — (queries × jobs) concurrent requests
  // ---------------------------------------------------------------------------

  private async executeRetrieval(
    queries: string[],
    jobs: RetrievalJob[],
    searchMethod: SearchMethod,
  ): Promise<CleanChunk[][]> {
    const taskFactories: Array<() => Promise<CleanChunk[]>> = [];

    for (const query of queries) {
      for (const job of jobs) {
        taskFactories.push(() =>
          this.client.retrieveChunks(job.databaseId, query, {
            searchMethod,
            rerankingEnable: false,
            metadataFilteringConditions: job.metadataFilteringConditions,
          }),
        );
      }
    }

    logger.debug(
      `RetrievalEngine: executing ${taskFactories.length} retrieval tasks ` +
      `(${queries.length} queries × ${jobs.length} jobs, concurrency=${this.retrieveConcurrency})`,
    );

    const results = await this.runLimited(taskFactories, this.retrieveConcurrency);

    return results.map((r) => {
      if (r.status === "fulfilled") return r.value;
      logger.warn(`Retrieval task failed: ${r.reason}`);
      return [];
    });
  }

  private async runLimited<T>(
    factories: Array<() => Promise<T>>,
    concurrency: number,
  ): Promise<Array<PromiseSettledResult<T>>> {
    if (factories.length === 0) return [];
    const results: Array<PromiseSettledResult<T>> = new Array(factories.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= factories.length) return;
        try {
          const value = await factories[idx]!();
          results[idx] = { status: "fulfilled", value };
        } catch (reason) {
          results[idx] = { status: "rejected", reason };
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, factories.length) },
      () => worker(),
    );
    await Promise.all(workers);
    return results;
  }

  // ---------------------------------------------------------------------------
  // Format chunks into final output
  // ---------------------------------------------------------------------------

  private formatResults(chunks: CleanChunk[]): FormattedChunk[] {
    return chunks.map((c) => ({
      content: c.content,
      score: c.score,
      source: {
        datasetId: c.databaseId,
        datasetName: this.kbManager.getDatasetNameById(c.databaseId) ?? c.databaseId,
        documentId: c.documentId,
        documentName: c.documentName,
        segmentId: c.id,
      },
      position: c.position,
      keywords: c.keywords,
      sourceType: "excerpt",
    }));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyResult(queries: string[], startTime: number): RetrievalResult {
  return {
    success: true,
    query: queries.length === 1 ? queries[0]! : queries,
    totalResults: 0,
    results: [],
    metadata: {
      datasetsSearched: 0,
      searchMethod: "hybrid_search",
      rerankUsed: false,
      rrfUsed: false,
      durationMs: Date.now() - startTime,
    },
  };
}

function truncateByTokenBudget(chunks: CleanChunk[], maxTokens: number): CleanChunk[] {
  const AVG_CHARS_PER_TOKEN = 2.5;
  const maxChars = maxTokens * AVG_CHARS_PER_TOKEN;
  let totalChars = 0;
  const result: CleanChunk[] = [];

  for (const chunk of chunks) {
    totalChars += chunk.content.length;
    if (totalChars > maxChars && result.length > 0) break;
    result.push(chunk);
  }

  return result;
}
