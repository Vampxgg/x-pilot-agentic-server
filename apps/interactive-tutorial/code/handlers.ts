import { existsSync, cpSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { PipelineHandlerContext } from "../../../src/core/types.js";
import { workspaceManager } from "../../../src/core/workspace.js";
import { logger } from "../../../src/utils/logger.js";
import { validateAllComponents, removeDeadImports, parseBuildErrors, typeCheckProject } from "./validators.js";
import { repairFile, groupErrorsByFile, formatBuildErrors } from "./ai-repair.js";
import type { TutorialMeta, RepairRecord } from "./types.js";

const execAsync = promisify(exec);

const TEMPLATE_DIR = resolve(process.cwd(), "..", "react-code-rander");
const TUTORIALS_DIR = resolve(process.cwd(), "data", "tutorials");

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", "components"]);

function excludeFilter(src: string): boolean {
  const parts = src.replace(/\\/g, "/").split("/");
  return !parts.some((p) => EXCLUDE_DIRS.has(p));
}

async function syncAppFiles(
  tenantId: string,
  userId: string,
  sessionId: string,
  sourceDir: string,
): Promise<string[]> {
  const wsPath = workspaceManager.getPath(tenantId, userId, sessionId);
  const synced: string[] = [];

  // 1. Sync App.tsx
  const wsAppFile = join(wsPath, "assets", "App.tsx");
  if (existsSync(wsAppFile)) {
    let content = await readFile(wsAppFile, "utf-8");
    if (!content.includes("\n") && content.includes("\\n")) {
      content = content.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
    }
    await writeFile(join(sourceDir, "src", "App.tsx"), content, "utf-8");
    synced.push("App.tsx");
  }

  // 2. Sync components/
  const componentsTarget = join(sourceDir, "src", "components");
  if (existsSync(componentsTarget)) {
    rmSync(componentsTarget, { recursive: true, force: true });
  }
  mkdirSync(componentsTarget, { recursive: true });

  const wsComponents = join(wsPath, "assets", "components");
  if (existsSync(wsComponents)) {
    async function copyDir(src: string, dest: string): Promise<void> {
      const entries = await readdir(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
          await mkdir(destPath, { recursive: true });
          await copyDir(srcPath, destPath);
        } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
          let content = await readFile(srcPath, "utf-8");
          if (!content.includes("\n") && content.includes("\\n")) {
            content = content.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
          }
          await writeFile(destPath, content, "utf-8");
          synced.push("components/" + relative(componentsTarget, destPath));
        }
      }
    }
    await copyDir(wsComponents, componentsTarget);
  }

  return synced;
}

interface BuildMeta {
  sessionId: string;
}

async function injectTutorialMeta(sourceDir: string, meta: BuildMeta | undefined): Promise<void> {
  if (!meta) return;
  const metaContent = `export const TUTORIAL_META = ${JSON.stringify({
    sessionId: meta.sessionId,
    apiBase: "",
  }, null, 2)};\n\nif (typeof window !== "undefined") {\n  (window as any).__TUTORIAL_META__ = TUTORIAL_META;\n}\n`;
  await writeFile(join(sourceDir, "src", "tutorial-meta.ts"), metaContent, "utf-8");

  // Ensure main.tsx imports the meta file (idempotent)
  const mainPath = join(sourceDir, "src", "main.tsx");
  if (existsSync(mainPath)) {
    const mainContent = await readFile(mainPath, "utf-8");
    if (!mainContent.includes("tutorial-meta")) {
      const patched = `import './tutorial-meta'\n${mainContent}`;
      await writeFile(mainPath, patched, "utf-8");
    }
  }
}

async function runBuild(
  sourceDir: string,
  distDir: string,
  meta?: BuildMeta,
): Promise<{ success: boolean; output: string }> {
  try {
    await injectTutorialMeta(sourceDir, meta);

    const viteBin = join(TEMPLATE_DIR, "node_modules", ".bin", "vite.cmd");
    const viteCmd = existsSync(viteBin)
      ? `"${viteBin}" build --outDir "${distDir}" --minify false`
      : `npx vite build --outDir "${distDir}" --minify false`;

    const { stdout, stderr } = await execAsync(viteCmd, {
      cwd: sourceDir,
      timeout: 120_000,
      env: { ...process.env, NODE_ENV: "production" },
    });

    const output = (stdout || "") + "\n" + (stderr || "");
    const success = existsSync(join(distDir, "index.html"));
    return { success, output };
  } catch (err: any) {
    const output = (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + (err.message || "");
    return { success: false, output };
  }
}

async function collectComponentFiles(componentsDir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name));
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        files.push(relative(componentsDir, join(dir, entry.name)).replace(/\\/g, "/"));
      }
    }
  }
  await walk(componentsDir);
  return files;
}

