import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { workspaceManager } from "../../../../src/core/workspace.js";
import { removeDeadImports } from "../validators.js";
import { extractStringArray, safeParseJSON } from "../blueprint-service.js";

export async function collectComponentFiles(componentsDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

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

export async function cleanDeadImports(appFile: string, sourceDir: string): Promise<number> {
  const componentsDir = join(sourceDir, "src", "components");
  const pagesDir = join(sourceDir, "src", "pages");
  const existingComponents = existsSync(componentsDir) ? await collectComponentFiles(componentsDir) : [];
  const existingPages = existsSync(pagesDir) ? await collectComponentFiles(pagesDir) : [];

  let totalRemoved = 0;
  if (existsSync(appFile)) {
    const { removed, total } = await removeDeadImports(appFile, existingComponents, existingPages);
    if (total >= 1 && removed === total) {
      throw new Error(
        `[ASSEMBLE ERROR] All ${total} component/page import(s) in App.tsx point to missing files — refusing to build an app whose slots would all be undefined at runtime.`,
      );
    }
    totalRemoved += removed;
  }

  if (existsSync(pagesDir)) {
    const reservedPages = new Set(["RouteErrorPage.tsx", "NotFoundPage.tsx"]);
    try {
      const entries = await readdir(pagesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || reservedPages.has(entry.name)) continue;
        if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
        const pageFile = join(pagesDir, entry.name);
        const { removed } = await removeDeadImports(pageFile, existingComponents, []);
        totalRemoved += removed;
      }
    } catch {
      // noop
    }
  }

  return totalRemoved;
}

export async function assertAssetGraphComplete(
  appFile: string,
  componentsDir: string,
  pagesDir: string,
  blueprint?: Record<string, unknown> | null,
  errorPrefix = "[ASSEMBLE ERROR]",
): Promise<void> {
  const existingComponents = existsSync(componentsDir)
    ? (await collectComponentFiles(componentsDir)).map((file) => file.replace(/\.tsx?$/, ""))
    : [];
  const existingPages = existsSync(pagesDir)
    ? (await collectComponentFiles(pagesDir)).map((file) => file.replace(/\.tsx?$/, ""))
    : [];
  const componentSet = new Set(existingComponents);
  const pageSet = new Set(existingPages);
  const missing: string[] = [];

  if (existsSync(appFile)) {
    const source = await readFile(appFile, "utf-8");
    for (const match of source.matchAll(/from\s+['"]\.\/components\/([^'"]+)['"]/g)) {
      const ref = match[1]!.replace(/\.tsx?$/, "");
      if (!componentSet.has(ref)) missing.push(`components/${ref}`);
    }
    for (const match of source.matchAll(/from\s+['"]@\/components\/([^'"]+)['"]/g)) {
      const ref = match[1]!.replace(/\.tsx?$/, "");
      if (!componentSet.has(ref)) missing.push(`components/${ref}`);
    }
    for (const match of source.matchAll(/from\s+['"]@\/pages\/([^'"]+)['"]/g)) {
      const ref = match[1]!.replace(/\.tsx?$/, "");
      if (!pageSet.has(ref)) missing.push(`pages/${ref}`);
    }
  }

  const blueprintComponents = Array.isArray(blueprint?.components)
    ? blueprint.components
        .map((item) => {
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
      `${errorPrefix} Generated app references or requires ${missing.length} missing file(s): ${missing.join(", ")}. This usually means the coder did not write every component declared by the blueprint.`,
    );
  }
}

