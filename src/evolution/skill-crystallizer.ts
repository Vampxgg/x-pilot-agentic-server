import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ToolCallRecord, AgentDefinition, SkillDefinition } from "../core/types.js";
import { logger } from "../utils/logger.js";

const CRYSTALLIZE_PROMPT = `You are a skill crystallization system. Analyze tool call patterns and create a reusable skill definition.

A skill is a structured markdown document that teaches the agent a reusable behavioral pattern.

Output format:
{
  "name": "skill-name",
  "description": "One-line description",
  "content": "Full markdown content of the skill"
}

The content should include:
- When to use this skill (trigger conditions)
- Step-by-step execution procedure
- Expected inputs and outputs
- Error handling guidance
- Quality criteria`;

const DEFAULT_DATA_DIR = resolve(process.cwd(), "data");

export class SkillCrystallizer {
  private patternBuffer = new Map<string, ToolCallRecord[][]>();

  constructor(private model: BaseChatModel) {}

  private bufferKey(tenantId: string, agentName: string): string {
    return `${tenantId}:${agentName}`;
  }

  recordPattern(tenantId: string, agentName: string, toolCalls: ToolCallRecord[]): void {
    const key = this.bufferKey(tenantId, agentName);
    const existing = this.patternBuffer.get(key) ?? [];
    existing.push(toolCalls);
    if (existing.length > 20) existing.shift();
    this.patternBuffer.set(key, existing);
  }

  async trycrystallize(tenantId: string, agentDef: AgentDefinition): Promise<SkillDefinition | null> {
    const key = this.bufferKey(tenantId, agentDef.name);
    const patterns = this.patternBuffer.get(key);
    if (!patterns || patterns.length < 3) return null;

    const sequences = patterns.map((p) => p.map((tc) => tc.toolName).join(" -> "));
    const frequency = new Map<string, number>();
    for (const seq of sequences) {
      frequency.set(seq, (frequency.get(seq) ?? 0) + 1);
    }

    const repeatedSequence = Array.from(frequency.entries()).find(([_, count]) => count >= 3);
    if (!repeatedSequence) return null;

    const [sequence, count] = repeatedSequence;
    const examplePattern = patterns.find((p) => p.map((tc) => tc.toolName).join(" -> ") === sequence);
    if (!examplePattern) return null;

    logger.info(`Crystallizing pattern for tenant=${tenantId} agent=${agentDef.name}: "${sequence}" (seen ${count} times)`);

    try {
      const input = `## Agent: ${agentDef.name}
## Repeated Pattern (seen ${count} times)
Sequence: ${sequence}

## Example Execution
${examplePattern.map((tc) => `Tool: ${tc.toolName}\nInput: ${JSON.stringify(tc.input)}\nOutput: ${typeof tc.output === "string" ? tc.output.slice(0, 200) : JSON.stringify(tc.output).slice(0, 200)}\nSuccess: ${tc.success}`).join("\n\n")}

Create a reusable skill that captures this pattern.`;

      const response = await this.model.invoke([
        new SystemMessage(CRYSTALLIZE_PROMPT),
        new HumanMessage(input),
      ]);

      const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      const cleaned = content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);

      const skillsDir = join(DEFAULT_DATA_DIR, "tenants", tenantId, "agents", agentDef.name, "skills");
      if (!existsSync(skillsDir)) await mkdir(skillsDir, { recursive: true });

      const skillPath = join(skillsDir, `${parsed.name}.md`);

      const skillDef: SkillDefinition = {
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        filePath: skillPath,
      };

      await writeFile(skillDef.filePath, `# ${parsed.description}\n\n${parsed.content}`, "utf-8");
      logger.info(`Skill crystallized: ${skillDef.name} for tenant=${tenantId} agent=${agentDef.name}`);

      return skillDef;
    } catch (err) {
      logger.error(`Skill crystallization failed for tenant=${tenantId} agent=${agentDef.name}: ${err}`);
      return null;
    }
  }
}
