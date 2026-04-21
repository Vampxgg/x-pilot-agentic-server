import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { FileValidationError, BuildError } from "./types.js";
import { getTemplateDir } from "./template-dir.js";

const execAsync = promisify(exec);

/**
 * Cached set of valid lucide-react named exports (PascalCase), built lazily by
 * reading the template's node_modules/lucide-react/dynamicIconImports.js and
 * converting the kebab-case keys to PascalCase. Used to catch typos like
 * `Road` (not a real icon — should be `Route`) BEFORE vite spends 10s
 * transforming 4500+ modules just to fail at the rollup link step with a
 * truncated `"Road" is not exported by ...` error that the parser then
 * silently dropped.
 */
let _lucideIconCache: Set<string> | null = null;

function loadLucideIcons(): Set<string> {
  if (_lucideIconCache) return _lucideIconCache;
  const candidates = [
    join(getTemplateDir(), "node_modules", "lucide-react", "dynamicIconImports.js"),
  ];
  const set = new Set<string>();
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, "utf-8");
      const re = /"([a-z0-9-]+)":/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        set.add(kebabToPascal(m[1]!));
      }
      // A handful of icons have aliases / extra exports not in the dynamic map;
      // be conservative and also accept the icon name + "Icon" suffix.
      const aliases: string[] = [];
      for (const name of set) aliases.push(`${name}Icon`);
      for (const a of aliases) set.add(a);
    } catch {
      // best-effort: if we can't read the file, skip the check entirely
      return new Set();
    }
  }
  _lucideIconCache = set;
  return set;
}

function kebabToPascal(s: string): string {
  return s.split("-").map(p => p ? p[0]!.toUpperCase() + p.slice(1) : p).join("");
}

const COMPONENT_ALLOWED_IMPORTS = [
  '@/sdk',
  'react',
  'framer-motion',
  'lucide-react',
  'react-katex',
  'recharts',
  'three',
  '@react-three/fiber',
  '@react-three/drei',
  'zustand',
  'react-router-dom',
  'react-resizable-panels',
  '@monaco-editor/react',
  'matter-js',
  'react-syntax-highlighter',
  'katex',
];

export async function validateComponentFile(filePath: string): Promise<string[]> {
  const errors: string[] = [];
  const content = await readFile(filePath, 'utf-8');

  if (!(/export\s+default\s/.test(content)) && !(/export\s+(function|const)\s/.test(content))) {
    errors.push('Missing React component export (need export default or export function/const)');
  }

  const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1]!;
    if (importPath.startsWith('.') || importPath.startsWith('@/')) {
      if (!importPath.startsWith('@/sdk') && !importPath.startsWith('./') && !importPath.startsWith('../')) {
        errors.push(`Disallowed import path: "${importPath}" — use @/sdk for SDK components`);
      }
    } else {
      const isAllowed = COMPONENT_ALLOWED_IMPORTS.some(allowed =>
        importPath === allowed || importPath.startsWith(allowed + '/')
      );
      if (!isAllowed) {
        errors.push(`Disallowed import: "${importPath}" — not in allowed dependencies`);
      }
    }
  }

  errors.push(...validateLucideImports(content));

  const brackets = checkBrackets(content);
  if (brackets) errors.push(brackets);

  return errors;
}

/**
 * Scan `import { Foo, Bar } from 'lucide-react'` lines and reject any name
 * that isn't a real lucide icon. Returns [] if the icon set can't be loaded
 * (e.g. running outside a workspace with the template installed) so we don't
 * generate false positives during tests.
 */
function validateLucideImports(content: string): string[] {
  const errors: string[] = [];
  const icons = loadLucideIcons();
  if (icons.size === 0) return errors;
  // Match: import {  A, B as C, type D  } from 'lucide-react'
  const re = /import\s*(?:type\s+)?\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const names = m[1]!.split(',').map(s => s.trim()).filter(Boolean);
    const bad: string[] = [];
    for (const raw of names) {
      // Strip "type " prefix and "X as Y" alias (only the imported name matters).
      const cleaned = raw.replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (!cleaned) continue;
      if (!icons.has(cleaned)) bad.push(cleaned);
    }
    if (bad.length > 0) {
      errors.push(`Unknown lucide-react icon(s): ${bad.join(', ')} — check name spelling at lucide.dev/icons`);
    }
  }
  return errors;
}

