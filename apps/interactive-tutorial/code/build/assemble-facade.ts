import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PipelineHandlerContext } from "../../../../src/core/types.js";
import { workspaceManager } from "../../../../src/core/workspace.js";
import { logger } from "../../../../src/utils/logger.js";
import type { TutorialMeta } from "../types.js";
import { safeParseJSON } from "../blueprint-service.js";
import { emitSessionProgress } from "../session-events.js";
import { getTutorialPaths, tutorialPublicFileUrl } from "./paths.js";
import { resolvePublicBaseUrl } from "../../../../src/utils/public-url.js";
import { prepareSourceDir } from "./template-provision.js";
import { buildWithAIRepair } from "./repair-service.js";
import { assertAppShellReferencesExist, assertEditorConvergenceBeforeReassemble, buildHasConfigError } from "./validation-service.js";
import { recoverFilesFromCoderOutputs, syncWorkspaceFiles } from "./workspace-sync.js";
import type { AssembleJobHandle } from "./types.js";
import { captureScreenshot } from "../../../../src/services/screenshot-service.js";

const DIRECTOR_AGENT = "interactive-tutorial-director";

function writeProgress(sessionId: string, message: string, extra?: Record<string, unknown>): void {
  emitSessionProgress(sessionId, DIRECTOR_AGENT, { message, ...extra });
}

function stableEntryExists(distDir: string): boolean {
  return existsSync(join(distDir, "index.html"));
}

