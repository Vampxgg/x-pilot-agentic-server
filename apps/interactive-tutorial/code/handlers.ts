import { existsSync, cpSync, mkdirSync, rmSync, symlinkSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import PQueue from "p-queue";
import type { PipelineHandlerContext } from "../../../src/core/types.js";
import { workspaceManager } from "../../../src/core/workspace.js";
import { eventBus } from "../../../src/core/event-bus.js";
import { logger } from "../../../src/utils/logger.js";
import { resolvePublicBaseUrl } from "../../../src/utils/public-url.js";
import { validateAllComponents, removeDeadImports, deInlineComponents, parseBuildErrors, typeCheckProject } from "./validators.js";
import { repairFile, groupErrorsByFile, formatBuildErrors } from "./ai-repair.js";
import type { TutorialMeta, RepairRecord } from "./types.js";
import { getTemplateDir } from "./template-dir.js";

const execAsync = promisify(exec);

const TUTORIALS_DIR = resolve(process.cwd(), "data", "tutorials");

/** Concurrency cap for parallel AI repair calls. */
const REPAIR_CONCURRENCY = Number(process.env.TUTORIAL_REPAIR_CONCURRENCY ?? 6);

/** Per-template files that should be junctioned (large, immutable). Junction works on dirs only. */
const JUNCTIONED_DIRS = ["public"] as const;

/** Top-level template files we always copy fresh (small, may be tweaked per tutorial). */
const ROOT_TEMPLATE_FILES = [
  "index.html",
  "package.json",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "postcss.config.js",
  "tailwind.config.ts",
  "components.json",
  ".gitignore",
] as const;

/** Per-tutorial src files we copy from template (small) before overlaying user code. */
const SRC_TEMPLATE_FILES = ["main.tsx", "index.css", "vite-env.d.ts"] as const;

/**
 * Template src directories/files that form the "reserved zone" — they must be
 * copied into every per-tutorial source tree so AI-generated code can reference
 * them (e.g. `@/components/ui/button`, `@/lib/utils`). These are never
 * overwritten by AI-generated files.
 */
const TEMPLATE_RESERVED_DIRS = [
  "src/components/ui",
  "src/components/layout",
  "src/components/system",
  "src/providers",
  "src/router",
  "src/runtime",
  "src/lib",
  "src/types",
] as const;

const TEMPLATE_RESERVED_FILES = [
  "src/components/theme-provider.tsx",
  "src/components/theme-toggle.tsx",
  "src/pages/RouteErrorPage.tsx",
  "src/pages/NotFoundPage.tsx",
] as const;

function tutorialPublicFileUrl(sessionId: string): string {
  return `${resolvePublicBaseUrl()}/api/files/tutorials/${sessionId}/dist/index.html`;
}

/**
 * Copy reserved-zone directories and files from the template into the
 * per-tutorial source tree. These provide the stable runtime shell that
 * AI-generated code depends on (shadcn/ui components, AppLayout, router, etc.).
 */
function copyReservedZone(template: string, sourceDir: string): void {
  for (const dir of TEMPLATE_RESERVED_DIRS) {
    const from = join(template, dir);
    if (!existsSync(from)) continue;
    const to = join(sourceDir, dir);
    mkdirSync(join(to, ".."), { recursive: true });
    cpSync(from, to, { recursive: true, force: true });
  }
  for (const file of TEMPLATE_RESERVED_FILES) {
    const from = join(template, file);
    if (!existsSync(from)) continue;
    const to = join(sourceDir, file);
    mkdirSync(join(to, ".."), { recursive: true });
    cpSync(from, to, { force: true });
  }
}

/**
 * Prepare the per-tutorial source dir using junction symlinks for large/immutable
 * directories (node_modules, public) and selective copies for small template
 * files plus the reserved-zone runtime shell.
 *
 * Returns elapsed milliseconds for observability.
 */
function prepareSourceDir(sourceDir: string): { elapsedMs: number; mode: "junction" | "copy" | "mixed" } {
  const start = Date.now();
  const template = getTemplateDir();
  let mode: "junction" | "copy" | "mixed" = "junction";

  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(join(sourceDir, "src"), { recursive: true });

  // 1. Copy small root files
  for (const f of ROOT_TEMPLATE_FILES) {
    const from = join(template, f);
    if (existsSync(from)) {
      cpSync(from, join(sourceDir, f), { force: true });
    }
  }

  // 2. Copy small src/* template files (will be overlaid by syncAppFiles later)
  for (const f of SRC_TEMPLATE_FILES) {
    const from = join(template, "src", f);
    if (existsSync(from)) {
      cpSync(from, join(sourceDir, "src", f), { force: true });
    }
  }

  // 2.5. Copy reserved-zone runtime shell (shadcn/ui, layout, router, etc.)
  copyReservedZone(template, sourceDir);

  // 3. Junction big immutable dirs
  for (const dir of JUNCTIONED_DIRS) {
    const from = join(template, dir);
    if (!existsSync(from)) continue;
    const to = join(sourceDir, dir);
    if (existsSync(to)) continue;
    mkdirSync(join(to, ".."), { recursive: true });
    try {
      symlinkSync(from, to, "junction");
    } catch (err) {
      logger.warn(`[prepareSourceDir] junction failed for ${dir}, falling back to copy: ${err}`);
      cpSync(from, to, { recursive: true });
      mode = "mixed";
    }
  }

  // 4. node_modules junction (largest by far)
  const tmplModules = join(template, "node_modules");
  const tgtModules = join(sourceDir, "node_modules");
  if (existsSync(tmplModules) && !existsSync(tgtModules)) {
    try {
      symlinkSync(tmplModules, tgtModules, "junction");
    } catch (err) {
      logger.warn(`[prepareSourceDir] node_modules junction failed, copying (slow): ${err}`);
      cpSync(tmplModules, tgtModules, { recursive: true });
      mode = "copy";
    }
  }

  return { elapsedMs: Date.now() - start, mode };
}

/** Run an async task with a stable label and return both the result and elapsed ms. */
async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const start = Date.now();
  try {
    const result = await fn();
    const elapsedMs = Date.now() - start;
    logger.info(`[timing] ${label}: ${elapsedMs}ms`);
    return { result, elapsedMs };
  } catch (err) {
    logger.warn(`[timing] ${label} failed after ${Date.now() - start}ms: ${err}`);
    throw err;
  }
}