async function cleanDeadImports(appFile: string, componentsDir: string): Promise<number> {
  if (!existsSync(appFile) || !existsSync(componentsDir)) return 0;
  const existing = await collectComponentFiles(componentsDir);
  return removeDeadImports(appFile, existing);
}

async function buildWithAIRepair(
  sourceDir: string,
  distDir: string,
  maxRounds: number = 3,
  meta?: BuildMeta,
): Promise<{ success: boolean; warnings: string[]; repairLog: RepairRecord[] }> {
  const warnings: string[] = [];
  const repairLog: RepairRecord[] = [];
  const componentsDir = join(sourceDir, "src", "components");
  const appFile = join(sourceDir, "src", "App.tsx");

  // Stage 1: Static validation — attempt AI repair before falling back to deletion
  const validationErrors = await validateAllComponents(componentsDir);
  if (validationErrors.length > 0) {
    for (const ve of validationErrors) {
      const errSummary = ve.errors.join("; ");
      logger.info(`[buildWithAIRepair] Validation error in ${ve.file}, attempting AI repair`);

      let repaired = false;
      if (existsSync(ve.file)) {
        try {
          const sourceCode = await readFile(ve.file, "utf-8");
          const result = await repairFile({
            filePath: ve.file,
            sourceCode,
            errors: errSummary,
          });
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
        if (existsSync(ve.file)) rmSync(ve.file, { force: true });
        repairLog.push({ round: 0, filePath: ve.file, fixed: false, originalErrors: errSummary });
        warnings.push(`AI repair failed, removed: ${ve.file} — ${errSummary}`);
        logger.warn(`[buildWithAIRepair] Removed invalid component: ${ve.file}`);
      }
    }
  }

  // Stage 1.5: TypeScript type-check before build
  try {
    const tscErrors = await typeCheckProject(sourceDir);
    if (tscErrors.length > 0) {
      logger.info(`[buildWithAIRepair] TypeScript pre-check found ${tscErrors.length} error(s)`);
      const grouped = groupErrorsByFile(tscErrors);

      for (const [file, errors] of grouped) {
        if (!existsSync(file)) continue;

        const errText = formatBuildErrors(errors);
        try {
          const sourceCode = await readFile(file, "utf-8");
          const result = await repairFile({ filePath: file, sourceCode, errors: errText });
          if (result.fixed && result.fixedCode) {
            await writeFile(file, result.fixedCode, "utf-8");
            repairLog.push({ round: 0, filePath: file, fixed: true, originalErrors: errText });
            warnings.push(`AI repaired tsc error: ${file}`);
          } else {
            repairLog.push({ round: 0, filePath: file, fixed: false, originalErrors: errText });
            warnings.push(`AI could not repair tsc error in ${file}`);
          }
        } catch (err) {
          logger.warn(`[buildWithAIRepair] tsc repair threw for ${file}: ${err}`);
        }
      }
    }
  } catch (err) {
    logger.warn(`[buildWithAIRepair] TypeScript pre-check skipped: ${err}`);
  }

  // Stage 1.8: Clean dead imports from App.tsx
  const deadRemoved = await cleanDeadImports(appFile, componentsDir);
  if (deadRemoved > 0) {
    warnings.push(`Removed ${deadRemoved} dead import(s) from App.tsx`);
  }

  // Stage 2: Build with AI repair loop
  for (let round = 1; round <= maxRounds; round++) {
    const result = await runBuild(sourceDir, distDir, meta);
    if (result.success) {
      logger.info(`[buildWithAIRepair] Build succeeded on round ${round}`);
      return { success: true, warnings, repairLog };
    }

    const buildErrors = parseBuildErrors(result.output);
    logger.warn(`[buildWithAIRepair] Build failed (round ${round}/${maxRounds}): ${buildErrors.length} error(s)`);

    if (buildErrors.length === 0) {
      warnings.push(`Build failed with unparseable errors (round ${round}): ${result.output.slice(0, 500)}`);
      break;
    }

    if (round > maxRounds) break;

    const grouped = groupErrorsByFile(buildErrors);
    let anyRepaired = false;

    for (const [file, errors] of grouped) {
      if (!existsSync(file)) continue;

      const errText = formatBuildErrors(errors);
      try {
        const sourceCode = await readFile(file, "utf-8");
        const repairResult = await repairFile({
          filePath: file,
          sourceCode,
          errors: errText,
        });

        if (repairResult.fixed && repairResult.fixedCode) {
          await writeFile(file, repairResult.fixedCode, "utf-8");
          repairLog.push({ round, filePath: file, fixed: true, originalErrors: errText });
          warnings.push(`[Round ${round}] AI repaired: ${file}`);
          anyRepaired = true;
        } else {
          // Fallback: remove component files that can't be repaired (never remove App.tsx)
          if (file.includes("components")) {
            rmSync(file, { force: true });
            repairLog.push({ round, filePath: file, fixed: false, originalErrors: errText });
            warnings.push(`[Round ${round}] AI repair failed, removed: ${file}`);
          } else {
            repairLog.push({ round, filePath: file, fixed: false, originalErrors: errText });
            warnings.push(`[Round ${round}] AI repair failed for ${file} (kept)`);
          }
        }
      } catch (err) {
        logger.error(`[buildWithAIRepair] Error during repair of ${file}: ${err}`);
        if (file.includes("components")) {
          rmSync(file, { force: true });
          warnings.push(`[Round ${round}] Repair error, removed: ${file}`);
        }
      }
    }

    // Re-clean dead imports after changes
    await cleanDeadImports(appFile, componentsDir);

    if (!anyRepaired) {
      warnings.push(`No files repaired in round ${round}, stopping`);
      break;
    }
  }

  // Final build attempt
  const finalResult = await runBuild(sourceDir, distDir, meta);
  if (finalResult.success) {
    logger.info("[buildWithAIRepair] Final build succeeded after repair rounds");
    return { success: true, warnings, repairLog };
  }

  warnings.push(`Build failed after all repair rounds: ${finalResult.output.slice(0, 500)}`);
  return { success: false, warnings, repairLog };
}

/**
 * Pipeline handler: ensure blueprint.json is valid JSON in workspace.
 */
export async function saveBlueprint(ctx: PipelineHandlerContext): Promise<unknown> {
  const { tenantId, userId, sessionId } = ctx;
  if (!sessionId) throw new Error("saveBlueprint requires a sessionId");

  const existingRaw = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json");
  if (existingRaw) {
    const existing = safeParseJSON(existingRaw);
    if (existing) {
      logger.info(`[saveBlueprint] Using blueprint already in workspace (${existingRaw.length} chars)`);
      return existing;
    }
  }

  const architectRaw = ctx.previousResults.get("architect");
  const blueprint = safeParseJSON(architectRaw);

  if (blueprint) {
    const content = JSON.stringify(blueprint, null, 2);
    await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json", content);
    logger.info(`[saveBlueprint] Blueprint parsed from architect output and saved (${content.length} chars)`);
    return blueprint;
  }

  if (architectRaw) {
    const raw = typeof architectRaw === "string" ? architectRaw : JSON.stringify(architectRaw);
    await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json", raw);
    logger.warn(`[saveBlueprint] Could not parse as JSON, saved raw architect output (${raw.length} chars)`);
    return architectRaw;
  }

  logger.error("[saveBlueprint] No architect output found in pipeline results");
  return null;
}

function inferFilePathFromCode(code: string): string | null {
  const defaultExport = code.match(/export\s+default\s+function\s+([A-Z]\w*)/);
  if (defaultExport) return `components/${defaultExport[1]}.tsx`;

  const namedExport = code.match(/export\s+function\s+([A-Z]\w*)/);
  if (namedExport) return `components/${namedExport[1]}.tsx`;

  const constExport = code.match(/export\s+(?:default\s+)?(?:const|let)\s+([A-Z]\w*)/);
  if (constExport) return `components/${constExport[1]}.tsx`;

  return null;
}

function extractCodeBlocks(text: string): Array<{ filePath: string; code: string }> {
  const results: Array<{ filePath: string; code: string }> = [];
  const seenPaths = new Set<string>();

  const codeBlockRegex = /```(?:tsx|typescript)\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const code = match[1]!.trim();
    if (!code.includes("export default") && !code.includes("export function") && !code.includes("export const")) continue;

    const beforeBlock = text.slice(Math.max(0, match.index - 300), match.index);
    const fileHint = beforeBlock.match(/(?:\/\/\s*(?:file|path|文件)[:\s]+)(\S+\.tsx?)/)
      || beforeBlock.match(/[`"]([^`"]*\.tsx?)[`"]/)
      || beforeBlock.match(/#+\s+.*?(\S+\.tsx?)/)
      || beforeBlock.match(/(\w+\.tsx?)\s*$/);

    let filePath: string | null = null;
    if (fileHint) {
      filePath = fileHint[1]!
        .replace(/^(?:assets\/|src\/)/,  "")
        .replace(/^(?:components\/)/,  "components/");
    }

    if (!filePath) {
      if (code.match(/^(?:import|\/\/)[\s\S]*?function\s+App\b/) || code.includes("export default function App")) {
        filePath = "App.tsx";
      } else {
        filePath = inferFilePathFromCode(code);
      }
    }

    if (filePath && !seenPaths.has(filePath)) {
      seenPaths.add(filePath);
      results.push({ filePath, code });
    }
  }

  const fileMarkerRegex = /(?:\/\/\s*(?:file|path|文件)[:\s]+)(\S+\.tsx?)\s*\n([\s\S]*?)(?=(?:\/\/\s*(?:file|path|文件)[:\s]+\S+\.tsx?)|$)/gi;
  while ((match = fileMarkerRegex.exec(text)) !== null) {
    const filePath = match[1]!.replace(/^(?:assets\/|src\/)/, "");
    const code = match[2]!.trim();
    if ((code.includes("export default") || code.includes("export function") || code.includes("export const")) && !seenPaths.has(filePath)) {
      seenPaths.add(filePath);
      results.push({ filePath, code });
    }
  }

  return results;
}

function safeParseJSON(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;

  try { return JSON.parse(raw); } catch { /* continue */ }

  const jsonBlockMatch = (raw as string).match(/```json\s*\n?([\s\S]*?)```/);
  if (jsonBlockMatch?.[1]) {
    try { return JSON.parse(jsonBlockMatch[1]); } catch { /* continue */ }
  }

  const braceMatch = (raw as string).match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch { /* continue */ }
  }

  return null;
}

export async function assembleApp(ctx: PipelineHandlerContext): Promise<object> {
  const { tenantId, userId, sessionId } = ctx;
  if (!sessionId) throw new Error("assembleApp requires a sessionId");

  const wsBlueprint = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json");
  let blueprint = safeParseJSON(wsBlueprint);
  if (!blueprint) {
    const pipelineRaw = ctx.previousResults.get("architect");
    blueprint = safeParseJSON(pipelineRaw);
  }
  if (!blueprint) {
    logger.warn("[assembleApp] Could not parse architect blueprint — proceeding with defaults");
  }
  const sourceDir = join(TUTORIALS_DIR, sessionId, "source");
  const distDir = join(TUTORIALS_DIR, sessionId, "dist");

  logger.info(`[assembleApp] Starting: session=${sessionId}`);

  // 1. Copy template (exclude node_modules, .git, dist, components)
  mkdirSync(sourceDir, { recursive: true });
  cpSync(TEMPLATE_DIR, sourceDir, { recursive: true, filter: excludeFilter });

  // Prepare fresh components dir
  const componentsDir = join(sourceDir, "src", "components");
  if (existsSync(componentsDir)) rmSync(componentsDir, { recursive: true, force: true });
  mkdirSync(componentsDir, { recursive: true });

  // 2. Symlink node_modules from template
  const templateModules = join(TEMPLATE_DIR, "node_modules");
  const targetModules = join(sourceDir, "node_modules");
  if (existsSync(templateModules) && !existsSync(targetModules)) {
    try {
      symlinkSync(templateModules, targetModules, "junction");
    } catch {
      logger.warn("[assembleApp] Symlink failed, copying node_modules (slow path)");
      cpSync(templateModules, targetModules, { recursive: true });
    }
  }

  // 3. Sync AI-generated files from workspace (App.tsx + components/)
  let syncedFiles = await syncAppFiles(tenantId, userId, sessionId, sourceDir);
  logger.info(`[assembleApp] Synced ${syncedFiles.length} files from workspace`);

  // 3b. Fallback: extract code blocks from coder's raw LLM output or pipeline result
  if (syncedFiles.length === 0) {
    logger.warn("[assembleApp] No files in workspace — attempting to extract from coder output");

    const candidateTexts: string[] = [];

    const rawCoderOutput = await workspaceManager.readArtifact(tenantId, userId, sessionId, "logs/tutorial-scene-coder-raw-output.txt");
    if (rawCoderOutput) {
      logger.info(`[assembleApp] Found raw coder output in workspace (${rawCoderOutput.length} chars)`);
      candidateTexts.push(rawCoderOutput);
    }

    const coderRaw = ctx.previousResults.get("coder");
    if (coderRaw) {
      const coderText = typeof coderRaw === "string" ? coderRaw : JSON.stringify(coderRaw, null, 2);
      candidateTexts.push(coderText);
    }

    for (const text of candidateTexts) {
      const extracted = extractCodeBlocks(text);
      if (extracted.length > 0) {
        for (const { filePath, code } of extracted) {
          if (filePath === "App.tsx") {
            const appPath = join(sourceDir, "src", "App.tsx");
            await writeFile(appPath, code, "utf-8");
            await workspaceManager.writeArtifact(tenantId, userId, sessionId, "assets/App.tsx", code);
          } else {
            const fullPath = join(componentsDir, filePath.replace(/^components\//, ""));
            await mkdir(join(fullPath, ".."), { recursive: true });
            await writeFile(fullPath, code, "utf-8");
            await workspaceManager.writeArtifact(tenantId, userId, sessionId, `assets/${filePath}`, code);
          }
        }
        syncedFiles = extracted.map((e) => e.filePath);
        logger.info(`[assembleApp] Extracted ${syncedFiles.length} files from coder output`);
        break;
      }
    }
  }

  if (syncedFiles.length === 0) {
    const coderRaw = ctx.previousResults.get("coder");
    const snippet = coderRaw
      ? (typeof coderRaw === "string" ? coderRaw : JSON.stringify(coderRaw)).slice(0, 300)
      : "(no coder output)";
    throw new Error(
      `No files found — neither in workspace nor extractable from coder output. ` +
      `Coder result preview: ${snippet}`,
    );
  }

  // 4. Build with AI-powered validation and repair
  const buildResult = await buildWithAIRepair(sourceDir, distDir, 3, { sessionId });

  if (!buildResult.success) {
    throw new Error(`Build failed: ${buildResult.warnings.join("; ")}`);
  }

  // 5. Save metadata (optional record — no downstream code depends on this)
  const title = blueprint?.title as string || "互动教材";
  const url = `/api/files/tutorials/${sessionId}/dist/index.html`;
  const meta: TutorialMeta = {
    tutorialId: sessionId,
    title,
    url,
    createdAt: new Date().toISOString(),
  };

  await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/tutorial-meta.json", JSON.stringify(meta, null, 2));
  if (blueprint) {
    await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json", JSON.stringify(blueprint, null, 2));
  }

  const teachingGuide = blueprint?.teaching_guide;

  return {
    ...meta,
    teachingGuide,
    fileCount: syncedFiles.length,
    warnings: buildResult.warnings.length > 0 ? buildResult.warnings : undefined,
    repairLog: buildResult.repairLog.length > 0 ? buildResult.repairLog : undefined,
  };
}

/**
 * First-time assembly without pipeline context.
 * Copies template, syncs workspace files, builds with AI repair.
 * Used as a fallback when reassembleForSession finds no existing source directory.
 */
async function firstAssembly(
  tenantId: string,
  userId: string,
  sessionId: string,
): Promise<object> {
  const sourceDir = join(TUTORIALS_DIR, sessionId, "source");
  const distDir = join(TUTORIALS_DIR, sessionId, "dist");

  logger.info(`[firstAssembly] Building from scratch: session=${sessionId}`);

  mkdirSync(sourceDir, { recursive: true });
  cpSync(TEMPLATE_DIR, sourceDir, { recursive: true, filter: excludeFilter });

  const componentsDir = join(sourceDir, "src", "components");
  if (existsSync(componentsDir)) rmSync(componentsDir, { recursive: true, force: true });
  mkdirSync(componentsDir, { recursive: true });

  const templateModules = join(TEMPLATE_DIR, "node_modules");
  const targetModules = join(sourceDir, "node_modules");
  if (existsSync(templateModules) && !existsSync(targetModules)) {
    try {
      symlinkSync(templateModules, targetModules, "junction");
    } catch {
      logger.warn("[firstAssembly] Symlink failed, copying node_modules (slow path)");
      cpSync(templateModules, targetModules, { recursive: true });
    }
  }

  const syncedFiles = await syncAppFiles(tenantId, userId, sessionId, sourceDir);
  if (syncedFiles.length === 0) {
    throw new Error("No files found in workspace — cannot build");
  }

  logger.info(`[firstAssembly] Synced ${syncedFiles.length} files from workspace`);

  const buildResult = await buildWithAIRepair(sourceDir, distDir, 3, { sessionId });
  if (!buildResult.success) {
    throw new Error(`Build failed: ${buildResult.warnings.join("; ")}`);
  }

  const blueprintRaw = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json");
  const blueprint = safeParseJSON(blueprintRaw);
  const title = (blueprint?.title as string) || "互动教材";
  const url = `/api/files/tutorials/${sessionId}/dist/index.html`;

  const meta: TutorialMeta = { tutorialId: sessionId, title, url, createdAt: new Date().toISOString() };
  await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/tutorial-meta.json", JSON.stringify(meta, null, 2));

  return {
    ...meta,
    fileCount: syncedFiles.length,
    warnings: buildResult.warnings.length > 0 ? buildResult.warnings : undefined,
  };
}

/**
 * Standalone reassemble: sync workspace files → Vite build → update meta.
 * Uses sessionId directly to locate the build directory — no tutorial-meta.json dependency.
 * Falls back to firstAssembly if source dir does not exist yet.
 */
export async function reassembleForSession(
  tenantId: string,
  userId: string,
  sessionId: string,
): Promise<object> {
  const sourceDir = join(TUTORIALS_DIR, sessionId, "source");
  const distDir = join(TUTORIALS_DIR, sessionId, "dist");

  if (!existsSync(sourceDir)) {
    logger.info(`[reassembleApp] No source dir for session=${sessionId}, falling back to full assembly`);
    return firstAssembly(tenantId, userId, sessionId);
  }

  logger.info(`[reassembleApp] Re-syncing: session=${sessionId}`);

  const syncedFiles = await syncAppFiles(tenantId, userId, sessionId, sourceDir);
  logger.info(`[reassembleApp] Re-synced ${syncedFiles.length} files`);

  if (syncedFiles.length === 0) {
    throw new Error("No files found after edit");
  }

  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });

  const buildResult = await buildWithAIRepair(sourceDir, distDir, 3, { sessionId });
  if (!buildResult.success) {
    throw new Error(`Rebuild failed: ${buildResult.warnings.join("; ")}`);
  }

  const url = `/api/files/tutorials/${sessionId}/dist/index.html`;
  const blueprintRaw = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json");
  const blueprint = safeParseJSON(blueprintRaw);
  const title = (blueprint?.title as string) || "互动教材";

  const meta: TutorialMeta = { tutorialId: sessionId, title, url, createdAt: new Date().toISOString() };
  await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/tutorial-meta.json", JSON.stringify(meta, null, 2));

  return {
    ...meta,
    fileCount: syncedFiles.length,
    warnings: buildResult.warnings.length > 0 ? buildResult.warnings : undefined,
  };
}

/** Pipeline handler wrapper — delegates to reassembleForSession. */
export async function reassembleApp(ctx: PipelineHandlerContext): Promise<object> {
  const { tenantId, userId, sessionId } = ctx;
  if (!sessionId) throw new Error("reassembleApp requires a sessionId");
  return reassembleForSession(tenantId, userId, sessionId) as Promise<object>;
}
