import { existsSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import PQueue from "p-queue";
import { logger } from "../../../../src/utils/logger.js";
import { deInlineComponents, parseBuildErrors, typeCheckProject, validateAllComponents } from "../validators.js";
import { formatBuildErrors, groupErrorsByFile, repairFile } from "../ai-repair.js";
import type { RepairRecord } from "../types.js";
import { cleanDeadImports } from "./validation-service.js";
import { runBuild } from "./compile-service.js";
import type { BuildHooks, BuildMeta, BuildRepairResult } from "./types.js";

const REPAIR_CONCURRENCY = Number(process.env.TUTORIAL_REPAIR_CONCURRENCY ?? 6);

function isReservedZoneFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.includes("/components/ui/") ||
    normalized.includes("/components/layout/") ||
    normalized.includes("/components/system/") ||
    normalized.includes("/components/theme-provider.tsx") ||
    normalized.includes("/components/theme-toggle.tsx") ||
    normalized.includes("/providers/") ||
    normalized.includes("/router/") ||
    normalized.includes("/runtime/") ||
    normalized.includes("/lib/") ||
    normalized.includes("/types/")
  );
}

function isRemovableUserFile(filePath: string): boolean {
  if (isReservedZoneFile(filePath)) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/components/") || normalized.includes("/pages/");
}

