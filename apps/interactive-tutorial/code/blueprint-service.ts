import type { PipelineHandlerContext } from "../../../src/core/types.js";
import { workspaceManager } from "../../../src/core/workspace.js";
import { logger } from "../../../src/utils/logger.js";

const FILE_NAME_RE = /^[A-Z][A-Za-z0-9]+\.tsx$/;

export function safeParseJSON(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;

  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  const jsonBlockMatch = raw.match(/```json\s*\n?([\s\S]*?)```/);
  if (jsonBlockMatch?.[1]) {
    try {
      return JSON.parse(jsonBlockMatch[1]);
    } catch {
      // continue
    }
  }

  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      // continue
    }
  }

  return null;
}

export function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function normalizeBlueprint(blueprint: Record<string, unknown>): { blueprint: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const components = blueprint.components;
  if (!Array.isArray(components)) return { blueprint, notes };

  const seen = new Set<string>();
  const cleaned: unknown[] = [];
  for (let i = 0; i < components.length; i++) {
    const item = components[i] as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") continue;

    let fileName = typeof item.file_name === "string" ? item.file_name.trim() : "";
    if (!fileName) {
      notes.push(`components[${i}] dropped: missing file_name`);
      continue;
    }
    if (!fileName.endsWith(".tsx")) fileName = fileName.replace(/\.tsx?$/i, "") + ".tsx";
    fileName = fileName.replace(/^[a-z]/, (char) => char.toUpperCase());
    if (!FILE_NAME_RE.test(fileName)) {
      notes.push(`components[${i}] dropped: invalid file_name "${item.file_name}"`);
      continue;
    }

    let unique = fileName;
    let suffix = 2;
    while (seen.has(unique)) {
      unique = fileName.replace(/\.tsx$/, `${suffix}.tsx`);
      suffix++;
    }
    if (unique !== fileName) notes.push(`components[${i}] renamed: ${fileName} -> ${unique} (duplicate)`);
    seen.add(unique);
    cleaned.push({ ...item, file_name: unique });
  }

  if (cleaned.length !== components.length) {
    notes.push(`components: ${components.length} -> ${cleaned.length} after normalization`);
  }
  blueprint.components = cleaned;
  return { blueprint, notes };
}

async function retryArchitectOnce(
  ctx: PipelineHandlerContext,
  originalArchitectRaw: unknown,
): Promise<Record<string, unknown> | null> {
  const { tenantId, userId, sessionId, context, initialInput } = ctx;
  if (!sessionId) return null;

  logger.warn(
    `[saveBlueprint] No usable blueprint after architect step (raw=${
      typeof originalArchitectRaw === "string" ? `${originalArchitectRaw.length}chars` : typeof originalArchitectRaw
    }) — attempting one inline architect re-invocation`,
  );

  const { agentRegistry } = await import("../../../src/core/agent-registry.js");
  const { agentRuntime } = await import("../../../src/core/agent-runtime.js");

  if (!agentRegistry.has("tutorial-scene-architect")) {
    logger.error("[saveBlueprint] tutorial-scene-architect not registered — cannot retry");
    return null;
  }

  const researchRaw = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/research.json");
  const previousResearch = ctx.previousResults.get("research");
  const fallbackResearchRaw =
    previousResearch == null
      ? ""
      : typeof previousResearch === "string"
        ? previousResearch
        : JSON.stringify(previousResearch, null, 2);
  const researchSource = researchRaw || fallbackResearchRaw;
  const researchExcerpt = researchSource
    ? `\n\n【Research Report】\n${researchSource.slice(0, 4000)}`
    : "";
  const retryBrief =
    `${initialInput}\n\n` +
    `【RETRY】Previous architect run did not produce a parseable blueprint nor write artifacts/blueprint.json. ` +
    `You MUST call workspace_write({name: "artifacts/blueprint.json", content: <stringified blueprint JSON>}) ` +
    `before declaring the task complete. The blueprint MUST follow the schema in your MISSION (title, components[], teaching_guide).` +
    researchExcerpt;

  try {
    await agentRuntime.invokeAgent("tutorial-scene-architect", retryBrief, {
      tenantId,
      userId,
      sessionId,
      context,
    });
  } catch (err) {
    logger.error(`[saveBlueprint] Architect retry threw: ${err}`);
    return null;
  }

  const retriedRaw = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json");
  if (!retriedRaw) return null;

  const parsed = safeParseJSON(retriedRaw);
  if (!parsed) {
    logger.error("[saveBlueprint] Architect retry produced no parseable blueprint either");
    return null;
  }

  const { blueprint, notes } = normalizeBlueprint(parsed);
  if (notes.length > 0) {
    logger.warn(`[saveBlueprint] Retry blueprint normalized: ${notes.join("; ")}`);
    await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json", JSON.stringify(blueprint, null, 2));
  }
  logger.info(`[saveBlueprint] Architect retry succeeded — blueprint recovered (${retriedRaw.length} chars)`);
  return blueprint;
}

export async function saveBlueprintHandler(ctx: PipelineHandlerContext): Promise<unknown> {
  const { tenantId, userId, sessionId } = ctx;
  if (!sessionId) throw new Error("saveBlueprint requires a sessionId");

  const existingRaw = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json");
  if (existingRaw) {
    const existing = safeParseJSON(existingRaw);
    if (existing) {
      const { blueprint, notes } = normalizeBlueprint(existing);
      if (notes.length > 0) {
        logger.warn(`[saveBlueprint] Normalized existing blueprint: ${notes.join("; ")}`);
        await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json", JSON.stringify(blueprint, null, 2));
      } else {
        logger.info(`[saveBlueprint] Using blueprint already in workspace (${existingRaw.length} chars)`);
      }
      return blueprint;
    }
  }

  const architectRaw = ctx.previousResults.get("architect");
  const parsed = safeParseJSON(architectRaw);
  if (parsed) {
    const { blueprint, notes } = normalizeBlueprint(parsed);
    if (notes.length > 0) logger.warn(`[saveBlueprint] Blueprint normalized: ${notes.join("; ")}`);
    const content = JSON.stringify(blueprint, null, 2);
    await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json", content);
    logger.info(`[saveBlueprint] Blueprint parsed from architect output and saved (${content.length} chars)`);
    return blueprint;
  }

  const retried = await retryArchitectOnce(ctx, architectRaw);
  if (retried) return retried;

  throw new Error(
    "[ARCHITECT FAILED] Blueprint generation failed after retry. Architect produced no parseable blueprint and did not write artifacts/blueprint.json. Manual intervention required.",
  );
}
