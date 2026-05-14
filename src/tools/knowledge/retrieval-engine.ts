import { logger } from "../../utils/logger.js";
import { DifyApiError, DifyClient } from "./dify-client.js";
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
  FailedDataset,
  CachedDataset,
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
  private allowUnscopedSearch: boolean;
  private maxDatasets: number;
  private difyTopKMax: number;
  private fallbackSearchMethod: SearchMethod;

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
    this.allowUnscopedSearch = config.retrieval.allowUnscopedSearch;
    this.maxDatasets = Math.max(1, config.retrieval.maxDatasets);
    this.difyTopKMax = Math.max(1, config.retrieval.difyTopKMax);
    this.fallbackSearchMethod = config.retrieval.fallbackSearchMethod;
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
      const hasExplicitScope = Boolean(options.datasetIds?.length || options.datasetNames?.length);
      if (!hasExplicitScope && !this.allowUnscopedSearch) {
        return scopeRequiredResult(queries, searchMethod, startTime);
      }

      // Step 1: Resolve target datasets
      const datasets = await this.kbManager.resolveDatasets({
        ids: options.datasetIds,
        names: options.datasetNames,
      });
      const scopedDatasets = this.filterRetrievableDatasets(datasets, searchMethod);
      const limitedDatasets = scopedDatasets.slice(0, this.maxDatasets);
      if (limitedDatasets.length < scopedDatasets.length) {
        logger.warn(
          `RetrievalEngine: limiting datasets from ${scopedDatasets.length} to ${limitedDatasets.length} ` +
          `(set KNOWLEDGE_MAX_DATASETS to adjust)`,
        );
      }

      if (limitedDatasets.length === 0) {
        logger.warn("RetrievalEngine: no datasets resolved for query");
        return emptyResult(queries, startTime);
      }

      // Step 2: Build execution plan (merge same-DB requests)
      const jobs = this.buildExecutionPlan(limitedDatasets, options.documentFilter);

      // Step 3: Parallel retrieval — (queries × jobs) concurrent requests
      const retrieval = await this.executeRetrieval(queries, jobs, searchMethod, scoreThreshold, topK);
      const allResults = retrieval.results;
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
      if (results.length === 0 && retrieval.failedDatasets.length > 0) {
        return {
          success: false,
          query: queries.length === 1 ? queries[0]! : queries,
          totalResults: 0,
          results: [],
          metadata: {
            datasetsSearched: limitedDatasets.length,
            searchMethod,
            rerankUsed: false,
            rrfUsed: useRRF,
            durationMs: Date.now() - startTime,
            failedDatasets: retrieval.failedDatasets,
            warnings: summarizeFailures(retrieval.failedDatasets),
            fallbackUsed: retrieval.fallbackUsed,
            errorCode: retrieval.failedDatasets[0]?.errorCode ?? "unknown",
          },
        };
      }

      return {
        success: true,
        query: queries.length === 1 ? queries[0]! : queries,
        totalResults: results.length,
        results,
        metadata: {
          datasetsSearched: limitedDatasets.length,
          searchMethod,
          rerankUsed: usedRerank,
          rrfUsed: useRRF,
          durationMs: Date.now() - startTime,
          failedDatasets: retrieval.failedDatasets,
          warnings: [
            ...(retrieval.fallbackUsed ? [`fallback used for ${retrieval.fallbackCount} retrieval task(s)`] : []),
            ...summarizeFailures(retrieval.failedDatasets),
          ],
          fallbackUsed: retrieval.fallbackUsed,
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
      await this.kbManager.prefetchDocumentMeta([{ datasetId, documentId }]);
      const allSegments = await this.client.getAllSegments(datasetId, documentId);

      if (allSegments.length === 0) return null;

      const meta = this.kbManager.getDocumentMeta(datasetId, documentId);

      const chunks: CleanChunk[] = allSegments.map((s) => ({
        id: s.id,
        chunkId: s.id,
        content: s.content,
        score: null,
        datasetId,
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
    datasets: CachedDataset[],
    documentFilter?: string[],
  ): RetrievalJob[] {
    if (!documentFilter?.length) {
      return datasets.map((dataset) => ({ datasetId: dataset.id, dataset }));
    }

    const filter: DifyMetadataFilter = {
      logical_operator: documentFilter.length > 1 ? "or" : "and",
      conditions: documentFilter.map((name) => ({
        name: "document_name",
        comparison_operator: "is",
        value: name,
      })),
    };

    return datasets.map((dataset) => ({
      datasetId: dataset.id,
      dataset,
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
    scoreThreshold: number,
    topK: number,
  ): Promise<{ results: CleanChunk[][]; failedDatasets: FailedDataset[]; fallbackUsed: boolean; fallbackCount: number }> {
    const taskFactories: Array<() => Promise<{ chunks: CleanChunk[]; fallbackUsed: boolean }>> = [];

    for (const query of queries) {
      for (const job of jobs) {
        taskFactories.push(() =>
          this.retrieveWithFallback(job, query, searchMethod, scoreThreshold, topK),
        );
      }
    }

    logger.debug(
      `RetrievalEngine: executing ${taskFactories.length} retrieval tasks ` +
      `(${queries.length} queries × ${jobs.length} jobs, concurrency=${this.retrieveConcurrency})`,
    );

    const results = await this.runLimited(taskFactories, this.retrieveConcurrency);
    const failedDatasets: FailedDataset[] = [];
    let fallbackCount = 0;

    const chunks = results.map((r) => {
      if (r.status === "fulfilled") {
        if (r.value.fallbackUsed) fallbackCount++;
        return r.value.chunks;
      }
      failedDatasets.push(toFailedDataset(r.reason));
      return [];
    });
    for (const warning of summarizeFailures(failedDatasets)) {
      logger.warn(`Retrieval task failures: ${warning}`);
    }
    return { results: chunks, failedDatasets, fallbackUsed: fallbackCount > 0, fallbackCount };
  }

  private async retrieveWithFallback(
    job: RetrievalJob,
    query: string,
    searchMethod: SearchMethod,
    scoreThreshold: number,
    topK: number,
  ): Promise<{ chunks: CleanChunk[]; fallbackUsed: boolean }> {
    const difyTopK = Math.min(Math.max(topK * 3, topK), this.difyTopKMax);
    const options = {
      searchMethod,
      rerankingEnable: false,
      topK: difyTopK,
      scoreThreshold,
      metadataFilteringConditions: job.metadataFilteringConditions,
      retrievalModel: job.dataset?.retrievalModel,
      externalRetrievalModel: job.dataset?.externalRetrievalModel,
      provider: job.dataset?.provider,
    };
    try {
      return { chunks: await this.client.retrieveChunks(job.datasetId, query, options), fallbackUsed: false };
    } catch (err) {
      if (
        err instanceof DifyApiError &&
        err.errorCode === "embedding_forbidden" &&
        (searchMethod === "semantic_search" || searchMethod === "hybrid_search")
      ) {
        const chunks = await this.client.retrieveChunks(job.datasetId, query, {
          ...options,
          searchMethod: this.fallbackSearchMethod,
        });
        return { chunks, fallbackUsed: true };
      }
      throw err;
    }
  }

  private filterRetrievableDatasets(datasets: CachedDataset[], searchMethod: SearchMethod): CachedDataset[] {
    return datasets.filter((dataset) => {
      if (dataset.enableApi === false) return false;
      if ((dataset.totalAvailableDocuments ?? dataset.documentCount) <= 0) return false;
      if (
        dataset.embeddingAvailable === false &&
        (searchMethod === "semantic_search" || searchMethod === "hybrid_search")
      ) {
        return false;
      }
      return true;
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
        datasetId: c.datasetId,
        datasetName: this.kbManager.getDatasetNameById(c.datasetId) ?? c.datasetId,
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

function scopeRequiredResult(queries: string[], searchMethod: SearchMethod, startTime: number): RetrievalResult {
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
      scopeRequired: true,
      errorCode: "scope_required",
      warnings: ["knowledge_search requires datasetIds or datasetNames unless unscoped search is enabled"],
      failedDatasets: [],
      fallbackUsed: false,
    },
  };
}

function toFailedDataset(reason: unknown): FailedDataset {
  if (reason instanceof DifyApiError) {
    return {
      datasetId: extractDatasetId(reason.message),
      errorCode: reason.errorCode,
      message: reason.message,
    };
  }
  return {
    datasetId: "unknown",
    errorCode: "unknown",
    message: reason instanceof Error ? reason.message : String(reason),
  };
}

function extractDatasetId(message: string): string {
  return message.match(/\/datasets\/([^/]+)\/retrieve/)?.[1] ?? "unknown";
}

function summarizeFailures(failures: FailedDataset[]): string[] {
  if (failures.length === 0) return [];
  const groups = new Map<string, FailedDataset[]>();
  for (const failure of failures) {
    const key = `${failure.errorCode}:${fingerprintMessage(failure.message)}`;
    groups.set(key, [...(groups.get(key) ?? []), failure]);
  }
  return [...groups.values()].map((items) => {
    const first = items[0]!;
    const sampleIds = items.slice(0, 3).map((item) => item.datasetId).join(", ");
    return `${items.length} dataset(s) failed with ${first.errorCode}; sample=${sampleIds}`;
  });
}

function fingerprintMessage(message: string): string {
  return message
    .replace(/\/datasets\/[^/]+\/retrieve/g, "/datasets/:id/retrieve")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":uuid")
    .slice(0, 160);
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
