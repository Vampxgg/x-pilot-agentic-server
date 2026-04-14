import type { MemoryStore, MemorySearchResult } from "../../core/types.js";
import { logger } from "../../utils/logger.js";

export class PgMemoryStore implements MemoryStore {
  constructor() {
    logger.warn("PgMemoryStore is a placeholder. Install pg + pgvector and implement for production use.");
  }

  async read(tenantId: string, agentName: string, key: string): Promise<string | null> {
    throw new Error("PgMemoryStore not implemented. Use FileMemoryStore or implement pg backend.");
  }

  async write(tenantId: string, agentName: string, key: string, content: string): Promise<void> {
    throw new Error("PgMemoryStore not implemented.");
  }

  async append(tenantId: string, agentName: string, key: string, content: string): Promise<void> {
    throw new Error("PgMemoryStore not implemented.");
  }

  async list(tenantId: string, agentName: string): Promise<string[]> {
    throw new Error("PgMemoryStore not implemented.");
  }

  async search(tenantId: string, agentName: string, query: string): Promise<MemorySearchResult[]> {
    throw new Error("PgMemoryStore not implemented.");
  }
}