function clearDir(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function promoteCandidateBuild(distCandidateDir: string, distDir: string): void {
  if (!existsSync(distCandidateDir)) {
    throw new Error(`Candidate build directory missing: ${distCandidateDir}`);
  }

  const backupDir = `${distDir}-backup`;
  clearDir(backupDir);

  try {
    if (existsSync(distDir)) {
      renameSync(distDir, backupDir);
    }
    renameSync(distCandidateDir, distDir);
    clearDir(backupDir);
  } catch (err) {
    logger.error(`[assembleApp] Failed to promote candidate build: ${err}`);
    if (!existsSync(distDir) && existsSync(backupDir)) {
      renameSync(backupDir, distDir);
    }
    clearDir(distCandidateDir);
    throw err;
  }
}

function buildSuccessMeta(
  sessionId: string,
  title: string,
  url: string,
  previousMeta?: TutorialMeta | null,
  coverUrl?: string,
): TutorialMeta {
  const successAt = new Date().toISOString();
  return {
    tutorialId: sessionId,
    title,
    url,
    createdAt: previousMeta?.createdAt ?? successAt,
    lastBuildStatus: "success",
    lastSuccessfulBuildAt: successAt,
    coverUrl: coverUrl ?? previousMeta?.coverUrl,
  };
}

async function readTutorialMeta(
  tenantId: string,
  userId: string,
  sessionId: string,
): Promise<TutorialMeta | null> {
  const raw = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/tutorial-meta.json");
  const parsed = safeParseJSON(raw);
  if (!parsed) return null;

  const tutorialId = typeof parsed.tutorialId === "string" ? parsed.tutorialId : sessionId;
  const title = typeof parsed.title === "string" ? parsed.title : "互动教材";
  const url = typeof parsed.url === "string" ? parsed.url : tutorialPublicFileUrl(sessionId);
  const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString();
  const lastBuildStatus = parsed.lastBuildStatus === "failed" ? "failed" : "success";
  const lastSuccessfulBuildAt =
    typeof parsed.lastSuccessfulBuildAt === "string" ? parsed.lastSuccessfulBuildAt : undefined;
  const coverUrl = typeof parsed.coverUrl === "string" ? parsed.coverUrl : undefined;

  return { tutorialId, title, url, createdAt, lastBuildStatus, lastSuccessfulBuildAt, coverUrl };
}

function captureCoverAsync(
  sessionId: string,
  tutorialUrl: string,
  tenantId: string,
  userId: string,
  blueprint: Record<string, unknown> | null | undefined,
  meta: TutorialMeta,
): void {
  captureScreenshot({ url: tutorialUrl, sessionId })
    .then(async (result) => {
      const coverPublicUrl = `${resolvePublicBaseUrl()}/api/files/${result.publicPath}`;
      const updated = { ...meta, coverUrl: coverPublicUrl };
      await persistMeta(tenantId, userId, sessionId, blueprint, updated);
      emitSessionProgress(sessionId, DIRECTOR_AGENT, {
        message: "Cover screenshot captured",
        phase: "assemble",
        stage: "cover_ready",
        coverUrl: coverPublicUrl,
      });
    })
    .catch((err) => {
      logger.warn(`[assembleApp] Cover screenshot failed for session=${sessionId}: ${err}`);
    });
}

async function buildAndPromote(
  sourceDir: string,
  distCandidateDir: string,
  distDir: string,
  sessionId: string,
  hooks?: {
    onFirstSuccess?: (info: { round: number; elapsedMs: number }) => void;
    onRound?: (info: { round: number; success: boolean; elapsedMs: number }) => void;
  },
) {
  clearDir(distCandidateDir);

  const buildResult = await buildWithAIRepair(sourceDir, distCandidateDir, 3, { sessionId }, hooks);
  if (!buildResult.success) {
    clearDir(distCandidateDir);
    return buildResult;
  }

  promoteCandidateBuild(distCandidateDir, distDir);
  return buildResult;
}

async function persistMeta(
  tenantId: string,
  userId: string,
  sessionId: string,
  blueprint: Record<string, unknown> | null | undefined,
  meta: TutorialMeta,
): Promise<void> {
  await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/tutorial-meta.json", JSON.stringify(meta, null, 2));
  if (blueprint) {
    await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json", JSON.stringify(blueprint, null, 2));
  }
}

export async function assembleTutorial(ctx: PipelineHandlerContext): Promise<object> {
  const { tenantId, userId, sessionId } = ctx;
  if (!sessionId) throw new Error("assembleApp requires a sessionId");

  const assembleStart = Date.now();
  const timings: Record<string, number> = {};
  const wsBlueprint = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json");
  let blueprint = safeParseJSON(wsBlueprint);
  if (!blueprint) blueprint = safeParseJSON(ctx.previousResults.get("architect"));
  if (!blueprint) logger.warn("[assembleApp] Could not parse architect blueprint — proceeding with defaults");

  const { sourceDir, distDir, distCandidateDir } = getTutorialPaths(sessionId);
  logger.info(`[assembleApp] Starting: session=${sessionId}`);
  writeProgress(sessionId, "Preparing build environment", { phase: "assemble", stage: "prepare" });

  const prep = prepareSourceDir(sourceDir);
  timings["prepare-source"] = prep.elapsedMs;
  logger.info(`[assembleApp] prepareSourceDir mode=${prep.mode} elapsed=${prep.elapsedMs}ms`);

  const syncStart = Date.now();
  let syncedFiles = await syncWorkspaceFiles(tenantId, userId, sessionId, sourceDir);
  timings["sync-workspace"] = Date.now() - syncStart;
  logger.info(`[assembleApp] Synced ${syncedFiles.length} files from workspace in ${timings["sync-workspace"]}ms`);

  if (syncedFiles.length === 0) {
    syncedFiles = await recoverFilesFromCoderOutputs(ctx, sourceDir);
  }
  if (syncedFiles.length === 0) {
    const coderRaw = ctx.previousResults.get("code") ?? ctx.previousResults.get("coder");
    const snippet = coderRaw
      ? (typeof coderRaw === "string" ? coderRaw : JSON.stringify(coderRaw)).slice(0, 300)
      : "(no coder output)";
    throw new Error(`No files found — neither in workspace nor extractable from coder output. Coder result preview: ${snippet}`);
  }

  writeProgress(sessionId, `Building app with ${syncedFiles.length} files`, { phase: "assemble", stage: "build" });
  await assertAppShellReferencesExist(sourceDir, blueprint);

  const url = tutorialPublicFileUrl(sessionId);
  let firstSuccessRound: number | undefined;
  let firstSuccessElapsedMs: number | undefined;
  const buildStart = Date.now();
  const buildResult = await buildAndPromote(sourceDir, distCandidateDir, distDir, sessionId, {
    onFirstSuccess: ({ round, elapsedMs }) => {
      firstSuccessRound = round;
      firstSuccessElapsedMs = elapsedMs;
      timings["first-success-round"] = round;
      timings["first-success-build-ms"] = elapsedMs;
    },
    onRound: ({ round, success, elapsedMs }) => {
      logger.info(`[assembleApp] build round ${round} success=${success} elapsed=${elapsedMs}ms`);
    },
  });
  timings["build-total"] = Date.now() - buildStart;
  if (!buildResult.success) {
    throw new Error(`Build failed: ${buildResult.warnings.join("; ")}`);
  }

  const title = (blueprint?.title as string) || "互动教材";
  const previousMeta = await readTutorialMeta(tenantId, userId, sessionId);
  const meta = buildSuccessMeta(sessionId, title, url, previousMeta);
  await persistMeta(tenantId, userId, sessionId, blueprint, meta);

  // Fire-and-forget: capture cover screenshot after successful build
  captureCoverAsync(sessionId, url, tenantId, userId, blueprint, meta);

  const totalElapsed = Date.now() - assembleStart;
  timings["assemble-total"] = totalElapsed;
  try {
    await workspaceManager.writeArtifact(
      tenantId,
      userId,
      sessionId,
      "logs/assemble-metrics.json",
      JSON.stringify({ sessionId, timings, fileCount: syncedFiles.length, success: true }, null, 2),
    );
  } catch (err) {
    logger.warn(`[assembleApp] Failed to write metrics: ${err}`);
  }

  writeProgress(sessionId, "Final build complete", {
    phase: "assemble",
    stage: "final_ready",
    url,
    elapsedMs: totalElapsed,
  });
  writeProgress(sessionId, "Preview is ready", {
    phase: "assemble",
    stage: "preview_ready",
    url,
    round: firstSuccessRound,
    elapsedMs: firstSuccessElapsedMs,
  });

  return {
    ...meta,
    teachingGuide: blueprint?.teaching_guide,
    fileCount: syncedFiles.length,
    timings,
    warnings: buildResult.warnings.length > 0 ? buildResult.warnings : undefined,
    repairLog: buildResult.repairLog.length > 0 ? buildResult.repairLog : undefined,
  };
}

async function firstAssembly(tenantId: string, userId: string, sessionId: string): Promise<object> {
  const { sourceDir, distDir, distCandidateDir } = getTutorialPaths(sessionId);

  logger.info(`[firstAssembly] Building from scratch: session=${sessionId}`);
  const prep = prepareSourceDir(sourceDir);
  logger.info(`[firstAssembly] prepareSourceDir mode=${prep.mode} elapsed=${prep.elapsedMs}ms`);

  const syncedFiles = await syncWorkspaceFiles(tenantId, userId, sessionId, sourceDir);
  if (syncedFiles.length === 0) throw new Error("No files found in workspace — cannot build");

  const blueprint = safeParseJSON(await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json"));
  await assertAppShellReferencesExist(sourceDir, blueprint);

  const buildResult = await buildAndPromote(sourceDir, distCandidateDir, distDir, sessionId);
  if (!buildResult.success) {
    throw new Error(`${buildHasConfigError(buildResult.warnings) ? "[CONFIG ERROR] " : ""}Build failed: ${buildResult.warnings.join("; ")}`);
  }

  const previousMeta = await readTutorialMeta(tenantId, userId, sessionId);
  const meta = buildSuccessMeta(
    sessionId,
    (blueprint?.title as string) || "互动教材",
    tutorialPublicFileUrl(sessionId),
    previousMeta,
  );
  await persistMeta(tenantId, userId, sessionId, blueprint, meta);

  return {
    ...meta,
    fileCount: syncedFiles.length,
    warnings: buildResult.warnings.length > 0 ? buildResult.warnings : undefined,
  };
}

export async function reassembleTutorial(tenantId: string, userId: string, sessionId: string): Promise<object> {
  const { sourceDir, distDir, distCandidateDir } = getTutorialPaths(sessionId);
  if (!existsSync(sourceDir)) {
    logger.info(`[reassembleApp] No source dir for session=${sessionId}, falling back to full assembly`);
    return firstAssembly(tenantId, userId, sessionId);
  }

  await assertEditorConvergenceBeforeReassemble(tenantId, userId, sessionId);
  logger.info(`[reassembleApp] Re-syncing: session=${sessionId}`);
  const syncedFiles = await syncWorkspaceFiles(tenantId, userId, sessionId, sourceDir);
  logger.info(`[reassembleApp] Re-synced ${syncedFiles.length} files`);
  if (syncedFiles.length === 0) throw new Error("No files found after edit");

  const blueprint = safeParseJSON(await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json"));
  await assertAppShellReferencesExist(sourceDir, blueprint);

  const buildResult = await buildAndPromote(sourceDir, distCandidateDir, distDir, sessionId);
  if (!buildResult.success) {
    throw new Error(`${buildHasConfigError(buildResult.warnings) ? "[CONFIG ERROR] " : ""}Rebuild failed: ${buildResult.warnings.join("; ")}`);
  }

  const reassembleUrl = tutorialPublicFileUrl(sessionId);
  const previousMeta = await readTutorialMeta(tenantId, userId, sessionId);
  const meta = buildSuccessMeta(
    sessionId,
    (blueprint?.title as string) || "互动教材",
    reassembleUrl,
    previousMeta,
  );
  await persistMeta(tenantId, userId, sessionId, blueprint, meta);

  captureCoverAsync(sessionId, reassembleUrl, tenantId, userId, blueprint, meta);

  return {
    ...meta,
    fileCount: syncedFiles.length,
    warnings: buildResult.warnings.length > 0 ? buildResult.warnings : undefined,
  };
}

export async function runAssembleJob(job: AssembleJobHandle, ctx?: PipelineHandlerContext): Promise<object> {
  if (job.mode === "reassemble") {
    return reassembleTutorial(job.tenantId, job.userId, job.sessionId);
  }
  if (!ctx) {
    throw new Error("runAssembleJob requires pipeline context for assemble mode");
  }
  return assembleTutorial(ctx);
}