function summarizeBuildOutput(output: string, maxChars: number = 4000): string {
  const stripped = output.replace(/\u001b\[[0-9;]*m/g, "");
  if (stripped.length <= maxChars) return stripped.trim();
  return "…" + stripped.slice(stripped.length - maxChars).trim();
}

async function repairFilesInParallel(
  grouped: Map<string, ReturnType<typeof parseBuildErrors>>,
  round: number,
  warnings: string[],
  repairLog: RepairRecord[],
  options: { fallbackRemove?: boolean; tag: string },
): Promise<number> {
  const queue = new PQueue({ concurrency: REPAIR_CONCURRENCY });
  let repaired = 0;

  await Promise.all(
    Array.from(grouped.entries()).map(([file, errors]) =>
      queue.add(async () => {
        if (!existsSync(file) || isReservedZoneFile(file)) return;
        const errText = formatBuildErrors(errors);
        try {
          const sourceCode = await readFile(file, "utf-8");
          const result = await repairFile({ filePath: file, sourceCode, errors: errText });
          if (result.fixed && result.fixedCode) {
            await writeFile(file, result.fixedCode, "utf-8");
            repairLog.push({ round, filePath: file, fixed: true, originalErrors: errText });
            warnings.push(`[${options.tag}] AI repaired: ${file}`);
            repaired++;
          } else if (options.fallbackRemove && isRemovableUserFile(file)) {
            rmSync(file, { force: true });
            repairLog.push({ round, filePath: file, fixed: false, originalErrors: errText });
            warnings.push(`[${options.tag}] AI repair failed, removed: ${file}`);
          } else {
            repairLog.push({ round, filePath: file, fixed: false, originalErrors: errText });
            warnings.push(`[${options.tag}] AI repair failed for ${file} (kept)`);
          }
        } catch (err) {
          logger.error(`[buildWithAIRepair] Error during repair of ${file}: ${err}`);
          if (options.fallbackRemove && isRemovableUserFile(file)) {
            rmSync(file, { force: true });
            warnings.push(`[${options.tag}] Repair error, removed: ${file}`);
          }
        }
      }),
    ),
  );

  return repaired;
}

export async function buildWithAIRepair(
  sourceDir: string,
  distDir: string,
  maxRounds: number = 3,
  meta?: BuildMeta,
  hooks?: BuildHooks,
): Promise<BuildRepairResult> {
  const warnings: string[] = [];
  const repairLog: RepairRecord[] = [];
  const componentsDir = join(sourceDir, "src", "components");
  const appFile = join(sourceDir, "src", "App.tsx");

  const validationErrors = await validateAllComponents(componentsDir);
  if (validationErrors.length > 0) {
    logger.info(`[buildWithAIRepair] Static validation: ${validationErrors.length} component(s) need attention`);
    const queue = new PQueue({ concurrency: REPAIR_CONCURRENCY });
    await Promise.all(
      validationErrors.map((ve) =>
        queue.add(async () => {
          const errSummary = ve.errors.join("; ");
          let repaired = false;
          if (existsSync(ve.file)) {
            try {
              const sourceCode = await readFile(ve.file, "utf-8");
              const result = await repairFile({ filePath: ve.file, sourceCode, errors: errSummary });
              if (result.fixed && result.fixedCode) {
                await writeFile(ve.file, result.fixedCode, "utf-8");
                repairLog.push({ round: 0, filePath: ve.file, fixed: true, originalErrors: errSummary });
                warnings.push(`AI repaired validation error: ${ve.file}`);
                repaired = true;
              }
            } catch (err) {
              logger.warn(`[buildWithAIRepair] AI repair threw for ${ve.file}: ${err}`);
            }
          }
          if (!repaired) {
            if (isRemovableUserFile(ve.file) && existsSync(ve.file)) {
              rmSync(ve.file, { force: true });
              repairLog.push({ round: 0, filePath: ve.file, fixed: false, originalErrors: errSummary });
              warnings.push(`AI repair failed, removed: ${ve.file} — ${errSummary}`);
              logger.warn(`[buildWithAIRepair] Removed invalid component: ${ve.file}`);
            } else {
              repairLog.push({ round: 0, filePath: ve.file, fixed: false, originalErrors: errSummary });
              warnings.push(`AI repair failed for reserved file: ${ve.file} — ${errSummary} (kept)`);
            }
          }
        }),
      ),
    );
  }

  const pagesDir = join(sourceDir, "src", "pages");
  const deInlined = await deInlineComponents(pagesDir, componentsDir);
  if (deInlined > 0) {
    warnings.push(`De-inlined ${deInlined} component(s) from page files (replaced with imports)`);
    logger.warn(`[buildWithAIRepair] De-inlined ${deInlined} component(s) — single coder should not produce these`);
  }

  const deadRemoved = await cleanDeadImports(appFile, sourceDir);
  if (deadRemoved > 0) warnings.push(`Removed ${deadRemoved} dead import(s) from App.tsx and page files`);

  let firstSuccessReported = false;
  for (let round = 1; round <= maxRounds; round++) {
    const buildStart = Date.now();
    const result = await runBuild(sourceDir, distDir, meta);
    const buildElapsed = Date.now() - buildStart;
    hooks?.onRound?.({ round, success: result.success, errorCount: 0, elapsedMs: buildElapsed });
    if (result.success) {
      logger.info(`[buildWithAIRepair] Build succeeded on round ${round} (${buildElapsed}ms)`);
      if (!firstSuccessReported) {
        firstSuccessReported = true;
        hooks?.onFirstSuccess?.({ round, elapsedMs: buildElapsed });
      }
      return { success: true, warnings, repairLog };
    }

    const buildErrors = parseBuildErrors(result.output);
    logger.warn(`[buildWithAIRepair] Build failed round ${round}/${maxRounds}: ${buildErrors.length} parsed error(s) in ${buildElapsed}ms`);
    if (buildErrors.length === 0) {
      warnings.push(`Build failed with unparseable errors (round ${round}):\n${summarizeBuildOutput(result.output)}`);
      break;
    }

    const repairable = buildErrors.filter((error) => error.file !== "<vite>" && existsSync(error.file));
    if (repairable.length === 0) {
      const deadCleaned = await cleanDeadImports(appFile, sourceDir);
      if (deadCleaned > 0) {
        warnings.push(`Cleaned ${deadCleaned} dead import(s) after component removal (round ${round}), retrying...`);
        continue;
      }
      warnings.push(
        `[CONFIG ERROR] Build failure looks like a vite/rollup configuration issue, not user-component code (round ${round}). Manual intervention required.\n${summarizeBuildOutput(result.output)}`,
      );
      break;
    }

    const grouped = groupErrorsByFile(repairable);
    const anyRepaired = await repairFilesInParallel(grouped, round, warnings, repairLog, {
      fallbackRemove: true,
      tag: `Round ${round}`,
    });
    await cleanDeadImports(appFile, sourceDir);
    if (anyRepaired === 0) {
      warnings.push(`No files repaired in round ${round}, stopping`);
      break;
    }
  }

  try {
    logger.info("[buildWithAIRepair] Vite repair rounds exhausted, trying tsc fallback");
    const tscErrors = await typeCheckProject(sourceDir);
    if (tscErrors.length > 0) {
      const grouped = groupErrorsByFile(tscErrors);
      logger.info(`[buildWithAIRepair] tsc fallback: ${tscErrors.length} error(s) across ${grouped.size} file(s)`);
      const repaired = await repairFilesInParallel(grouped, maxRounds + 1, warnings, repairLog, {
        fallbackRemove: false,
        tag: "tsc-fallback",
      });
      if (repaired > 0) await cleanDeadImports(appFile, sourceDir);
    }
  } catch (err) {
    logger.warn(`[buildWithAIRepair] tsc fallback skipped: ${err}`);
  }

  const finalStart = Date.now();
  const finalResult = await runBuild(sourceDir, distDir, meta);
  const finalElapsed = Date.now() - finalStart;
  hooks?.onRound?.({ round: maxRounds + 1, success: finalResult.success, errorCount: 0, elapsedMs: finalElapsed });
  if (finalResult.success) {
    logger.info(`[buildWithAIRepair] Final build succeeded after tsc fallback (${finalElapsed}ms)`);
    if (!firstSuccessReported) hooks?.onFirstSuccess?.({ round: maxRounds + 1, elapsedMs: finalElapsed });
    return { success: true, warnings, repairLog };
  }

  warnings.push(`Build failed after all repair rounds:\n${summarizeBuildOutput(finalResult.output)}`);
  return { success: false, warnings, repairLog };
}
