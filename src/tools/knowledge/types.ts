// ---------------------------------------------------------------------------
// Dify Knowledge API — Response Types
// ---------------------------------------------------------------------------

export interface DifyDataset {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  permission: string;
  data_source_type: string | null;
  indexing_technique: string | null;
  app_count: number;
  document_count: number;
  word_count: number;
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
  embedding_model: string | null;
  embedding_model_provider: string | null;
  embedding_available: boolean | null;
  retrieval_model_dict?: DifyRetrievalModel;
  enable_api?: boolean;
  total_available_documents?: number;
  external_retrieval_model?: DifyExternalRetrievalModel | null;
}

export interface DifyDatasetListResponse {
  data: DifyDataset[];
  has_more: boolean;
  limit: number;
  total: number;
  page: number;
}

export interface DifyRetrievalModel {
  search_method: SearchMethod;
  reranking_enable: boolean;
  reranking_mode?: "reranking_model" | "weighted_score";
  reranking_model?: {
    reranking_provider_name: string;
    reranking_model_name: string;
  } | null;
  top_k: number;
  score_threshold_enabled: boolean;
  score_threshold: number | null;
  weights: Record<string, unknown> | null;
}

export interface DifyExternalRetrievalModel {
  top_k?: number;
  score_threshold?: number;
  score_threshold_enabled?: boolean;
}

export interface DifyMetadataFilterCondition {
  name: string;
  comparison_operator: string;
  value: string | number | null;
}

export interface DifyMetadataFilter {
  logical_operator: "and" | "or";
  conditions: DifyMetadataFilterCondition[];
}

export interface DifyRetrieveRequest {
  query: string;
  retrieval_model?: DifyRetrievalModel & {
    metadata_filtering_conditions?: DifyMetadataFilter;
  };
  external_retrieval_model?: DifyExternalRetrievalModel;
}

export interface DifySegment {
  id: string;
  position: number;
  document_id: string;
  content: string;
  answer: string | null;
  word_count: number;
  tokens: number;
  keywords: string[];
  index_node_id: string;
  index_node_hash: string;
  hit_count: number;
  enabled: boolean;
  status: string;
  created_by: string;
  created_at: number;
  indexing_at: number;
  completed_at: number;
  error: string | null;
  stopped_at: number | null;
}

export interface DifyRetrievedSegment {
  segment: DifySegment & {
    document: {
      id: string;
      data_source_type: string;
      name: string;
    };
  };
  score: number;
}

export interface DifyRetrieveResponse {
  query: { content: string };
  records: DifyRetrievedSegment[];
}

export interface DifyDocumentDetail {
  id: string;
  name: string;
  doc_form?: string;
  doc_metadata?: Record<string, unknown>[] | Record<string, unknown>;
  data_source_type?: string;
  [key: string]: unknown;
}

export interface DifySegmentListResponse {
  data: DifySegment[];
  has_more: boolean;
  limit: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Internal Types — Clean Chunk (flattened from Dify's nested structure)
// ---------------------------------------------------------------------------

export interface CleanChunk {
  id: string;
  chunkId: string;
  content: string;
  score: number | null;
  datasetId: string;
  documentId: string;
  documentName: string;
  position: number;
  docMetadata: Record<string, unknown>;
  keywords: string[];
}

// ---------------------------------------------------------------------------
// Retrieval Options & Results
// ---------------------------------------------------------------------------

export type SearchMethod = "hybrid_search" | "semantic_search" | "full_text_search" | "keyword_search";

export interface RetrievalOptions {
  queries: string[];
  datasetIds?: string[];
  datasetNames?: string[];
  searchMethod?: SearchMethod;
  topK?: number;
  scoreThreshold?: number;
  enableRerank?: boolean;
  documentFilter?: string[];
  maxTokens?: number;
}

export interface RetrievalResult {
  success: boolean;
  query: string | string[];
  totalResults: number;
  results: FormattedChunk[];
  metadata: {
    datasetsSearched: number;
    searchMethod: string;
    rerankUsed: boolean;
    rrfUsed: boolean;
    durationMs: number;
    scopeRequired?: boolean;
    errorCode?: KnowledgeErrorCode;
    warnings?: string[];
    failedDatasets?: FailedDataset[];
    fallbackUsed?: boolean;
  };
}

export type KnowledgeErrorCode =
  | "scope_required"
  | "embedding_forbidden"
  | "invalid_param"
  | "dataset_forbidden"
  | "not_found"
  | "timeout"
  | "server_error"
  | "unknown";

export interface FailedDataset {
  datasetId: string;
  errorCode: KnowledgeErrorCode;
  message: string;
}

export interface FormattedChunk {
  content: string;
  score: number | null;
  source: {
    datasetId: string;
    datasetName: string;
    documentId: string;
    documentName: string;
    segmentId: string;
  };
  position: number;
  keywords: string[];
  sourceType: string;
}

// ---------------------------------------------------------------------------
// Formatted Document Output (for ContentFormatter)
// ---------------------------------------------------------------------------

export interface DocumentInfo {
  docMetadata: Record<string, unknown>;
  documentId: string;
  documentName: string;
  sourceType: string;
  contentBlocks: ContentBlock[];
  duration?: number;
  videoUrl?: string;
}

export interface ContentBlock {
  content: string;
  position: number;
  score: number | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Execution Plan (for RetrievalEngine)
// ---------------------------------------------------------------------------

export interface RetrievalJob {
  datasetId: string;
  dataset?: CachedDataset;
  metadataFilteringConditions?: DifyMetadataFilter;
}

export interface RetrievalTask {
  datasetId: string;
  documentId?: string;
  retrievalMode: "segment_retrieval" | "full_database_retrieval" | "full_document_retrieval";
  topK?: number;
}

// ---------------------------------------------------------------------------
// Rerank Config
// ---------------------------------------------------------------------------

export interface RerankConfig {
  enabled: boolean;
  provider: string;
  model: string;
  apiKey: string;
  apiUrl: string;
  timeout: number;
}

// ---------------------------------------------------------------------------
// Knowledge Config (for AppConfig extension)
// ---------------------------------------------------------------------------

export interface KnowledgeConfig {
  dify: {
    baseUrl: string;
    apiKey: string;
  };
  retrieval: {
    defaultSearchMethod: SearchMethod;
    defaultTopK: number;
    scoreThreshold: number;
    maxTokens: number;
    timeout: number;
    allowUnscopedSearch: boolean;
    maxDatasets: number;
    difyTopKMax: number;
    fallbackSearchMethod: SearchMethod;
  };
  rerank: RerankConfig;
  cache: {
    datasetTTL: number;
    documentTTL: number;
  };
}

// ---------------------------------------------------------------------------
// Cached Dataset Info (lightweight)
// ---------------------------------------------------------------------------

export interface CachedDataset {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  wordCount: number;
  provider: string;
  indexingTechnique: string | null;
  embeddingModel: string | null;
  embeddingModelProvider: string | null;
  embeddingAvailable: boolean | null;
  retrievalModel?: DifyRetrievalModel;
  enableApi: boolean | null;
  totalAvailableDocuments: number | null;
  externalRetrievalModel?: DifyExternalRetrievalModel | null;
}

export interface CachedDocumentMeta {
  id: string;
  name: string;
  docMetadata: Record<string, unknown>;
  source: "api_detail" | "retrieve_snapshot";
}
