import { existsSync, cpSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../../../src/utils/logger.js";
import { getTemplateDir } from "../template-dir.js";

const JUNCTIONED_DIRS = ["public"] as const;

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

const SRC_TEMPLATE_FILES = ["main.tsx", "index.css", "vite-env.d.ts"] as const;

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

export function copyReservedZone(templateDir: string, sourceDir: string): void {
  for (const dir of TEMPLATE_RESERVED_DIRS) {
    const from = join(templateDir, dir);
    if (!existsSync(from)) continue;
    const to = join(sourceDir, dir);
    mkdirSync(join(to, ".."), { recursive: true });
    cpSync(from, to, { recursive: true, force: true });
  }

  for (const file of TEMPLATE_RESERVED_FILES) {
    const from = join(templateDir, file);
    if (!existsSync(from)) continue;
    const to = join(sourceDir, file);
    mkdirSync(join(to, ".."), { recursive: true });
    cpSync(from, to, { force: true });
  }
}

export function prepareSourceDir(sourceDir: string): { elapsedMs: number; mode: "junction" | "copy" | "mixed" } {
  const startedAt = Date.now();
  const templateDir = getTemplateDir();
  let mode: "junction" | "copy" | "mixed" = "junction";

  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(join(sourceDir, "src"), { recursive: true });

  for (const file of ROOT_TEMPLATE_FILES) {
    const from = join(templateDir, file);
    if (existsSync(from)) cpSync(from, join(sourceDir, file), { force: true });
  }

  for (const file of SRC_TEMPLATE_FILES) {
    const from = join(templateDir, "src", file);
    if (existsSync(from)) cpSync(from, join(sourceDir, "src", file), { force: true });
  }

  copyReservedZone(templateDir, sourceDir);

  for (const dir of JUNCTIONED_DIRS) {
    const from = join(templateDir, dir);
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

  const templateNodeModules = join(templateDir, "node_modules");
  const targetNodeModules = join(sourceDir, "node_modules");
  if (existsSync(templateNodeModules) && !existsSync(targetNodeModules)) {
    try {
      symlinkSync(templateNodeModules, targetNodeModules, "junction");
    } catch (err) {
      logger.warn(`[prepareSourceDir] node_modules junction failed, copying (slow): ${err}`);
      cpSync(templateNodeModules, targetNodeModules, { recursive: true });
      mode = "copy";
    }
  }

  return { elapsedMs: Date.now() - startedAt, mode };
}