async function syncAppFiles(
  tenantId: string,
  userId: string,
  sessionId: string,
  sourceDir: string,
): Promise<string[]> {
  const wsPath = workspaceManager.getPath(tenantId, userId, sessionId);
  const synced: string[] = [];

  /** Unescape string-escaped newlines produced by some LLM outputs. */
  function unescapeContent(raw: string): string {
    if (!raw.includes("\n") && raw.includes("\\n")) {
      return raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
    }
    return raw;
  }

  /** Recursively copy .ts/.tsx files from src to dest, tracking synced paths. */
  async function copyDir(src: string, dest: string, prefix: string): Promise<void> {
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        await mkdir(destPath, { recursive: true });
        await copyDir(srcPath, destPath, prefix);
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        const content = unescapeContent(await readFile(srcPath, "utf-8"));
        await writeFile(destPath, content, "utf-8");
        synced.push(prefix + relative(dest, destPath).replace(/\\/g, "/"));
      }
    }
  }

  // 1. Sync App.tsx
  const wsAppFile = join(wsPath, "assets", "App.tsx");
  if (existsSync(wsAppFile)) {
    const content = unescapeContent(await readFile(wsAppFile, "utf-8"));
    await writeFile(join(sourceDir, "src", "App.tsx"), content, "utf-8");
    synced.push("App.tsx");
  }

  // 2. Sync components/ — only AI-generated components, preserving reserved zone
  const componentsTarget = join(sourceDir, "src", "components");
  const wsComponents = join(wsPath, "assets", "components");
  if (existsSync(wsComponents)) {
    await copyDir(wsComponents, componentsTarget, "components/");
  }

  // 3. Sync pages/ — AI-generated pages (skip reserved pages)
  const RESERVED_PAGES = new Set(["RouteErrorPage.tsx", "NotFoundPage.tsx"]);
  const pagesTarget = join(sourceDir, "src", "pages");
  mkdirSync(pagesTarget, { recursive: true });
  const wsPages = join(wsPath, "assets", "pages");
  if (existsSync(wsPages)) {
    const entries = await readdir(wsPages, { withFileTypes: true });
    for (const entry of entries) {
      if (RESERVED_PAGES.has(entry.name)) continue;
      const srcPath = join(wsPages, entry.name);
      const destPath = join(pagesTarget, entry.name);
      if (entry.isDirectory()) {
        await mkdir(destPath, { recursive: true });
        await copyDir(srcPath, destPath, "pages/");
      } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        const content = unescapeContent(await readFile(srcPath, "utf-8"));
        await writeFile(destPath, content, "utf-8");
        synced.push("pages/" + entry.name);
      }
    }
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
  // Build into sourceDir/dist (inside project root) to avoid the
  // [vite:build-html] "fileName ... must be neither absolute nor relative paths"
  // error that triggers when outDir lives outside the rollup project root and
  // multi-entry HTML inputs are absolute paths (see vitejs/vite#9662).
  // After a successful build, the result is mirrored to the external distDir.
  const internalDist = join(sourceDir, "dist");

  try {
    await injectTutorialMeta(sourceDir, meta);

    if (existsSync(internalDist)) {
      rmSync(internalDist, { recursive: true, force: true });
    }

    const viteBin = join(getTemplateDir(), "node_modules", ".bin", "vite.cmd");
    const viteCmd = existsSync(viteBin)
      ? `"${viteBin}" build --outDir "${internalDist}" --minify false --emptyOutDir`
      : `npx vite build --outDir "${internalDist}" --minify false --emptyOutDir`;

    const { stdout, stderr } = await execAsync(viteCmd, {
      cwd: sourceDir,
      timeout: 120_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=4096",
      },
    });

    const output = (stdout || "") + "\n" + (stderr || "");
    const built = existsSync(join(internalDist, "index.html"));
    if (built) {
      if (existsSync(distDir)) {
        rmSync(distDir, { recursive: true, force: true });
      }
      mkdirSync(join(distDir, ".."), { recursive: true });
      cpSync(internalDist, distDir, { recursive: true });
    }
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