export async function validateAppFile(filePath: string): Promise<string[]> {
  const errors: string[] = [];
  const content = await readFile(filePath, 'utf-8');

  if (!(/export\s+default\s/.test(content))) {
    errors.push('App.tsx must have a default export');
  }

  const brackets = checkBrackets(content);
  if (brackets) errors.push(brackets);

  return errors;
}

function checkBrackets(content: string): string | null {
  const cleaned = content
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'[^']*'/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/`[^`]*`/g, '');

  let curly = 0;
  let paren = 0;
  for (const ch of cleaned) {
    if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '(') paren++;
    else if (ch === ')') paren--;
  }

  const issues: string[] = [];
  if (curly !== 0) issues.push(`Unmatched curly braces: ${curly} unclosed`);
  if (paren !== 0) issues.push(`Unmatched parentheses: ${paren} unclosed`);
  return issues.length > 0 ? issues.join('; ') : null;
}

export async function validateAllComponents(componentsDir: string): Promise<FileValidationError[]> {
  const results: FileValidationError[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
        const errors = await validateComponentFile(fullPath);
        if (errors.length > 0) {
          results.push({ file: fullPath, errors });
        }
      }
    }
  }

  await walk(componentsDir);
  return results;
}

/**
 * Remove import lines from App.tsx that reference component files that no longer exist.
 * Returns both the number of removed import lines AND the total `./components/X`
 * import lines seen, so the caller can detect "removed === total" (every component
 * import was dead) and treat that as a hard failure rather than a silent pass.
 */
export async function removeDeadImports(
  appFilePath: string,
  existingComponentFiles: string[],
): Promise<{ removed: number; total: number }> {
  const content = await readFile(appFilePath, 'utf-8');
  const lines = content.split('\n');

  const existingSet = new Set(
    existingComponentFiles.map(f => f.replace(/\.tsx?$/, ''))
  );

  let removedCount = 0;
  let totalCount = 0;
  const newLines = lines.map(line => {
    const importMatch = line.match(/import\s+.*?\s+from\s+['"]\.\/components\/([^'"]+)['"]/);
    if (importMatch) {
      totalCount++;
      const importedPath = importMatch[1]!.replace(/\.tsx?$/, '');
      if (!existingSet.has(importedPath)) {
        removedCount++;
        return `// [removed: missing file] ${line}`;
      }
    }
    return line;
  });

  if (removedCount > 0) {
    await writeFile(appFilePath, newLines.join('\n'), 'utf-8');
  }

  return { removed: removedCount, total: totalCount };
}

