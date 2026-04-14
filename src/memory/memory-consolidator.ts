import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { MemoryStore } from "../core/types.js";
import { LongTermMemory } from "./long-term.js";
import { logger } from "../utils/logger.js";

const CONSOLIDATION_PROMPT = `You are a memory consolidation system. Your task is to:
1. Review the daily memory logs provided
2. Extract key facts, lessons learned, and important observations
3. Summarize them into a concise long-term memory update
4. Prioritize information that would be useful for future tasks

Output a concise markdown summary with sections for:
- Key Facts (persistent information)
- Lessons Learned (what worked/didn't)
- Patterns (recurring observations)

Be selective -- only include truly valuable information. Drop trivial details.`;

export class MemoryConsolidator {
  private longTerm: LongTermMemory;

  constructor(
    private store: MemoryStore,
    private model: BaseChatModel,
  ) {
    this.longTerm = new LongTermMemory(store);
  }

  async consolidate(tenantId: string, agentName: string): Promise<string | null> {
    const files = await this.store.list(tenantId, agentName);
    const dailyFiles = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));

    if (dailyFiles.length === 0) {
      logger.info(`No daily logs to consolidate for tenant=${tenantId} agent=${agentName}`);
      return null;
    }

    const dailyContents: string[] = [];
    for (const file of dailyFiles.sort()) {
      const content = await this.store.read(tenantId, agentName, file);
      if (content) dailyContents.push(`### ${file}\n${content}`);
    }

    const existingMemory = await this.longTerm.load(tenantId, agentName);
    const input = [
      `## Existing Long-term Memory\n${existingMemory || "(empty)"}`,
      `## Daily Logs to Consolidate\n${dailyContents.join("\n\n")}`,
    ].join("\n\n");

    const response = await this.model.invoke([
      new SystemMessage(CONSOLIDATION_PROMPT),
      new HumanMessage(input),
    ]);

    const summary = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

    const updatedMemory = existingMemory
      ? `${existingMemory}\n\n---\n\n## Consolidation ${new Date().toISOString().split("T")[0]}\n${summary}`
      : summary;

    await this.longTerm.save(tenantId, agentName, updatedMemory);

    logger.info(`Consolidated ${dailyFiles.length} daily logs for tenant=${tenantId} agent=${agentName}`);
    return summary;
  }

  async appendDailyLog(tenantId: string, agentName: string, content: string): Promise<void> {
    const today = new Date().toISOString().split("T")[0]!;
    const key = `${today}.md`;
    await this.store.append(tenantId, agentName, key, `\n- ${new Date().toISOString()} ${content}`);
  }
}
