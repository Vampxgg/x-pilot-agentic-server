import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentDefinition, Reflection } from "../core/types.js";
import { MemoryManager } from "../memory/memory-manager.js";
import { Evolver } from "./evolver.js";
import { ProposalApplier } from "./proposal-applier.js";
import { logger } from "../utils/logger.js";

const DEFAULT_TENANT = "default";

export class HeartbeatRunner {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private evolver: Evolver;
  private applier: ProposalApplier;
  private memoryManager: MemoryManager;

  constructor(model: BaseChatModel) {
    this.evolver = new Evolver(model);
    this.applier = new ProposalApplier();
    this.memoryManager = new MemoryManager(model);
  }

  start(agentDef: AgentDefinition): void {
    if (!agentDef.config.heartbeat.enabled) return;
    if (this.timers.has(agentDef.name)) return;

    const intervalMs = agentDef.config.heartbeat.intervalMs;

    logger.info(`Heartbeat started for ${agentDef.name} (every ${intervalMs / 1000}s)`);

    const timer = setInterval(async () => {
      await this.tick(agentDef, DEFAULT_TENANT);
    }, intervalMs);

    this.timers.set(agentDef.name, timer);
  }

  stop(agentName: string): void {
    const timer = this.timers.get(agentName);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(agentName);
      logger.info(`Heartbeat stopped for ${agentName}`);
    }
  }

  stopAll(): void {
    for (const [name, timer] of this.timers) {
      clearInterval(timer);
      logger.info(`Heartbeat stopped for ${name}`);
    }
    this.timers.clear();
  }

  async tick(agentDef: AgentDefinition, tenantId: string): Promise<void> {
    logger.info(`Heartbeat tick for tenant=${tenantId} agent=${agentDef.name}`);

    try {
      const consolidation = await this.memoryManager.consolidate(tenantId, agentDef.name);
      if (consolidation) {
        logger.info(`Memory consolidated for tenant=${tenantId} agent=${agentDef.name}`);
      }

      if (agentDef.config.evolution.enabled) {
        const reflections = await this.extractReflectionsFromMemory(tenantId, agentDef.name);

        if (reflections.length > 0) {
          logger.info(`Found ${reflections.length} reflections for tenant=${tenantId} agent=${agentDef.name}`);
          const proposals = await this.evolver.evolve(tenantId, agentDef, reflections);

          for (const proposal of proposals) {
            const autoApprove =
              !agentDef.config.evolution.requireApproval ||
              (proposal.type !== "soul_update" && proposal.confidence >= 0.85);

            if (autoApprove) {
              proposal.status = "approved";
              const applied = await this.applier.apply(proposal, agentDef);
              if (applied) {
                logger.info(`Auto-applied evolution proposal for tenant=${tenantId} agent=${agentDef.name}: ${proposal.description}`);
              }
            }
          }
        } else {
          logger.debug(`No reflections to process for tenant=${tenantId} agent=${agentDef.name}`);
        }
      }
    } catch (err) {
      logger.error(`Heartbeat error for tenant=${tenantId} agent=${agentDef.name}: ${err}`);
    }
  }

  private async extractReflectionsFromMemory(tenantId: string, agentName: string): Promise<Reflection[]> {
    const searchResults = await this.memoryManager.search(tenantId, agentName, "lesson reflection improvement");
    if (searchResults.length === 0) return [];

    const reflections: Reflection[] = [];

    for (const result of searchResults) {
      const lines = result.content.split("\n").filter((l) => l.trim());
      const lessons = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));

      if (lessons.length > 0) {
        reflections.push({
          timestamp: new Date().toISOString(),
          summary: `Extracted from memory: ${result.key}`,
          lessonsLearned: lessons,
          suggestedImprovements: [],
          confidence: Math.min(result.score / 10, 1),
        });
      }
    }

    return reflections;
  }

  getEvolver(): Evolver {
    return this.evolver;
  }

  getApplier(): ProposalApplier {
    return this.applier;
  }
}
