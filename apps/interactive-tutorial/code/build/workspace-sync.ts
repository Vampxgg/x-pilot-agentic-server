import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PipelineHandlerContext } from "../../../../src/core/types.js";
import { workspaceManager } from "../../../../src/core/workspace.js";
import { logger } from "../../../../src/utils/logger.js";

function unescapeContent(raw: string): string {
  if (!raw.includes("\n") && raw.includes("\\n")) {
    return raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
  }
  return raw;
}

async function copyDir(src: string, dest: string, prefix: string, synced: string[]): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath, prefix, synced);
      continue;
    }
    if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
    const content = unescapeContent(await readFile(srcPath, "utf-8"));
    await writeFile(destPath, content, "utf-8");
    synced.push(prefix + relative(dest, destPath).replace(/\\/g, "/"));
  }
}

async function syncAssetDir(
  wsPath: string,
  sourceDir: string,
  assetDir: string,
  targetDir: string,
  prefix: string,
  synced: string[],
): Promise<void> {
  const wsDir = join(wsPath, "assets", assetDir);
  const target = join(sourceDir, "src", targetDir);
  if (!existsSync(wsDir)) return;
  await mkdir(target, { recursive: true });
  await copyDir(wsDir, target, prefix, synced);
}

export async function syncWorkspaceFiles(
  tenantId: string,
  userId: string,
  sessionId: string,
  sourceDir: string,
): Promise<string[]> {
  const wsPath = workspaceManager.getPath(tenantId, userId, sessionId);
  const synced: string[] = [];

  const wsAppFile = join(wsPath, "assets", "App.tsx");
  if (existsSync(wsAppFile)) {
    const content = unescapeContent(await readFile(wsAppFile, "utf-8"));
    await writeFile(join(sourceDir, "src", "App.tsx"), content, "utf-8");
    synced.push("App.tsx");
  }

  const componentsTarget = join(sourceDir, "src", "components");
  const wsComponents = join(wsPath, "assets", "components");
  if (existsSync(wsComponents)) {
    await copyDir(wsComponents, componentsTarget, "components/", synced);
  }

  await syncAssetDir(wsPath, sourceDir, "utils", "utils", "utils/", synced);
  await syncAssetDir(wsPath, sourceDir, "lib", "lib", "lib/", synced);

  const reservedPages = new Set(["RouteErrorPage.tsx", "NotFoundPage.tsx"]);
  const pagesTarget = join(sourceDir, "src", "pages");
  mkdirSync(pagesTarget, { recursive: true });
  const wsPages = join(wsPath, "assets", "pages");
  if (existsSync(wsPages)) {
    const entries = await readdir(wsPages, { withFileTypes: true });
    for (const entry of entries) {
      if (reservedPages.has(entry.name)) continue;
      const srcPath = join(wsPages, entry.name);
      const destPath = join(pagesTarget, entry.name);
      if (entry.isDirectory()) {
        await mkdir(destPath, { recursive: true });
        await copyDir(srcPath, destPath, "pages/", synced);
        continue;
      }
      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
      const content = unescapeContent(await readFile(srcPath, "utf-8"));
      await writeFile(destPath, content, "utf-8");
      synced.push(`pages/${entry.name}`);
    }
  }

  return synced;
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

export function extractCodeBlocks(text: string): Array<{ filePath: string; code: string }> {
  const results: Array<{ filePath: string; code: string }> = [];
  const seenPaths = new Set<string>();

  const codeBlockRegex = /```(?:tsx|typescript)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
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
        .replace(/^(?:assets\/|src\/)/, "")
        .replace(/^(?:components\/)/, "components/");
    }

    if (!filePath) {
      if (code.match(/^(?:import|\/\/)[\s\S]*?function\s+App\b/) || code.includes("export default function App") || code.includes("RouteObject[]")) {
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

export async function recoverFilesFromCoderOutputs(
  ctx: PipelineHandlerContext,
  sourceDir: string,
): Promise<string[]> {
  const { tenantId, userId, sessionId } = ctx;
  if (!sessionId) return [];

  logger.warn("[assembleApp] No files in workspace — attempting to extract from coder output");
  const candidateTexts: string[] = [];

  for (const logFile of ["logs/tutorial-coder-raw-output.txt", "logs/tutorial-scene-coder-raw-output.txt"]) {
    const raw = await workspaceManager.readArtifact(tenantId, userId, sessionId, logFile);
    if (raw) candidateTexts.push(raw);
  }

  for (const stepName of ["code", "coder"]) {
    const stepRaw = ctx.previousResults.get(stepName);
    if (stepRaw) candidateTexts.push(typeof stepRaw === "string" ? stepRaw : JSON.stringify(stepRaw, null, 2));
  }

  const componentsDir = join(sourceDir, "src", "components");
  for (const text of candidateTexts) {
    const extracted = extractCodeBlocks(text);
    if (extracted.length === 0) continue;

    for (const { filePath, code } of extracted) {
      if (filePath === "App.tsx") {
        const appPath = join(sourceDir, "src", "App.tsx");
        await writeFile(appPath, code, "utf-8");
        await workspaceManager.writeArtifact(tenantId, userId, sessionId, "assets/App.tsx", code);
      } else if (filePath.startsWith("pages/")) {
        const pagesDir = join(sourceDir, "src", "pages");
        const fullPath = join(pagesDir, filePath.replace(/^pages\//, ""));
        await mkdir(join(fullPath, ".."), { recursive: true });
        await writeFile(fullPath, code, "utf-8");
        await workspaceManager.writeArtifact(tenantId, userId, sessionId, `assets/${filePath}`, code);
      } else if (filePath.startsWith("utils/") || filePath.startsWith("lib/")) {
        const fullPath = join(sourceDir, "src", filePath);
        await mkdir(join(fullPath, ".."), { recursive: true });
        await writeFile(fullPath, code, "utf-8");
        await workspaceManager.writeArtifact(tenantId, userId, sessionId, `assets/${filePath}`, code);
      } else {
        const fullPath = join(componentsDir, filePath.replace(/^components\//, ""));
        await mkdir(join(fullPath, ".."), { recursive: true });
        await writeFile(fullPath, code, "utf-8");
        await workspaceManager.writeArtifact(tenantId, userId, sessionId, `assets/${filePath}`, code);
      }
    }

    logger.info(`[assembleApp] Extracted ${extracted.length} files from coder output`);
    return extracted.map((entry) => entry.filePath);
  }

  return [];
}