export async function assertAppShellReferencesExist(
  sourceDir: string,
  blueprint?: Record<string, unknown> | null,
): Promise<void> {
  const componentsDir = join(sourceDir, "src", "components");
  const pagesDir = join(sourceDir, "src", "pages");
  const reservedPages = new Set(["RouteErrorPage", "NotFoundPage"]);

  async function collectRefsFromFile(filePath: string): Promise<{ components: Set<string>; pages: Set<string> }> {
    const components = new Set<string>();
    const pages = new Set<string>();
    if (!existsSync(filePath)) return { components, pages };

    const source = await readFile(filePath, "utf-8");

    for (const match of source.matchAll(/from\s+['"]\.\/components\/([^'"]+)['"]/g)) {
      components.add(match[1]!.replace(/\.tsx?$/, ""));
    }

    for (const match of source.matchAll(/from\s+['"]@\/components\/([^'"]+)['"]/g)) {
      const ref = match[1]!.replace(/\.tsx?$/, "");
      if (!ref.startsWith("ui/") && !ref.startsWith("layout/") && !ref.startsWith("system/") && !ref.startsWith("theme-")) {
        components.add(ref);
      }
    }

    for (const match of source.matchAll(/from\s+['"]@\/pages\/([^'"]+)['"]/g)) {
      const ref = match[1]!.replace(/\.tsx?$/, "");
      if (!reservedPages.has(ref)) pages.add(ref);
    }

    return { components, pages };
  }

  const appFile = join(sourceDir, "src", "App.tsx");
  const appRefs = await collectRefsFromFile(appFile);
  const existingComponents = existsSync(componentsDir)
    ? (await collectComponentFiles(componentsDir)).map((file) => file.replace(/\.tsx?$/, ""))
    : [];
  const existingPages = existsSync(pagesDir)
    ? (await collectComponentFiles(pagesDir)).map((file) => file.replace(/\.tsx?$/, ""))
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
        if (!entry.isFile() || reservedPages.has(entry.name.replace(/\.tsx?$/, ""))) continue;
        if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
        const refs = await collectRefsFromFile(join(pagesDir, entry.name));
        for (const ref of refs.components) {
          if (!componentSet.has(ref)) missing.push(`${entry.name} -> components/${ref}`);
        }
      }
    } catch {
      // noop
    }
  }

  const blueprintComponents = Array.isArray(blueprint?.components)
    ? blueprint.components
        .map((item) => {
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
      `[ASSEMBLE ERROR] Generated app references or requires ${missing.length} missing file(s): ${missing.join(", ")}. This usually means the coder did not write every component declared by the blueprint. Refusing to stub missing components and produce a partial app.`,
    );
  }
}

export async function assertEditorConvergenceBeforeReassemble(
  tenantId: string,
  userId: string,
  sessionId: string,
): Promise<void> {
  const editorRaw = await workspaceManager.readArtifact(tenantId, userId, sessionId, "logs/tutorial-scene-editor-raw-output.txt");
  if (!editorRaw || typeof editorRaw !== "string") return;

  if (/GRAPH_RECURSION_LIMIT|Recursion limit .*stop condition/i.test(editorRaw)) {
    throw new Error("[EDIT NOT CONVERGED] tutorial-scene-editor hit GRAPH_RECURSION_LIMIT (failureType=recursion_limit)");
  }

  const parsed = safeParseJSON(editorRaw);
  if (!parsed) return;

  const status = typeof parsed.status === "string" ? parsed.status : "";
  if (status === "failed") {
    const failureType = typeof parsed.failureType === "string" ? parsed.failureType : "other";
    const err = typeof parsed.error === "string" ? parsed.error : "scene-editor returned failed";
    throw new Error(`[EDIT NOT CONVERGED] ${err} (failureType=${failureType})`);
  }

  if (status === "completed") {
    const editedFiles = Array.isArray(parsed.editedFiles) ? parsed.editedFiles : [];
    if (editedFiles.length === 0) {
      throw new Error("[EDIT NOT CONVERGED] scene-editor completed with empty editedFiles (failureType=empty_diff)");
    }
    const instructionCoverage = extractStringArray(parsed.instructionCoverage);
    if (instructionCoverage.length === 0) {
      throw new Error("[EDIT NOT CONVERGED] scene-editor completed without instructionCoverage (failureType=schema_invalid)");
    }
  }
}

export function buildHasConfigError(warnings: string[]): boolean {
  return warnings.some((warning) => warning.includes("[CONFIG ERROR]"));
}
