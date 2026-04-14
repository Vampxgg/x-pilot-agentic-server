import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { EvolutionProposal, AgentDefinition } from "../core/types.js";
import { logger } from "../utils/logger.js";

const DEFAULT_DATA_DIR = resolve(process.cwd(), "data");

export class ProposalApplier {
  private tenantDataPath(tenantId: string, agentName: string): string {
    return join(DEFAULT_DATA_DIR, "tenants", tenantId, "agents", agentName);
  }

  async apply(proposal: EvolutionProposal, agentDef: AgentDefinition): Promise<boolean> {
    if (proposal.status !== "approved") {
      logger.warn(`Cannot apply proposal ${proposal.id}: status is "${proposal.status}"`);
      return false;
    }

    try {
      switch (proposal.type) {
        case "soul_update":
          return this.applySoulUpdate(proposal, agentDef);
        case "new_skill":
          return this.applyNewSkill(proposal, agentDef);
        case "config_change":
          return this.applyConfigChange(proposal, agentDef);
        case "workflow_adjustment":
          return this.applyWorkflowAdjustment(proposal, agentDef);
        default:
          logger.warn(`Unknown proposal type: ${proposal.type}`);
          return false;
      }
    } catch (err) {
      logger.error(`Failed to apply proposal ${proposal.id}: ${err}`);
      return false;
    }
  }

  private async applySoulUpdate(proposal: EvolutionProposal, agentDef: AgentDefinition): Promise<boolean> {
    const dataDir = this.tenantDataPath(proposal.tenantId, agentDef.name);
    if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });

    const soulOverridePath = join(dataDir, "SOUL_OVERRIDE.md");
    await writeFile(soulOverridePath, proposal.diff, "utf-8");

    logger.info(`Soul override written for tenant=${proposal.tenantId} agent=${agentDef.name}`);
    proposal.status = "applied";
    return true;
  }

  private async applyNewSkill(proposal: EvolutionProposal, agentDef: AgentDefinition): Promise<boolean> {
    const skillsDir = join(this.tenantDataPath(proposal.tenantId, agentDef.name), "skills");
    if (!existsSync(skillsDir)) await mkdir(skillsDir, { recursive: true });

    const skillName = proposal.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);

    const skillPath = join(skillsDir, `${skillName}.md`);
    await writeFile(skillPath, proposal.diff, "utf-8");

    logger.info(`New skill created for tenant=${proposal.tenantId} agent=${agentDef.name}: ${skillPath}`);
    proposal.status = "applied";
    return true;
  }

  private async applyConfigChange(proposal: EvolutionProposal, agentDef: AgentDefinition): Promise<boolean> {
    const dataDir = this.tenantDataPath(proposal.tenantId, agentDef.name);
    if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });

    const configOverridePath = join(dataDir, "config_override.yaml");
    let existing: Record<string, unknown> = {};

    if (existsSync(configOverridePath)) {
      const raw = await readFile(configOverridePath, "utf-8");
      existing = parseYaml(raw) as Record<string, unknown>;
    }

    try {
      const changes = JSON.parse(proposal.diff);
      const merged = { ...existing, ...changes };
      await writeFile(configOverridePath, stringifyYaml(merged), "utf-8");
      logger.info(`Config override updated for tenant=${proposal.tenantId} agent=${agentDef.name}`);
      proposal.status = "applied";
      return true;
    } catch (err) {
      logger.error(`Failed to parse config change diff: ${err}`);
      return false;
    }
  }

  private async applyWorkflowAdjustment(proposal: EvolutionProposal, agentDef: AgentDefinition): Promise<boolean> {
    const memoryDir = join(this.tenantDataPath(proposal.tenantId, agentDef.name), "memory");
    if (!existsSync(memoryDir)) await mkdir(memoryDir, { recursive: true });

    const memoryPath = join(memoryDir, "MEMORY.md");
    const timestamp = new Date().toISOString().split("T")[0];
    const entry = `\n## Workflow Adjustment (${timestamp})\n${proposal.description}\n\n${proposal.diff}\n`;

    const existing = existsSync(memoryPath) ? await readFile(memoryPath, "utf-8") : "";
    await writeFile(memoryPath, existing + entry, "utf-8");

    logger.info(`Workflow adjustment recorded for tenant=${proposal.tenantId} agent=${agentDef.name}`);
    proposal.status = "applied";
    return true;
  }
}
