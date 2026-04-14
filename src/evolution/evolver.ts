import { randomUUID } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { EvolutionProposal, Reflection, AgentDefinition } from "../core/types.js";
import { logger } from "../utils/logger.js";

const EVOLUTION_SYSTEM_PROMPT = `You are an agent evolution system. Based on accumulated reflections, propose specific improvements.

Your output must be valid JSON array of proposals, each with:
{
  "type": "soul_update" | "new_skill" | "config_change" | "workflow_adjustment",
  "description": "What to change and why",
  "diff": "The specific change (before -> after)",
  "confidence": 0.8
}

Rules:
- Only propose changes with evidence from reflections.
- soul_update: Only modify MUTABLE sections, never CORE values.
- new_skill: Include complete skill content in the diff.
- config_change: Be specific about which config value to change.
- Confidence must be justified. Don't propose low-confidence changes.
- Max 3 proposals per evolution cycle.`;

export class Evolver {
  private proposals = new Map<string, EvolutionProposal[]>();

  constructor(private model: BaseChatModel) {}

  private tenantKey(tenantId: string, agentName: string): string {
    return `${tenantId}:${agentName}`;
  }

  async evolve(tenantId: string, agentDef: AgentDefinition, reflections: Reflection[]): Promise<EvolutionProposal[]> {
    if (reflections.length === 0) return [];

    const reflectionSummary = reflections
      .map((r) => `[${r.timestamp}] confidence=${r.confidence}\nSummary: ${r.summary}\nLessons: ${r.lessonsLearned.join("; ")}\nImprovements: ${r.suggestedImprovements.join("; ")}`)
      .join("\n\n");

    const input = `## Agent: ${agentDef.name} (tenant: ${tenantId})

## Current SOUL (MUTABLE sections)
${agentDef.prompts.soul ?? "Not defined"}

## Current Config
Model: ${agentDef.config.model}
Worker Model: ${agentDef.config.workerModel}
Max Concurrency: ${agentDef.config.maxConcurrency}
Timeout: ${agentDef.config.timeout}ms

## Accumulated Reflections (${reflections.length})
${reflectionSummary}

Propose improvements based on patterns in these reflections.`;

    try {
      const response = await this.model.invoke([
        new SystemMessage(EVOLUTION_SYSTEM_PROMPT),
        new HumanMessage(input),
      ]);

      const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      const cleaned = content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned) as Array<{
        type: EvolutionProposal["type"];
        description: string;
        diff: string;
        confidence: number;
      }>;

      const key = this.tenantKey(tenantId, agentDef.name);
      const existing = this.proposals.get(key) ?? [];

      const newProposals: EvolutionProposal[] = parsed
        .filter((p) => p.confidence >= 0.7)
        .map((p) => ({
          id: randomUUID(),
          tenantId,
          agentName: agentDef.name,
          timestamp: new Date().toISOString(),
          type: p.type,
          description: p.description,
          diff: p.diff,
          status: "pending" as const,
          confidence: p.confidence,
        }));

      existing.push(...newProposals);
      this.proposals.set(key, existing);
      logger.info(`Evolution: ${newProposals.length} proposals for tenant=${tenantId} agent=${agentDef.name}`);

      return newProposals;
    } catch (err) {
      logger.error(`Evolution failed for tenant=${tenantId} agent=${agentDef.name}: ${err}`);
      return [];
    }
  }

  getPendingProposals(tenantId: string, agentName: string): EvolutionProposal[] {
    const key = this.tenantKey(tenantId, agentName);
    return (this.proposals.get(key) ?? []).filter((p) => p.status === "pending");
  }

  approveProposal(proposalId: string): EvolutionProposal | null {
    for (const proposals of this.proposals.values()) {
      const proposal = proposals.find((p) => p.id === proposalId);
      if (proposal) { proposal.status = "approved"; return proposal; }
    }
    return null;
  }

  rejectProposal(proposalId: string): EvolutionProposal | null {
    for (const proposals of this.proposals.values()) {
      const proposal = proposals.find((p) => p.id === proposalId);
      if (proposal) { proposal.status = "rejected"; return proposal; }
    }
    return null;
  }

  getAllProposals(tenantId?: string): EvolutionProposal[] {
    if (!tenantId) {
      return Array.from(this.proposals.values()).flat();
    }
    return Array.from(this.proposals.entries())
      .filter(([key]) => key.startsWith(`${tenantId}:`))
      .flatMap(([, v]) => v);
  }
}
