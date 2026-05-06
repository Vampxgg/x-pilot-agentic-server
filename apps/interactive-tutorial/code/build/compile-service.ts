import { exec } from "node:child_process";
import { existsSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getTemplateDir } from "../template-dir.js";
import type { BuildMeta, BuildResult } from "./types.js";

const execAsync = promisify(exec);

export async function injectTutorialMeta(sourceDir: string, meta?: BuildMeta): Promise<void> {
  if (!meta) return;
  const metaContent = `export const TUTORIAL_META = ${JSON.stringify({
    sessionId: meta.sessionId,
    apiBase: "",
  }, null, 2)};\n\nif (typeof window !== "undefined") {\n  (window as any).__TUTORIAL_META__ = TUTORIAL_META;\n}\n`;
  await writeFile(join(sourceDir, "src", "tutorial-meta.ts"), metaContent, "utf-8");

  const mainPath = join(sourceDir, "src", "main.tsx");
  if (!existsSync(mainPath)) return;
  const mainContent = await readFile(mainPath, "utf-8");
  if (!mainContent.includes("tutorial-meta")) {
    await writeFile(mainPath, `import './tutorial-meta'\n${mainContent}`, "utf-8");
  }
}

export async function runBuild(
  sourceDir: string,
  distDir: string,
  meta?: BuildMeta,
): Promise<BuildResult> {
  const internalDist = join(sourceDir, "dist");

  try {
    await injectTutorialMeta(sourceDir, meta);
    if (existsSync(internalDist)) rmSync(internalDist, { recursive: true, force: true });

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
      if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
      mkdirSync(join(distDir, ".."), { recursive: true });
      cpSync(internalDist, distDir, { recursive: true });
    }

    return { success: existsSync(join(distDir, "index.html")), output };
  } catch (err: any) {
    return {
      success: false,
      output: (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + (err.message || ""),
    };
  }
}
