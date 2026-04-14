import type { MemoryStore } from "../core/types.js";
import { logger } from "../utils/logger.js";

const MEMORY_FILE = "MEMORY.md";

export class LongTermMemory {
  constructor(private store: MemoryStore) {}

  async load(tenantId: string, agentName: string): Promise<string> {
    const content = await this.store.read(tenantId, agentName, MEMORY_FILE);
    return content ?? "";
  }

  async save(tenantId: string, agentName: string, content: string): Promise<void> {
    await this.store.write(tenantId, agentName, MEMORY_FILE, content);
    logger.info(`Long-term memory updated for tenant=${tenantId} agent=${agentName}`);
  }

  async appendLesson(tenantId: string, agentName: string, lesson: string): Promise<void> {
    const timestamp = new Date().toISOString().split("T")[0];
    const entry = `\n## ${timestamp}\n${lesson}\n`;
    await this.store.append(tenantId, agentName, MEMORY_FILE, entry);
  }

  async search(tenantId: string, agentName: string, query: string) {
    return this.store.search(tenantId, agentName, query);
  }
}
