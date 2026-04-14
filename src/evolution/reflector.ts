import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { Reflection, ToolCallRecord, SubAgentResult } from "../core/types.js";
import { logger } from "../utils/logger.js";

const REFLECTION_SYSTEM_PROMPT = `You are a task reflection system for an AI agent. After each task, you analyze what happened and extract lessons.

Your output must be valid JSON with this structure:
{
  "summary": "Brief summary of what happened",
  "lessonsLearned": ["lesson 1", "lesson 2"],
  "suggestedImprovements": ["improvement 1", "improvement 2"],
  "confidence": 0.8
}

Rules:
- Be specific, not generic. "Use batch API calls" is better than "Be more efficient".
- Only include lessons with practical value for future tasks.
- Confidence should reflect how sure you are these lessons generalize.
- Keep lessons to 1-5 items. Quality over quantity.`;

export class Reflector {
  constructor(private model: BaseChatModel) {}

  async reflect(
    agentName: string,
    taskDescription: string,
    toolCalls: ToolCallRecord[],
    subAgentResults: SubAgentResult[],
    success: boolean,
  ): Promise<Reflection> {
    const toolSummary = toolCalls
      .map((tc) => `${tc.toolName}: ${tc.success ? "OK" : `FAIL(${tc.error})`} ${tc.duration}ms`)
      .join("\n");

    const subSummary = subAgentResults
      .map((sr) => `${sr.agentName}: ${sr.success ? "OK" : "FAIL"} ${sr.duration}ms`)
      .join("\n");

    const input = `## Task
${taskDescription}

## Outcome
${success ? "SUCCESS" : "FAILURE"}

## Tool Calls (${toolCalls.length})
${toolSummary || "None"}

## Sub-Agent Results (${subAgentResults.length})
${subSummary || "None"}

## Statistics
- Total tool calls: ${toolCalls.length}
- Failed tool calls: ${toolCalls.filter((t) => !t.success).length}
- Total sub-agents: ${subAgentResults.length}
- Failed sub-agents: ${subAgentResults.filter((s) => !s.success).length}`;

    try {
      const response = await this.model.invoke([
        new SystemMessage(REFLECTION_SYSTEM_PROMPT),
        new HumanMessage(input),
      ]);

      const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      const cleaned = content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);

      return {
        timestamp: new Date().toISOString(),
        summary: parsed.summary ?? "Task completed",
        lessonsLearned: parsed.lessonsLearned ?? [],
        suggestedImprovements: parsed.suggestedImprovements ?? [],
        confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
      };
    } catch (err) {
      logger.error(`Reflection failed for ${agentName}: ${err}`);
      return {
        timestamp: new Date().toISOString(),
        summary: `Reflection error: ${err instanceof Error ? err.message : String(err)}`,
        lessonsLearned: [],
        suggestedImprovements: [],
        confidence: 0,
      };
    }
  }
}
