import type { PipelineHandlerContext } from "../../../src/core/types.js";
import { saveBlueprintHandler } from "./blueprint-service.js";
import { researchWithCacheHandler } from "./research-service.js";
import { assembleTutorial, reassembleTutorial } from "./build/assemble-facade.js";

export async function saveBlueprint(ctx: PipelineHandlerContext): Promise<unknown> {
  return saveBlueprintHandler(ctx);
}

export async function assembleApp(ctx: PipelineHandlerContext): Promise<object> {
  return assembleTutorial(ctx);
}

export async function reassembleForSession(
  tenantId: string,
  userId: string,
  sessionId: string,
): Promise<object> {
  return reassembleTutorial(tenantId, userId, sessionId);
}

export async function reassembleApp(ctx: PipelineHandlerContext): Promise<object> {
  const { tenantId, userId, sessionId } = ctx;
  if (!sessionId) throw new Error("reassembleApp requires a sessionId");
  return reassembleTutorial(tenantId, userId, sessionId);
}

export async function researchWithCache(ctx: PipelineHandlerContext): Promise<unknown> {
  return researchWithCacheHandler(ctx);
}