export function parseBuildErrors(output: string): BuildError[] {
  const errors: BuildError[] = [];
  const cleaned = output.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = cleaned.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const esbuildMatch = line.match(/([A-Za-z]:[\\/][^:]+\.tsx?):(\d+):\d+:\s*ERROR:\s*(.*)/)
      || line.match(/([^:\s]+\.tsx?):(\d+):\d+:\s*ERROR:\s*(.*)/);
    if (esbuildMatch) {
      const msg = esbuildMatch[3]!;
      let type: BuildError['type'] = 'unknown';
      if (msg.includes('import') || msg.includes('module')) type = 'import';
      else if (msg.includes('Expected') || msg.includes('Unexpected')) type = 'syntax';
      else if (msg.includes('Type') || msg.includes('type')) type = 'type';
      errors.push({ file: esbuildMatch[1]!, line: parseInt(esbuildMatch[2]!, 10), message: msg, type });
      continue;
    }

    const tsMatch = line.match(/([A-Za-z]:[\\/][^(]+\.tsx?)\((\d+),\d+\):\s*error\s+\w+:\s*(.*)/)
      || line.match(/([^(\s]+\.tsx?)\((\d+),\d+\):\s*error\s+\w+:\s*(.*)/);
    if (tsMatch) {
      errors.push({ file: tsMatch[1]!, line: parseInt(tsMatch[2]!, 10), message: tsMatch[3]!, type: 'type' });
      continue;
    }

    const fileMatch = line.match(/^\s*file:\s*(.+\.tsx?):(\d+)/);
    if (fileMatch) {
      const nextLine = lines[i + 1] || '';
      errors.push({ file: fileMatch[1]!, line: parseInt(fileMatch[2]!, 10), message: nextLine.trim(), type: 'unknown' });
      continue;
    }

    // Rollup "X is not exported by Y" — emitted as e.g.
    //   src/components/Foo.tsx (2:14): "Road" is not exported by "../node_modules/lucide-react/..."
    // Without this branch, parseBuildErrors returns 0 and buildWithAIRepair
    // bails out without ever invoking the AI repair path for the most common
    // failure (icon/symbol typos in lucide-react & friends).
    const rollupExportMatch = line.match(/^\s*(.+?\.tsx?)\s*\((\d+):\d+\):\s*"([^"]+)"\s+is not exported by\s+"([^"]+)"/);
    if (rollupExportMatch) {
      errors.push({
        file: rollupExportMatch[1]!,
        line: parseInt(rollupExportMatch[2]!, 10),
        message: `"${rollupExportMatch[3]}" is not exported by "${rollupExportMatch[4]}"`,
        type: 'import',
      });
      continue;
    }

    // Generic vite plugin error: [vite:plugin-name] message...
    // No file/line is available in the line itself; the next 1-3 lines often
    // carry the body. We surface them as a single 'unknown' error so the
    // repair loop and the operator at least see the cause instead of an empty
    // "unparseable" warning.
    const vitePluginMatch = line.match(/^\s*\[(vite:[^\]]+|plugin\s+[^\]]+)\]\s*(.+)$/);
    if (vitePluginMatch) {
      const tail = lines.slice(i + 1, i + 4)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('at '))
        .join(' ');
      errors.push({
        file: '<vite>',
        line: 0,
        message: `[${vitePluginMatch[1]}] ${vitePluginMatch[2]} ${tail}`.trim(),
        type: 'unknown',
      });
      continue;
    }
  }

  return errors;
}

/**
 * Parse tsc diagnostic output (--pretty false) into BuildError[].
 * Format: path(line,col): error TS1234: message
 */
function parseTscErrors(output: string, sourceDir: string): BuildError[] {
  const errors: BuildError[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Standard tsc format: path(line,col): error TSxxxx: message
    const match = line.match(/^(.+?)\((\d+),\d+\):\s*error\s+TS\d+:\s*(.+)/);
    if (!match) continue;

    const file = match[1]!;
    // Only include errors from user-generated code, not SDK or node_modules
    if (file.includes("node_modules") || file.includes("sdk/")) continue;

    const relPath = file.replace(/\\/g, "/");
    if (!relPath.includes("src/App.tsx") && !relPath.includes("src/components/")) continue;

    errors.push({
      file: resolve(sourceDir, file),
      line: parseInt(match[2]!, 10),
      message: match[3]!.trim(),
      type: 'type',
    });
  }

  return errors;
}

/**
 * Run tsc --noEmit against the project to detect type errors before vite build.
 * Returns only errors from App.tsx and components/ — ignores SDK internals.
 * Gracefully returns [] on timeout or missing tsc binary.
 */
export async function typeCheckProject(sourceDir: string): Promise<BuildError[]> {
  try {
    const tscCmd = existsSync(join(sourceDir, "node_modules", ".bin", "tsc.cmd"))
      ? `"${join(sourceDir, "node_modules", ".bin", "tsc.cmd")}"`
      : existsSync(join(sourceDir, "node_modules", ".bin", "tsc"))
        ? `"${join(sourceDir, "node_modules", ".bin", "tsc")}"`
        : existsSync(join(getTemplateDir(), "node_modules", ".bin", "tsc.cmd"))
          ? `"${join(getTemplateDir(), "node_modules", ".bin", "tsc.cmd")}"`
          : null;

    if (!tscCmd) return [];

    const result = await execAsync(
      `${tscCmd} --noEmit --pretty false --skipLibCheck`,
      { cwd: sourceDir, timeout: 30_000 },
    ).catch((err: any) => ({
      stdout: (err.stdout as string) || "",
      stderr: (err.stderr as string) || "",
    }));

    return parseTscErrors(
      (result.stdout || "") + "\n" + (result.stderr || ""),
      sourceDir,
    );
  } catch {
    return [];
  }
}
