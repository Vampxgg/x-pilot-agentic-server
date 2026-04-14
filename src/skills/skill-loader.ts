import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readMarkdownContent } from "../utils/md-parser.js";
import type { SkillDefinition } from "../core/types.js";
import { logger } from "../utils/logger.js";

export async function loadSkillsFromDir(skillsDir: string): Promise<SkillDefinition[]> {
  if (!existsSync(skillsDir)) return [];

  const entries = await readdir(skillsDir);
  const skills: SkillDefinition[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const filePath = join(skillsDir, entry);
    const content = await readMarkdownContent(filePath);
    if (!content) continue;

    const firstLine = content.split("\n")[0] ?? "";
    const name = entry.replace(".md", "");

    skills.push({
      name,
      description: firstLine.replace(/^#\s*/, "").trim() || name,
      content,
      filePath,
    });

    logger.debug(`Loaded skill: ${name} from ${filePath}`);
  }

  return skills;
}

export function formatSkillsForPrompt(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "";

  const sections = skills.map(
    (s) => `### Skill: ${s.name}\n${s.description}\n\n${s.content}`,
  );

  return `## Available Skills\n\n${sections.join("\n\n---\n\n")}`;
}
