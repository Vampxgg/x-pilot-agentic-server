import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { MemoryStore, WorkingMemory, MemorySearchResult } from "../core/types.js";
import { FileMemoryStore } from "./stores/file-store.js";
import { PgMemoryStore } from "./stores/pg-store.js";
import { LongTermMemory } from "./long-term.js";
import { MemoryConsolidator } from "./memory-consolidator.js";
import { createWorkingMemory } from "./short-term.js";
import { getConfig } from "../utils/config.js";

export class MemoryManager {
  private store: MemoryStore;
  private longTerm: LongTermMemory;
  private consolidator: MemoryConsolidator;

  constructor(model: BaseChatModel, store?: MemoryStore) {
    const config = getConfig();
    this.store = store ?? (config.memory.store === "postgres" ? new PgMemoryStore() : new FileMemoryStore());
    this.longTerm = new LongTermMemory(this.store);
    this.consolidator = new MemoryConsolidator(this.store, model);
  }

  createWorkingMemory(): WorkingMemory {
    return createWorkingMemory();
  }

  async loadLongTermMemory(tenantId: string, agentName: string): Promise<string> {
    return this.longTerm.load(tenantId, agentName);
  }

  async saveLongTermMemory(tenantId: string, agentName: string, content: string): Promise<void> {
    return this.longTerm.save(tenantId, agentName, content);
  }

  async appendLesson(tenantId: string, agentName: string, lesson: string): Promise<void> {
    return this.longTerm.appendLesson(tenantId, agentName, lesson);
  }

  async logDaily(tenantId: string, agentName: string, content: string): Promise<void> {
    return this.consolidator.appendDailyLog(tenantId, agentName, content);
  }

  async consolidate(tenantId: string, agentName: string): Promise<string | null> {
    return this.consolidator.consolidate(tenantId, agentName);
  }

  async search(tenantId: string, agentName: string, query: string): Promise<MemorySearchResult[]> {
    return this.store.search(tenantId, agentName, query);
  }

  getStore(): MemoryStore {
    return this.store;
  }
}
