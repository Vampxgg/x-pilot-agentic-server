import { logger } from "../../utils/logger.js";
import type {
  DifyDatasetListResponse,
  DifyDataset,
  DifyDocumentDetail,
  DifySegment,
  DifySegmentListResponse,
  DifyRetrieveResponse,
  DifyMetadataFilter,
  DifyRetrievalModel,
  DifyExternalRetrievalModel,
  CleanChunk,
  KnowledgeErrorCode,
  SearchMethod,
} from "./types.js";

const DEFAULT_TIMEOUT = 45_000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1_000;
const RETRIEVE_TOP_K = 100;
const CIRCUIT_BREAKER_THRESHOLD = 8;
const CIRCUIT_BREAKER_COOLDOWN_MS = 15_000;
const MAX_QUERY_LENGTH = 250;

export interface DifyClientConfig {
  baseUrl: string;
  apiKey: string;
  timeout?: number;
}

export class DifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodyText: string,
    readonly errorCode: KnowledgeErrorCode,
  ) {
    super(message);
    this.name = "DifyApiError";
  }
}

export class DifyClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;
  private consecutiveServerErrors = 0;
  private circuitOpenUntil = 0;

  constructor(config: DifyClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.headers = {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    };
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
  }

  // ---------------------------------------------------------------------------
  // Dataset APIs
  // ---------------------------------------------------------------------------

  async listDatasets(page = 1, limit = 100, keyword?: string): Promise<DifyDatasetListResponse> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (keyword) params.set("keyword", keyword);
    return this.get<DifyDatasetListResponse>(`/datasets?${params}`);
  }

  async getDataset(datasetId: string): Promise<DifyDataset> {
    return this.get<DifyDataset>(`/datasets/${datasetId}`);
  }

  // ---------------------------------------------------------------------------
  // Document APIs
  // ---------------------------------------------------------------------------

  async getDocumentDetail(datasetId: string, documentId: string): Promise<DifyDocumentDetail> {
    return this.get<DifyDocumentDetail>(`/datasets/${datasetId}/documents/${documentId}`);
  }

  async getAllSegments(datasetId: string, documentId: string): Promise<DifySegment[]> {
    const allSegments: DifySegment[] = [];
    let page = 1;

    while (true) {
      const resp = await this.get<DifySegmentListResponse>(
        `/datasets/${datasetId}/documents/${documentId}/segments?limit=100&page=${page}`,
      );

      const segments = resp.data ?? [];
      if (segments.length === 0) break;

      allSegments.push(...segments);
      if (!resp.has_more) break;
      page++;
    }

    return allSegments;
  }

  // ---------------------------------------------------------------------------
  // Core Retrieval — mirrors original Pipeline's DifyApiClient.retrieve
  // ---------------------------------------------------------------------------

  async retrieveChunks(
    datasetId: string,
    query: string,
    options?: {
      searchMethod?: SearchMethod;
      topK?: number;
      scoreThreshold?: number;
      rerankingEnable?: boolean;
      metadataFilteringConditions?: DifyMetadataFilter;
      retrievalModel?: DifyRetrievalModel;
      externalRetrievalModel?: DifyExternalRetrievalModel | null;
      provider?: string;
    },
  ): Promise<CleanChunk[]> {
    const body = buildRetrieveRequest(query, options);

    const resp = await this.post<DifyRetrieveResponse>(`/datasets/${datasetId}/retrieve`, body);

    return (resp.records ?? [])
      .filter((rec) => rec.segment?.content)
      .map((rec) => ({
        id: rec.segment.id,
        chunkId: rec.segment.id,
        content: rec.segment.content,
        score: rec.score ?? 0,
        datasetId,
        documentId: rec.segment.document_id,
        documentName: rec.segment.document?.name ?? "",
        position: rec.segment.position ?? 0,
        docMetadata: {},
        keywords: rec.segment.keywords ?? [],
      }));
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers with retry + timeout
  // ---------------------------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    if (Date.now() < this.circuitOpenUntil) {
      throw new Error(
        `Dify circuit open, skip ${method} ${path} until ${new Date(this.circuitOpenUntil).toISOString()}`,
      );
    }

    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const resp = await fetch(url, {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const errMsg = `Dify API ${method} ${path} returned ${resp.status}: ${text.slice(0, 300)}`;
        this.onServerError(resp.status, text);

        if (attempt < MAX_RETRIES && resp.status >= 500) {
          logger.warn(`${errMsg} — retrying (${attempt + 1}/${MAX_RETRIES})`);
          await sleep(RETRY_BASE_MS * (attempt + 1));
          return this.request<T>(method, path, body, attempt + 1);
        }
        throw new DifyApiError(errMsg, resp.status, text, classifyDifyError(resp.status, text));
      }

      this.onRequestSuccess();
      return (await resp.json()) as T;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        this.onServerError(504, "timeout");
        if (attempt < MAX_RETRIES) {
          logger.warn(`Dify API ${method} ${path} timed out — retrying (${attempt + 1}/${MAX_RETRIES})`);
          await sleep(RETRY_BASE_MS * (attempt + 1));
          return this.request<T>(method, path, body, attempt + 1);
        }
        throw new Error(`Dify API ${method} ${path} timed out after ${this.timeout}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private onRequestSuccess(): void {
    this.consecutiveServerErrors = 0;
    this.circuitOpenUntil = 0;
  }

  private onServerError(status: number, bodyText: string): void {
    if (status < 500) return;
    this.consecutiveServerErrors += 1;

    const poolExhausted = /QueuePool limit|connection timed out/i.test(bodyText);
    if (poolExhausted || this.consecutiveServerErrors >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      logger.warn(
        `Dify circuit opened for ${CIRCUIT_BREAKER_COOLDOWN_MS}ms ` +
        `(consecutive5xx=${this.consecutiveServerErrors}, status=${status})`,
      );
      this.consecutiveServerErrors = 0;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRetrieveRequest(
  query: string,
  options?: {
    searchMethod?: SearchMethod;
    topK?: number;
    scoreThreshold?: number;
    rerankingEnable?: boolean;
    metadataFilteringConditions?: DifyMetadataFilter;
    retrievalModel?: DifyRetrievalModel;
    externalRetrievalModel?: DifyExternalRetrievalModel | null;
    provider?: string;
  },
) {
  const topK = options?.topK ?? options?.retrievalModel?.top_k ?? RETRIEVE_TOP_K;
  const scoreThreshold = options?.scoreThreshold;
  const scoreThresholdEnabled =
    scoreThreshold !== undefined
      ? scoreThreshold > 0
      : options?.retrievalModel?.score_threshold_enabled ?? false;

  const body: {
    query: string;
    retrieval_model?: DifyRetrievalModel & { metadata_filtering_conditions?: DifyMetadataFilter };
    external_retrieval_model?: DifyExternalRetrievalModel;
  } = {
    query: query.slice(0, MAX_QUERY_LENGTH),
  };

  if (options?.provider === "external") {
    body.external_retrieval_model = {
      ...options.externalRetrievalModel,
      top_k: topK,
      score_threshold_enabled: scoreThresholdEnabled,
      ...(scoreThresholdEnabled
        ? { score_threshold: scoreThreshold ?? options.externalRetrievalModel?.score_threshold ?? 0 }
        : {}),
    };
    return body;
  }

  body.retrieval_model = {
    search_method: options?.searchMethod ?? options?.retrievalModel?.search_method ?? "hybrid_search",
    reranking_enable: options?.rerankingEnable ?? options?.retrievalModel?.reranking_enable ?? false,
    reranking_mode: options?.retrievalModel?.reranking_mode,
    reranking_model: options?.retrievalModel?.reranking_model,
    weights: options?.retrievalModel?.weights ?? null,
    top_k: topK,
    score_threshold_enabled: scoreThresholdEnabled,
    score_threshold: scoreThresholdEnabled ? scoreThreshold ?? options?.retrievalModel?.score_threshold ?? 0 : null,
    ...(options?.metadataFilteringConditions
      ? { metadata_filtering_conditions: options.metadataFilteringConditions }
      : {}),
  };

  return body;
}

function classifyDifyError(status: number, bodyText: string): KnowledgeErrorCode {
  if (/embeddings?.*403|403.*embeddings?|Forbidden for url:.*\/embeddings/i.test(bodyText)) {
    return "embedding_forbidden";
  }
  if (status === 400) return "invalid_param";
  if (status === 403) return "dataset_forbidden";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504 || /timeout/i.test(bodyText)) return "timeout";
  if (status >= 500) return "server_error";
  return "unknown";
}