/**
 * Strip ANSI color escape sequences and keep the tail of the build output.
 * Truncating to 500 chars used to cut the rollup error message in half
 * ("[vite:build-html] The \"fileName\" or \"name\" properties of" ← stops here),
 * which made the agent guess wildly. We now keep up to ~4KB of the tail and
 * remove ANSI codes so the LLM sees the whole error.
 */
function summarizeBuildOutput(output: string, maxChars: number = 4000): string {
  const stripped = output.replace(/\u001b\[[0-9;]*m/g, "");
  if (stripped.length <= maxChars) return stripped.trim();
  return "…" + stripped.slice(stripped.length - maxChars).trim();
}

/**
 * Clean dead imports from App.tsx and all page files under src/pages/.
 * Pages may import components that were removed by AI repair; those
 * dead imports need to be commented out as well.
 */
async function cleanDeadImports(appFile: string, sourceDir: string): Promise<number> {
  const componentsDir = join(sourceDir, "src", "components");
  const pagesDir = join(sourceDir, "src", "pages");
  const existingComponents = existsSync(componentsDir)
    ? await collectComponentFiles(componentsDir)
    : [];
  const existingPages = existsSync(pagesDir)
    ? await collectComponentFiles(pagesDir)
    : [];

  let totalRemoved = 0;

  // 1. Clean App.tsx
  if (existsSync(appFile)) {
    const { removed, total } = await removeDeadImports(appFile, existingComponents, existingPages);
    if (total >= 1 && removed === total) {
      throw new Error(
        `[ASSEMBLE ERROR] All ${total} component/page import(s) in App.tsx point to missing files — ` +
          `refusing to build an app whose slots would all be undefined at runtime.`,
      );
    }
    totalRemoved += removed;
  }

  // 2. Clean dead component imports from page files
  if (existsSync(pagesDir)) {
    const RESERVED_PAGES = new Set(["RouteErrorPage.tsx", "NotFoundPage.tsx"]);
    try {
      const entries = await readdir(pagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || RESERVED_PAGES.has(entry.name)) continue;
        if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
        const pageFile = join(pagesDir, entry.name);
        const { removed } = await removeDeadImports(pageFile, existingComponents, []);
        totalRemoved += removed;
      }
    } catch { /* ignore readdir errors */ }
  }

  return totalRemoved;
}

/**
 * Pre-build structural gate: parse App.tsx and page files for component/page
 * imports and verify each one corresponds to an actual file. Supports both old
 * `./components/X` and new `@/components/X`, `@/pages/X` import styles.
 *
 * Throws `[ASSEMBLE ERROR]` if any reference is missing — this catches the
 * case where blueprint.json was missing, the coder hallucinated component
 * names, or the code step produced no files.
 */
