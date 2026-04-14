import { logger } from "../../utils/logger.js";
import { DifyClient } from "./dify-client.js";
import type { CachedDataset, CachedDocumentMeta, DifyMetadataFilter } from "./types.js";

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class KnowledgeBaseManager {
  private client: DifyClient;
  private datasetTTL: number;
  private documentTTL: number;

  private datasetCache: CacheEntry<CachedDataset[]> | null = null;
  private documentCache = new Map<string, CacheEntry<CachedDocumentMeta>>();

  constructor(client: DifyClient, datasetTTL = 300_000, documentTTL = 600_000) {
    this.client = client;
    this.datasetTTL = datasetTTL;
    this.documentTTL = documentTTL;
  }

  // ---------------------------------------------------------------------------
  // Dataset discovery & caching
  // ---------------------------------------------------------------------------

  async listAvailable(): Promise<CachedDataset[]> {
    if (this.datasetCache && Date.now() < this.datasetCache.expiresAt) {
      return this.datasetCache.data;
    }
    return this.refreshDatasets();
  }

  private async refreshDatasets(): Promise<CachedDataset[]> {
    const all: CachedDataset[] = [];
    let page = 1;

    try {
      while (true) {
        const resp = await this.client.listDatasets(page, 100);
        for (const ds of resp.data) {
          all.push({
            id: ds.id,
            name: ds.name,
            description: ds.description,
            documentCount: ds.document_count,
            wordCount: ds.word_count,
            embeddingModel: ds.embedding_model,
          });
        }
        if (!resp.has_more) break;
        page++;
      }

      this.datasetCache = { data: all, expiresAt: Date.now() + this.datasetTTL };
      logger.info(`KnowledgeBaseManager: discovered ${all.length} datasets`);
    } catch (err) {
      logger.error(`KnowledgeBaseManager: failed to list datasets — ${err}`);
      if (this.datasetCache) return this.datasetCache.data;
    }

    return all;
  }

  // ---------------------------------------------------------------------------
  // Dataset routing — resolve dataset IDs from hints
  // ---------------------------------------------------------------------------

  async resolveDatasetIds(opts?: { ids?: string[]; names?: string[] }): Promise<string[]> {
    if (opts?.ids && opts.ids.length > 0) return opts.ids;

    const all = await this.listAvailable();
    if (!opts?.names || opts.names.length === 0) {
      return all.map((d) => d.id);
    }

    const lowerNames = opts.names.map((n) => n.toLowerCase());
    return all
      .filter((d) => lowerNames.some((ln) => d.name.toLowerCase().includes(ln)))
      .map((d) => d.id);
  }

  getDatasetNameById(id: string): string | undefined {
    return this.datasetCache?.data.find((d) => d.id === id)?.name;
  }

  // ---------------------------------------------------------------------------
  // Document metadata caching (mirrors original Pipeline's doc_meta_cache)
  // ---------------------------------------------------------------------------

  getDocumentMeta(databaseId: string, documentId: string): CachedDocumentMeta | undefined {
    const key = `${databaseId}:${documentId}`;
    const entry = this.documentCache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.documentCache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  setDocumentMeta(databaseId: string, documentId: string, meta: CachedDocumentMeta): void {
    const key = `${databaseId}:${documentId}`;
    this.documentCache.set(key, { data: meta, expiresAt: Date.now() + this.documentTTL });
  }

  async prefetchDocumentMeta(
    tasks: Array<{ databaseId: string; documentId?: string }>,
  ): Promise<void> {
    const needed: Array<[string, string]> = [];
    for (const t of tasks) {
      if (t.documentId && !this.getDocumentMeta(t.databaseId, t.documentId)) {
        needed.push([t.databaseId, t.documentId]);
      }
    }
    if (needed.length === 0) return;

    const results = await Promise.allSettled(
      needed.map(([db, doc]) => this.client.getDocumentDetail(db, doc)),
    );

    for (let i = 0; i < needed.length; i++) {
      const result = results[i]!;
      if (result.status !== "fulfilled" || !result.value) continue;
      const [dbId, docId] = needed[i]!;
      const detail = result.value;

      this.setDocumentMeta(dbId, docId, {
        id: detail.id,
        name: detail.name,
        docMetadata: cleanMetadata(detail.doc_metadata),
        source: "api_detail",
      });
    }

    logger.debug(`KnowledgeBaseManager: prefetched ${needed.length} document metadata entries`);
  }

  injectMetadataFromChunks(
    chunks: Array<{ databaseId: string; documentId: string; documentName: string; docMetadata: Record<string, unknown> }>,
  ): void {
    for (const c of chunks) {
      const existing = this.getDocumentMeta(c.databaseId, c.documentId);
      if (existing?.source === "api_detail") continue;

      if (c.documentName || Object.keys(c.docMetadata).length > 0) {
        this.setDocumentMeta(c.databaseId, c.documentId, {
          id: c.documentId,
          name: c.documentName,
          docMetadata: c.docMetadata,
          source: "retrieve_snapshot",
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Build metadata filter by document names (mirrors build_execution_plan)
  // ---------------------------------------------------------------------------

  async buildDocumentNameFilter(
    databaseId: string,
    documentIds: string[],
  ): Promise<DifyMetadataFilter | undefined> {
    const names: string[] = [];
    for (const docId of documentIds) {
      const meta = this.getDocumentMeta(databaseId, docId);
      if (meta?.name) names.push(meta.name);
    }

    if (names.length === 0) return undefined;

    return {
      logical_operator: names.length > 1 ? "or" : "and",
      conditions: names.map((n) => ({
        name: "document_name",
        comparison_operator: "is",
        value: n,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Utility: clean Dify's two metadata formats into a flat dict
// ---------------------------------------------------------------------------

export function cleanMetadata(
  raw: Record<string, unknown>[] | Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!raw) return {};

  if (Array.isArray(raw)) {
    const result: Record<string, unknown> = {};
    for (const item of raw) {
      if (typeof item === "object" && item !== null && "name" in item) {
        const val = (item as Record<string, unknown>).value;
        result[(item as Record<string, unknown>).name as string] = val === "NULL" ? null : val;
      }
    }
    return result;
  }

  if (typeof raw === "object") return raw;
  return {};
}
