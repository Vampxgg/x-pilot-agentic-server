import type { SkillDefinition } from "../core/types.js";
import { logger } from "../utils/logger.js";

class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
    logger.info(`Skill registered: ${skill.name}`);
  }

  registerMany(skills: SkillDefinition[]): void {
    for (const skill of skills) this.register(skill);
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  getAll(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  remove(name: string): boolean {
    return this.skills.delete(name);
  }

  listNames(): string[] {
    return Array.from(this.skills.keys());
  }
}

export const skillRegistry = new SkillRegistry();
