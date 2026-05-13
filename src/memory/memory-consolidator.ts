import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { MemoryStore } from "../core/types.js";
import { LongTermMemory } from "./long-term.js";
import { logger } from "../utils/logger.js";

const MAX_MEMORY_CHARS = 50_000;

const CONSOLIDATION_PROMPT = `You are a memory consolidation system. You will receive:
1. The agent's current long-term memory (may be empty)
2. New daily logs to incorporate

Your task: produce a SINGLE COMPLETE replacement for the long-term memory that merges the existing memory with insights from the new logs.

Output format — concise markdown with these sections:
- **Key Facts** (persistent domain knowledge, audience info, tech stack)
- **Lessons Learned** (what worked/didn't, verified patterns)
- **Patterns** (recurring observations)
- **Workflow Notes** (proven effective workflows, if any)

Rules:
- Be highly selective — only truly valuable, non-redundant information.
- Drop trivial, repetitive, or outdated entries.
- If two facts say the same thing, keep only the better-phrased one.
- The output REPLACES the old memory entirely — do not reference "previous" or "existing" memory.
- Stay under 800 lines of markdown. If the combined information is too large, aggressively summarize.`;

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

    const existingSection = existingMemory
      ? `## Current Long-term Memory\n${existingMemory.slice(0, MAX_MEMORY_CHARS)}`
      : "## Current Long-term Memory\n(empty)";

    const input = [
      existingSection,
      `## New Daily Logs to Incorporate\n${dailyContents.join("\n\n")}`,
    ].join("\n\n");

    const response = await this.model.invoke([
      new SystemMessage(CONSOLIDATION_PROMPT),
      new HumanMessage(input),
    ]);

    const summary = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

    const finalMemory = summary.slice(0, MAX_MEMORY_CHARS);
    await this.longTerm.save(tenantId, agentName, finalMemory);

    for (const file of dailyFiles) {
      await this.store.delete(tenantId, agentName, file);
    }

    logger.info(`Consolidated ${dailyFiles.length} daily logs for tenant=${tenantId} agent=${agentName}`);
    return summary;
  }

  async appendDailyLog(tenantId: string, agentName: string, content: string): Promise<void> {
    const today = new Date().toISOString().split("T")[0]!;
    const key = `${today}.md`;
    await this.store.append(tenantId, agentName, key, `\n- ${new Date().toISOString()} ${content}`);
  }
}