async function assertAppShellReferencesExist(sourceDir: string, blueprint?: Record<string, unknown> | null): Promise<void> {
  const componentsDir = join(sourceDir, "src", "components");
  const pagesDir = join(sourceDir, "src", "pages");

  const RESERVED_PAGES = new Set(["RouteErrorPage", "NotFoundPage"]);

  async function collectRefsFromFile(filePath: string): Promise<{ components: Set<string>; pages: Set<string> }> {
    const components = new Set<string>();
    const pages = new Set<string>();
    if (!existsSync(filePath)) return { components, pages };

    const source = await readFile(filePath, "utf-8");

    const oldStyleRegex = /from\s+['"]\.\/components\/([^'"]+)['"]/g;
    for (const m of source.matchAll(oldStyleRegex)) {
      components.add(m[1]!.replace(/\.tsx?$/, ""));
    }

    const aliasCompRegex = /from\s+['"]@\/components\/([^'"]+)['"]/g;
    for (const m of source.matchAll(aliasCompRegex)) {
      const ref = m[1]!.replace(/\.tsx?$/, "");
      if (!ref.startsWith("ui/") && !ref.startsWith("layout/") && !ref.startsWith("system/") && !ref.startsWith("theme-")) {
        components.add(ref);
      }
    }

    const aliasPagesRegex = /from\s+['"]@\/pages\/([^'"]+)['"]/g;
    for (const m of source.matchAll(aliasPagesRegex)) {
      const ref = m[1]!.replace(/\.tsx?$/, "");
      if (!RESERVED_PAGES.has(ref)) {
        pages.add(ref);
      }
    }

    return { components, pages };
  }

  const appFile = join(sourceDir, "src", "App.tsx");
  const appRefs = await collectRefsFromFile(appFile);

  const existingComponents = existsSync(componentsDir)
    ? (await collectComponentFiles(componentsDir)).map(f => f.replace(/\.tsx?$/, ""))
    : [];
  const existingPages = existsSync(pagesDir)
    ? (await collectComponentFiles(pagesDir)).map(f => f.replace(/\.tsx?$/, ""))
    : [];

  const componentSet = new Set(existingComponents);
  const pageSet = new Set(existingPages);

  const missing: string[] = [];
  for (const ref of appRefs.components) {
    if (!componentSet.has(ref)) missing.push(`components/${ref}`);
  }
  for (const ref of appRefs.pages) {
    if (!pageSet.has(ref)) missing.push(`pages/${ref}`);
  }

  if (existsSync(pagesDir)) {
    try {
      const entries = await readdir(pagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || RESERVED_PAGES.has(entry.name.replace(/\.tsx?$/, ""))) continue;
        if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
        const pageRefs = await collectRefsFromFile(join(pagesDir, entry.name));
        for (const ref of pageRefs.components) {
          if (!componentSet.has(ref)) missing.push(`${entry.name} -> components/${ref}`);
        }
      }
    } catch {
      // Ignore directory read errors; the App.tsx-level check above still catches missing pages.
    }
  }

  const blueprintComponents = Array.isArray(blueprint?.components)
    ? blueprint.components
        .map(item => {
          if (!item || typeof item !== "object") return null;
          const fileName = (item as Record<string, unknown>).file_name;
          return typeof fileName === "string" ? fileName.replace(/\.tsx?$/, "") : null;
        })
        .filter((name): name is string => Boolean(name))
    : [];
  for (const ref of blueprintComponents) {
    if (!componentSet.has(ref)) missing.push(`blueprint component missing: components/${ref}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `[ASSEMBLE ERROR] Generated app references or requires ${missing.length} missing file(s): ${missing.join(", ")}. ` +
        `This usually means the coder did not write every component declared by the blueprint. ` +
        `Refusing to stub missing components and produce a partial app.`,
    );
  }
}

/**
 * Repair a batch of (file, errors) pairs in parallel with a concurrency cap.
 * Returns the number of files actually repaired plus an updated repairLog.
 */
/**
 * Check if a file path belongs to the template reserved zone and should
 * never be deleted or repaired by the AI repair pipeline.
 */
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

/**
 * True if a file is AI-generated user code that can safely be removed
 * as a fallback when repair fails.
 */
function isRemovableUserFile(filePath: string): boolean {
  if (isReservedZoneFile(filePath)) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.includes("/components/") || normalized.includes("/pages/");
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
        if (!existsSync(file)) return;
        if (isReservedZoneFile(file)) return;
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

export interface BuildHooks {
  /** Called once when the first successful build completes; arg is the elapsed ms of the build round that succeeded. */
  onFirstSuccess?: (info: { round: number; elapsedMs: number }) => void;
  /** Called when each build round finishes (success or failure). */
  onRound?: (info: { round: number; success: boolean; errorCount: number; elapsedMs: number }) => void;
}

async function buildWithAIRepair(
  sourceDir: string,
  distDir: string,
  maxRounds: number = 3,
  meta?: BuildMeta,
  hooks?: BuildHooks,
): Promise<{ success: boolean; warnings: string[]; repairLog: RepairRecord[] }> {
  const warnings: string[] = [];
  const repairLog: RepairRecord[] = [];
  const componentsDir = join(sourceDir, "src", "components");
  const appFile = join(sourceDir, "src", "App.tsx");

  // Stage 1: Static validation — parallel AI repair before falling back to deletion
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

  // Stage 1.5a: Check for inline component definitions (warning-only since single
  // coder architecture makes this rare; kept for observability)
  const pagesDir = join(sourceDir, "src", "pages");
  const deInlined = await deInlineComponents(pagesDir, componentsDir);
  if (deInlined > 0) {
    warnings.push(`De-inlined ${deInlined} component(s) from page files (replaced with imports)`);
    logger.warn(`[buildWithAIRepair] De-inlined ${deInlined} component(s) — single coder should not produce these`);
  }

  // Stage 1.5b: Clean dead imports from App.tsx and page files
  const deadRemoved = await cleanDeadImports(appFile, sourceDir);
  if (deadRemoved > 0) {
    warnings.push(`Removed ${deadRemoved} dead import(s) from App.tsx and page files`);
  }

  // Stage 2: Build with AI repair loop. Note: we no longer run tsc as a pre-check
  // (saves 10–30s per build) — vite/esbuild catches the same issues. tsc is now a
  // fallback only triggered after vite repair rounds fail to converge.
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

    // Detect "configuration-class" failures: vite plugin errors (file = "<vite>")
    // or rollup link errors against files that don't exist on disk (e.g. errors
    // pointing at template/build internals). These cannot be fixed by editing
    // user components, so let editor sub-agents avoid wasted spawns and let
    // assembleApp surface a clear "[CONFIG ERROR]" upstream.
    const repairable = buildErrors.filter(e => e.file !== '<vite>' && existsSync(e.file));
    if (repairable.length === 0) {
      // Before giving up as CONFIG ERROR, check if these are missing-import errors
      // that can be fixed by cleaning dead imports from page/App files.
      const deadCleaned = await cleanDeadImports(appFile, sourceDir);
      if (deadCleaned > 0) {
        warnings.push(`Cleaned ${deadCleaned} dead import(s) after component removal (round ${round}), retrying...`);
        continue;
      }
      warnings.push(
        `[CONFIG ERROR] Build failure looks like a vite/rollup configuration issue, ` +
        `not user-component code (round ${round}). Manual intervention required.\n` +
        summarizeBuildOutput(result.output),
      );
      break;
    }

    if (round > maxRounds) break;

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

  // Stage 3: tsc fallback — only run if vite repair rounds did not converge.
  // tsc is slow (10–30s) so we skip it on the happy path, but use it as a last
  // resort to surface type errors that escaped esbuild's checks.
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
      if (repaired > 0) {
        await cleanDeadImports(appFile, sourceDir);
      }
    }
  } catch (err) {
    logger.warn(`[buildWithAIRepair] tsc fallback skipped: ${err}`);
  }

  // Final build attempt after tsc fallback
  const finalStart = Date.now();
  const finalResult = await runBuild(sourceDir, distDir, meta);
  const finalElapsed = Date.now() - finalStart;
  hooks?.onRound?.({ round: maxRounds + 1, success: finalResult.success, errorCount: 0, elapsedMs: finalElapsed });
  if (finalResult.success) {
    logger.info(`[buildWithAIRepair] Final build succeeded after tsc fallback (${finalElapsed}ms)`);
    if (!firstSuccessReported) {
      firstSuccessReported = true;
      hooks?.onFirstSuccess?.({ round: maxRounds + 1, elapsedMs: finalElapsed });
    }
    return { success: true, warnings, repairLog };
  }

  warnings.push(`Build failed after all repair rounds:\n${summarizeBuildOutput(finalResult.output)}`);
  return { success: false, warnings, repairLog };
}

const FILE_NAME_RE = /^[A-Z][A-Za-z0-9]+\.tsx$/;

/**
 * Normalize blueprint.components in-place:
 *  - drop entries with invalid/missing file_name
 *  - dedupe file_name (keep first, suffix duplicates with index)
 *  - ensure PascalCase, .tsx suffix
 *
 * Returns the (possibly mutated) blueprint and a list of fix-up notes.
 */
function normalizeBlueprint(blueprint: Record<string, unknown>): { blueprint: Record<string, unknown>; notes: string[] } {
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
    fileName = fileName.replace(/^[a-z]/, (c) => c.toUpperCase());
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
    if (unique !== fileName) {
      notes.push(`components[${i}] renamed: ${fileName} -> ${unique} (duplicate)`);
    }
    seen.add(unique);
    cleaned.push({ ...item, file_name: unique });
  }

  if (cleaned.length !== components.length) {
    notes.push(`components: ${components.length} -> ${cleaned.length} after normalization`);
  }
  blueprint.components = cleaned;
  return { blueprint, notes };
}

/**
 * Pipeline handler: ensure blueprint.json is valid JSON in workspace.
 * Also normalizes components[].file_name to be unique PascalCase .tsx so that the
 * downstream coder does not collide on file paths.
 */
export async function saveBlueprint(ctx: PipelineHandlerContext): Promise<unknown> {
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

  // Architect produced nothing parseable AND nothing was written to workspace.
  // The most common cause is the architect's ReACT reflection loop falsely
  // declaring `done=true` after only reading research.json, never calling
  // `workspace_write({name: "artifacts/blueprint.json"})`. Returning null here
  // would let the coder hallucinate component imports → empty app at runtime.
  // Instead, re-invoke the architect once with an explicit research-context
  // brief; if it still fails, throw [ARCHITECT FAILED] so the director can
  // surface the failure instead of producing a broken tutorial.
  const retried = await retryArchitectOnce(ctx, architectRaw);
  if (retried) return retried;

  throw new Error(
    "[ARCHITECT FAILED] Blueprint generation failed after retry. " +
      "Architect produced no parseable blueprint and did not write artifacts/blueprint.json. " +
      "Manual intervention required.",
  );
}

/**
 * Re-run tutorial-scene-architect once when saveBlueprint cannot find a usable
 * blueprint. Reads research.json from workspace to seed the brief, invokes the
 * agent synchronously, then re-checks workspace + pipeline output for a parseable
 * blueprint. Returns the normalized blueprint on success, null otherwise.
 */
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
  const researchExcerpt = researchRaw
    ? `\n\n【Research Report (artifacts/research.json)】\n${researchRaw.slice(0, 4000)}`
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

  const recheckRaw = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json");
  if (recheckRaw) {
    const recheckParsed = safeParseJSON(recheckRaw);
    if (recheckParsed) {
      const { blueprint, notes } = normalizeBlueprint(recheckParsed);
      if (notes.length > 0) {
        logger.warn(`[saveBlueprint] Retry blueprint normalized: ${notes.join("; ")}`);
        await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json", JSON.stringify(blueprint, null, 2));
      }
      logger.info(`[saveBlueprint] Architect retry succeeded — blueprint recovered (${recheckRaw.length} chars)`);
      return blueprint;
    }
  }

  logger.error("[saveBlueprint] Architect retry produced no parseable blueprint either");
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

  const assembleStart = Date.now();
  const timings: Record<string, number> = {};
  const emitProgress = (message: string, extra?: Record<string, unknown>) => {
    eventBus.emit({
      type: "progress",
      sourceAgent: "interactive-tutorial-director",
      sessionId,
      data: { message, ...extra },
      timestamp: new Date().toISOString(),
    });
  };

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
  emitProgress("Preparing build environment", { phase: "assemble", stage: "prepare" });

  // Mirror reassembleForSession: clear any stale dist before the first build so
  // vite never warns "outDir ... is not inside project root and will not be
  // emptied" and we never serve mixed assets from a previous failed attempt.
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });

  // 1. Prepare source dir using junction-based template overlay
  const prep = prepareSourceDir(sourceDir);
  timings["prepare-source"] = prep.elapsedMs;
  logger.info(`[assembleApp] prepareSourceDir mode=${prep.mode} elapsed=${prep.elapsedMs}ms`);

  // 2. Sync AI-generated files from workspace (App.tsx + components/)
  const syncStart = Date.now();
  let syncedFiles = await syncAppFiles(tenantId, userId, sessionId, sourceDir);
  timings["sync-workspace"] = Date.now() - syncStart;
  logger.info(`[assembleApp] Synced ${syncedFiles.length} files from workspace in ${timings["sync-workspace"]}ms`);
  const componentsDir = join(sourceDir, "src", "components");

  // 3. Fallback: extract code blocks from coder's raw LLM output or pipeline result.
  //    The single tutorial-coder writes files via workspace_write — but we keep this
  //    fallback for resilience when the coder partially fails or uses inline code.
  if (syncedFiles.length === 0) {
    logger.warn("[assembleApp] No files in workspace — attempting to extract from coder output");

    const candidateTexts: string[] = [];

    for (const logFile of [
      "logs/tutorial-coder-raw-output.txt",
      "logs/tutorial-scene-coder-raw-output.txt",
    ]) {
      const raw = await workspaceManager.readArtifact(tenantId, userId, sessionId, logFile);
      if (raw) candidateTexts.push(raw);
    }

    for (const stepName of ["code", "coder"]) {
      const stepRaw = ctx.previousResults.get(stepName);
      if (stepRaw) {
        candidateTexts.push(typeof stepRaw === "string" ? stepRaw : JSON.stringify(stepRaw, null, 2));
      }
    }

    for (const text of candidateTexts) {
      const extracted = extractCodeBlocks(text);
      if (extracted.length > 0) {
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
    const coderRaw = ctx.previousResults.get("code") ?? ctx.previousResults.get("coder");
    const snippet = coderRaw
      ? (typeof coderRaw === "string" ? coderRaw : JSON.stringify(coderRaw)).slice(0, 300)
      : "(no coder output)";
    throw new Error(
      `No files found — neither in workspace nor extractable from coder output. ` +
      `Coder result preview: ${snippet}`,
    );
  }

  emitProgress(`Building app with ${syncedFiles.length} files`, { phase: "assemble", stage: "build" });

  // 3.5. Structural gate: refuse to build if App.tsx imports any components that
  //      don't exist on disk. Catches the blueprint-missing → hallucinated-imports
  //      failure mode before vite + cleanDeadImports silently produce an empty app.
  await assertAppShellReferencesExist(sourceDir, blueprint);

  // 4. Build with AI-powered validation and parallel repair. Emit preview_ready
  //    as soon as the first build round succeeds so the user sees the URL while
  //    any remaining tsc/lint passes finish in the foreground.
  const url = tutorialPublicFileUrl(sessionId);
  let previewEmitted = false;
  const buildStart = Date.now();
  const buildResult = await buildWithAIRepair(sourceDir, distDir, 3, { sessionId }, {
    onFirstSuccess: ({ round, elapsedMs }) => {
      previewEmitted = true;
      timings["first-success-round"] = round;
      timings["first-success-build-ms"] = elapsedMs;
      logger.info(`[assembleApp] preview_ready url=${url} round=${round} build=${elapsedMs}ms`);
      emitProgress("Preview is ready", {
        phase: "assemble",
        stage: "preview_ready",
        url,
        round,
        elapsedMs,
      });
    },
    onRound: ({ round, success, elapsedMs }) => {
      logger.info(`[assembleApp] build round ${round} success=${success} elapsed=${elapsedMs}ms`);
    },
  });
  timings["build-total"] = Date.now() - buildStart;

  if (!buildResult.success) {
    throw new Error(`Build failed: ${buildResult.warnings.join("; ")}`);
  }

  // 5. Save metadata (optional record — no downstream code depends on this)
  const title = blueprint?.title as string || "互动教材";
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

  const totalElapsed = Date.now() - assembleStart;
  timings["assemble-total"] = totalElapsed;

  // Persist per-step timing metrics for offline analysis (Task 12 — observability)
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

  emitProgress("Final build complete", {
    phase: "assemble",
    stage: "final_ready",
    url,
    elapsedMs: totalElapsed,
  });

  // Belt-and-suspenders: if for some reason onFirstSuccess never fired (e.g. hooks rebound),
  // emit preview_ready here so the consumer always sees one.
  if (!previewEmitted) {
    emitProgress("Preview is ready", { phase: "assemble", stage: "preview_ready", url });
  }

  const teachingGuide = blueprint?.teaching_guide;

  return {
    ...meta,
    teachingGuide,
    fileCount: syncedFiles.length,
    timings,
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

  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });

  logger.info(`[firstAssembly] Building from scratch: session=${sessionId}`);

  const prep = prepareSourceDir(sourceDir);
  logger.info(`[firstAssembly] prepareSourceDir mode=${prep.mode} elapsed=${prep.elapsedMs}ms`);

  const syncedFiles = await syncAppFiles(tenantId, userId, sessionId, sourceDir);
  if (syncedFiles.length === 0) {
    throw new Error("No files found in workspace — cannot build");
  }

  logger.info(`[firstAssembly] Synced ${syncedFiles.length} files from workspace`);

  const blueprintRaw = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json");
  const blueprint = safeParseJSON(blueprintRaw);

  await assertAppShellReferencesExist(sourceDir, blueprint);

  const buildResult = await buildWithAIRepair(sourceDir, distDir, 3, { sessionId });
  if (!buildResult.success) {
    throw new Error(`${buildHasConfigError(buildResult.warnings) ? "[CONFIG ERROR] " : ""}Build failed: ${buildResult.warnings.join("; ")}`);
  }

  const title = (blueprint?.title as string) || "互动教材";
  const url = tutorialPublicFileUrl(sessionId);

  const meta: TutorialMeta = { tutorialId: sessionId, title, url, createdAt: new Date().toISOString() };
  await workspaceManager.writeArtifact(tenantId, userId, sessionId, "artifacts/tutorial-meta.json", JSON.stringify(meta, null, 2));

  return {
    ...meta,
    fileCount: syncedFiles.length,
    warnings: buildResult.warnings.length > 0 ? buildResult.warnings : undefined,
  };
}

/** True if any warning carries the [CONFIG ERROR] sentinel. */
function buildHasConfigError(warnings: string[]): boolean {
  return warnings.some(w => w.includes("[CONFIG ERROR]"));
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

  const blueprintRaw = await workspaceManager.readArtifact(tenantId, userId, sessionId, "artifacts/blueprint.json");
  const blueprint = safeParseJSON(blueprintRaw);

  await assertAppShellReferencesExist(sourceDir, blueprint);

  const buildResult = await buildWithAIRepair(sourceDir, distDir, 3, { sessionId });
  if (!buildResult.success) {
    throw new Error(`${buildHasConfigError(buildResult.warnings) ? "[CONFIG ERROR] " : ""}Rebuild failed: ${buildResult.warnings.join("; ")}`);
  }

  const url = tutorialPublicFileUrl(sessionId);
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

// ---------------------------------------------------------------------------
// Task 11: research result caching by (topic + databaseId) hash
// ---------------------------------------------------------------------------

const RESEARCH_CACHE_DIR = resolve(process.cwd(), "data", "cache", "research");
const RESEARCH_CACHE_TTL_MS = Number(process.env.TUTORIAL_RESEARCH_CACHE_TTL_MS ?? 7 * 24 * 60 * 60 * 1000); // 7 days

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

function researchCacheKey(topic: string, databaseId?: string): string {
  const seed = `${normalizeTopic(topic)}::${databaseId ?? "none"}`;
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

/**
 * Pipeline handler that wraps tutorial-content-researcher with a (topic + databaseId)
 * keyed disk cache. On cache hit, the cached research JSON is restored to the workspace
 * and returned immediately, skipping the 30-90s researcher invocation.
 */
export async function researchWithCache(ctx: PipelineHandlerContext): Promise<unknown> {
  const { tenantId, userId, sessionId, context, initialInput } = ctx;
  const topic = (context?.topic as string | undefined) ?? (context?.generationBrief as string | undefined) ?? initialInput.slice(0, 200);
  const databaseId = context?.databaseId as string | undefined;
  const key = researchCacheKey(topic, databaseId);

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
      eventBus.emit({
        type: "progress",
        sourceAgent: "tutorial-content-researcher",
        sessionId,
        data: { message: "Research cache hit", phase: "research", stage: "cache_hit", key },
        timestamp: new Date().toISOString(),
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

  const extracted = (result as { taskResult?: { output?: unknown }; output?: unknown })?.taskResult?.output
    ?? (result as { output?: unknown })?.output
    ?? result;

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
