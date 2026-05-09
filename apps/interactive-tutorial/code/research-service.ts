import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PipelineHandlerContext } from "../../../src/core/types.js";
import { workspaceManager } from "../../../src/core/workspace.js";
import { logger } from "../../../src/utils/logger.js";
import { emitSessionProgress } from "./session-events.js";

const RESEARCH_CACHE_DIR = resolve(process.cwd(), "data", "cache", "research");
const RESEARCH_CACHE_TTL_MS = Number(process.env.TUTORIAL_RESEARCH_CACHE_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);

interface ResearchCacheEntry {
  key: string;
  topic: string;
  databaseId?: string;
  result: unknown;
  storedAt: string;
  hitCount: number;
}

function normalizeTopic(topic: string): string {
  return topic
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/[，。！？；：、""''「」『』（）()【】《》<>!?,.;:'"`]/g, "")
    .trim();
}

function userFilesFingerprint(userFiles: unknown): string {
  if (!Array.isArray(userFiles)) return "none";
  return userFiles
    .map((file) => {
      const f = file as Record<string, unknown>;
      return [
        typeof f.fileId === "string" ? f.fileId : "unknown",
        typeof f.textChars === "number" ? f.textChars : "na",
        f.unreadable === true ? "u" : "r",
      ].join(":");
    })
    .sort()
    .join("|") || "none";
}

function researchCacheKey(topic: string, databaseId?: string, fileFingerprint = "none"): string {
  const seed = `${normalizeTopic(topic)}::${databaseId ?? "none"}::${fileFingerprint}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

async function readResearchCache(key: string): Promise<ResearchCacheEntry | null> {
  const file = join(RESEARCH_CACHE_DIR, `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, "utf-8");
    const entry = JSON.parse(raw) as ResearchCacheEntry;
    const ageMs = Date.now() - new Date(entry.storedAt).getTime();
    if (ageMs > RESEARCH_CACHE_TTL_MS) {
      logger.info(`[research-cache] entry ${key} expired (${Math.round(ageMs / 86_400_000)}d old)`);
      return null;
    }
    return entry;
  } catch (err) {
    logger.warn(`[research-cache] failed to read ${key}: ${err}`);
    return null;
  }
}

async function writeResearchCache(entry: ResearchCacheEntry): Promise<void> {
  try {
    mkdirSync(RESEARCH_CACHE_DIR, { recursive: true });
    await writeFile(join(RESEARCH_CACHE_DIR, `${entry.key}.json`), JSON.stringify(entry, null, 2), "utf-8");
  } catch (err) {
    logger.warn(`[research-cache] failed to write ${entry.key}: ${err}`);
  }
}

export async function researchWithCacheHandler(ctx: PipelineHandlerContext): Promise<unknown> {
  const { tenantId, userId, sessionId, context, initialInput } = ctx;
  const topic = (context?.topic as string | undefined) ?? (context?.generationBrief as string | undefined) ?? initialInput.slice(0, 200);
  const databaseId = context?.databaseId as string | undefined;
  const fileFingerprint = userFilesFingerprint(context?.userFiles);
  const key = researchCacheKey(topic, databaseId, fileFingerprint);

  const cached = await readResearchCache(key);
  if (cached) {
    logger.info(`[research-cache] HIT key=${key} topic="${topic.slice(0, 40)}" age=${Math.round((Date.now() - new Date(cached.storedAt).getTime()) / 1000)}s`);
    cached.hitCount = (cached.hitCount ?? 0) + 1;
    await writeResearchCache(cached);
    if (sessionId) {
      const payload = typeof cached.result === "string" ? cached.result : JSON.stringify(cached.result, null, 2);
      try {
        await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/research.json", payload);
      } catch (err) {
        logger.warn(`[research-cache] failed to seed workspace: ${err}`);
      }
      emitSessionProgress(sessionId, "tutorial-content-researcher", {
        message: "Research cache hit",
        phase: "research",
        stage: "cache_hit",
        key,
      });
    }
    return cached.result;
  }

  logger.info(`[research-cache] MISS key=${key} topic="${topic.slice(0, 40)}" — invoking researcher`);
  const { agentRegistry } = await import("../../../src/core/agent-registry.js");
  const { agentRuntime } = await import("../../../src/core/agent-runtime.js");

  if (!agentRegistry.has("tutorial-content-researcher")) {
    logger.warn("[research-cache] researcher agent not registered, skipping (optional step)");
    return null;
  }

  const briefHeader = ctx.previousResults.size > 0
    ? `${initialInput}\n\n【Context from Previous Steps】\n${Array.from(ctx.previousResults.entries())
        .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200)}`)
        .join("\n")}`
    : initialInput;

  const result = await agentRuntime.invokeAgent("tutorial-content-researcher", briefHeader, {
    tenantId,
    userId,
    sessionId,
    context,
  });

  const extracted = (result as { taskResult?: { output?: unknown }; output?: unknown }).taskResult?.output
    ?? (result as { output?: unknown }).output
    ?? result;

  if (sessionId) {
    const payload = typeof extracted === "string" ? extracted : JSON.stringify(extracted, null, 2);
    try {
      await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/research.json", payload);
    } catch (err) {
      logger.warn(`[research-cache] failed to persist live research to workspace: ${err}`);
    }
  }

  await writeResearchCache({
    key,
    topic,
    databaseId,
    result: extracted,
    storedAt: new Date().toISOString(),
    hitCount: 0,
  });

  return extracted;
}
