import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { FileValidationError, BuildError } from "./types.js";
import { getTemplateDir } from "./template-dir.js";
import { logger } from "../../../src/utils/logger.js";

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
  'react',
  'react-dom',
  'react-router-dom',
  'framer-motion',
  'lucide-react',
  'recharts',
  'd3',
  'three',
  '@react-three/fiber',
  '@react-three/drei',
  '@react-spring/web',
  '@tanstack/react-query',
  '@xyflow/react',
  'katex',
  'react-katex',
  'date-fns',
  'zod',
  'papaparse',
  'react-resizable-panels',
  'react-hook-form',
  '@hookform/resolvers',
  'sonner',
  'cmdk',
  'embla-carousel-react',
  'leva',
  'class-variance-authority',
  'clsx',
  'tailwind-merge',
  'vaul',
  'input-otp',
  'next-themes',
  '@radix-ui',
  'zustand',
  'matter-js',
  '@monaco-editor/react',
  'react-syntax-highlighter',
  'react-day-picker',
  'tailwindcss-animate',
];

export async function validateComponentFile(filePath: string): Promise<string[]> {
  const errors: string[] = [];
  let content = await readFile(filePath, 'utf-8');

  // Auto-fix renamed lucide icons before validation
  const lucideFix = fixRenamedLucideIcons(content);
  if (lucideFix.fixes > 0) {
    content = lucideFix.content;
    await writeFile(filePath, content, 'utf-8');
    logger.info(`[validateComponentFile] Auto-fixed ${lucideFix.fixes} renamed lucide icon(s) in ${filePath.replace(/.*[/\\]/, '')}`);
  }

  const cnFix = ensureCnImport(content);
  if (cnFix.fixed) {
    content = cnFix.content;
    await writeFile(filePath, content, 'utf-8');
    logger.info(`[validateComponentFile] Auto-added cn import in ${filePath.replace(/.*[/\\]/, '')}`);
  }

  if (!(/export\s+default\s/.test(content)) && !(/export\s+(function|const)\s/.test(content))) {
    errors.push('Missing React component export (need export default or export function/const)');
  }

  const ALLOWED_ALIAS_PREFIXES = [
    '@/components/ui',
    '@/lib',
    '@/utils',
    '@/pages',
    '@/components/',
  ];

  const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1]!;
    if (importPath.startsWith('.') || importPath.startsWith('@/')) {
      if (importPath.startsWith('./') || importPath.startsWith('../')) continue;
      const aliasOk = ALLOWED_ALIAS_PREFIXES.some(p => importPath.startsWith(p));
      if (!aliasOk) {
        errors.push(`Disallowed import path: "${importPath}" — allowed alias prefixes: ${ALLOWED_ALIAS_PREFIXES.join(', ')}`);
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

function ensureCnImport(content: string): { content: string; fixed: boolean } {
  if (!/(^|[^\w$])cn\s*\(/.test(content)) {
    return { content, fixed: false };
  }
  if (/import\s*\{[^}]*\bcn\b[^}]*\}\s*from\s*['"]@\/lib\/utils['"]/.test(content)) {
    return { content, fixed: false };
  }
  if (/\b(function|const|let|var)\s+cn\b/.test(content)) {
    return { content, fixed: false };
  }

  const lines = content.split(/\r?\n/);
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\b/.test(lines[i]!)) lastImportIdx = i;
  }
  const importLine = 'import { cn } from "@/lib/utils";';
  if (lastImportIdx >= 0) {
    lines.splice(lastImportIdx + 1, 0, importLine);
    return { content: lines.join('\n'), fixed: true };
  }
  return { content: `${importLine}\n${content}`, fixed: true };
}

/**
 * Lucide v0.400+ renamed many icons from {Modifier}{Shape} to {Shape}{Modifier}.
 * AI models frequently generate the old names from training data. This map lets
 * us auto-fix them before the validation rejects the file entirely.
 */
const LUCIDE_RENAME_MAP: Record<string, string> = {
  AlertCircle: "CircleAlert",
  AlertOctagon: "OctagonAlert",
  AlertTriangle: "TriangleAlert",
  CheckCircle: "CircleCheck",
  CheckCircle2: "CircleCheckBig",
  XCircle: "CircleX",
  XOctagon: "OctagonX",
  HelpCircle: "CircleHelp",
  PauseCircle: "CirclePause",
  PlayCircle: "CirclePlay",
  PlusCircle: "CirclePlus",
  MinusCircle: "CircleMinus",
  StopCircle: "CircleStop",
  ArrowUpCircle: "CircleArrowUp",
  ArrowDownCircle: "CircleArrowDown",
  ArrowLeftCircle: "CircleArrowLeft",
  ArrowRightCircle: "CircleArrowRight",
  ChevronUpCircle: "CircleChevronUp",
  ChevronDownCircle: "CircleChevronDown",
  ChevronLeftCircle: "CircleChevronLeft",
  ChevronRightCircle: "CircleChevronRight",
  UserCircle: "CircleUser",
  UserCircle2: "CircleUserRound",
  DollarSign: "CircleDollarSign",
  Slash: "CircleSlash",
  Dot: "CircleDot",
  Edit: "Pencil",
  Edit2: "PencilLine",
  Edit3: "Pen",
  Trash: "Trash2",
  ExternalLink: "ExternalLink",
};

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
  const re = /import\s*(?:type\s+)?\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const names = m[1]!.split(',').map(s => s.trim()).filter(Boolean);
    const bad: string[] = [];
    for (const raw of names) {
      const cleaned = raw.replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (!cleaned) continue;
      if (!icons.has(cleaned)) {
        const renamed = LUCIDE_RENAME_MAP[cleaned];
        if (renamed && icons.has(renamed)) {
          bad.push(`${cleaned} (renamed to ${renamed})`);
        } else {
          bad.push(cleaned);
        }
      }
    }
    if (bad.length > 0) {
      errors.push(`Unknown lucide-react icon(s): ${bad.join(', ')} — check name spelling at lucide.dev/icons`);
    }
  }
  return errors;
}

/**
 * Auto-fix renamed lucide icons in file content. Replaces old PascalCase names
 * with new ones both in import statements and JSX usage throughout the file.
 * Returns the fixed content and the number of replacements made.
 */
export function fixRenamedLucideIcons(content: string): { content: string; fixes: number } {
  const icons = loadLucideIcons();
  if (icons.size === 0) return { content, fixes: 0 };

  let fixed = content;
  let fixes = 0;

  for (const [oldName, newName] of Object.entries(LUCIDE_RENAME_MAP)) {
    if (!icons.has(newName)) continue;
    if (icons.has(oldName)) continue;
    const re = new RegExp(`\\b${oldName}\\b`, 'g');
    const replaced = fixed.replace(re, newName);
    if (replaced !== fixed) {
      fixed = replaced;
      fixes++;
    }
  }

  return { content: fixed, fixes };
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

/**
 * Reserved subdirectories under src/components/ that belong to the template
 * runtime shell. These must NEVER be validated, repaired, or deleted.
 */
const RESERVED_COMPONENT_DIRS = new Set(["ui", "layout", "system"]);
const RESERVED_COMPONENT_FILES = new Set(["theme-provider.tsx", "theme-toggle.tsx"]);

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
        if (dir === componentsDir && RESERVED_COMPONENT_DIRS.has(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
        if (dir === componentsDir && RESERVED_COMPONENT_FILES.has(entry.name)) continue;
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
 * Remove import lines from App.tsx (or page files) that reference component/page
 * files that no longer exist. Supports both old `./components/X` and new
 * `@/components/X`, `@/pages/X` import styles.
 *
 * Returns both the number of removed import lines AND the total user-code
 * import lines seen, so the caller can detect "removed === total" (every
 * import was dead) and treat that as a hard failure rather than a silent pass.
 */
/**
 * Extract the default-import identifier from an import statement.
 * Handles: `import Foo from "..."` and `import Foo, { ... } from "..."`.
 */
function extractDefaultImportName(importLine: string): string | null {
  const m = importLine.match(/import\s+([A-Z][A-Za-z0-9_]*)\s*(?:,|\s+from)/);
  return m ? m[1]! : null;
}

/**
 * Extract named import identifiers from an import statement.
 * Handles: `import { Foo, Bar as Baz } from "..."`.
 * Returns the local names (e.g. Baz not Bar in a rename).
 */
function extractNamedImportNames(importLine: string): string[] {
  const m = importLine.match(/import\s+(?:[A-Za-z_]\w*\s*,\s*)?\{([^}]+)\}\s+from/);
  if (!m) return [];
  return m[1]!.split(',').map(s => {
    const parts = s.trim().split(/\s+as\s+/);
    return (parts[1] || parts[0])!.trim();
  }).filter(Boolean);
}

export async function removeDeadImports(
  appFilePath: string,
  existingComponentFiles: string[],
  existingPageFiles: string[] = [],
): Promise<{ removed: number; total: number }> {
  const content = await readFile(appFilePath, 'utf-8');
  const lines = content.split('\n');

  const componentSet = new Set(
    existingComponentFiles.map(f => f.replace(/\.tsx?$/, ''))
  );
  const pageSet = new Set(
    existingPageFiles.map(f => f.replace(/\.tsx?$/, ''))
  );

  const RESERVED_ALIAS_PREFIXES = ['ui/', 'layout/', 'system/', 'theme-'];
  const RESERVED_PAGES = new Set(['RouteErrorPage', 'NotFoundPage']);

  let removedCount = 0;
  let totalCount = 0;
  const removedSymbols: string[] = [];

  // Collect symbols already stubbed from previous runs to avoid duplicates
  const existingStubs = new Set<string>();
  for (const line of lines) {
    const stubMatch = line.match(/^const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*\(\)\s*=>\s*null;\s*\/\/ stub for removed component/);
    if (stubMatch) existingStubs.add(stubMatch[1]!);
  }

  const newLines = lines.map(line => {
    // Skip lines already processed by a previous removeDeadImports pass
    if (line.trimStart().startsWith('// [removed: missing file]')) return line;
    // Skip existing stub lines
    if (line.match(/^const\s+[A-Z]\w*\s*=\s*\(\)\s*=>\s*null;\s*\/\/ stub for removed component/)) return line;

    // Old style: ./components/X
    const oldMatch = line.match(/import\s+.*?\s+from\s+['"]\.\/components\/([^'"]+)['"]/);
    if (oldMatch) {
      totalCount++;
      const importedPath = oldMatch[1]!.replace(/\.tsx?$/, '');
      if (!componentSet.has(importedPath)) {
        removedCount++;
        const sym = extractDefaultImportName(line);
        if (sym) removedSymbols.push(sym);
        removedSymbols.push(...extractNamedImportNames(line));
        return `// [removed: missing file] ${line}`;
      }
      return line;
    }

    // New style: @/components/X (skip reserved prefixes like ui/, layout/, system/)
    const aliasCompMatch = line.match(/import\s+.*?\s+from\s+['"]@\/components\/([^'"]+)['"]/);
    if (aliasCompMatch) {
      const importedPath = aliasCompMatch[1]!.replace(/\.tsx?$/, '');
      const isReserved = RESERVED_ALIAS_PREFIXES.some(p => importedPath.startsWith(p));
      if (!isReserved) {
        totalCount++;
        if (!componentSet.has(importedPath)) {
          removedCount++;
          const sym = extractDefaultImportName(line);
          if (sym) removedSymbols.push(sym);
          removedSymbols.push(...extractNamedImportNames(line));
          return `// [removed: missing file] ${line}`;
        }
      }
      return line;
    }

    // New style: @/pages/X (skip reserved pages)
    const aliasPageMatch = line.match(/import\s+.*?\s+from\s+['"]@\/pages\/([^'"]+)['"]/);
    if (aliasPageMatch) {
      const importedPath = aliasPageMatch[1]!.replace(/\.tsx?$/, '');
      if (!RESERVED_PAGES.has(importedPath)) {
        totalCount++;
        if (!pageSet.has(importedPath)) {
          removedCount++;
          const sym = extractDefaultImportName(line);
          if (sym) removedSymbols.push(sym);
          removedSymbols.push(...extractNamedImportNames(line));
          return `// [removed: missing file] ${line}`;
        }
      }
      return line;
    }

    return line;
  });

  if (removedCount > 0) {
    // Inject stub declarations so that references to removed symbols don't
    // cause ReferenceError at build/runtime. Each removed component becomes
    // a no-op `() => null` placeholder. Deduplicate against stubs from
    // previous runs and within the current batch.
    const newStubSymbols = [...new Set(removedSymbols)].filter(s => !existingStubs.has(s));

    if (newStubSymbols.length > 0) {
      const stubs = newStubSymbols
        .map(s => `const ${s} = () => null; // stub for removed component`)
        .join('\n');

      let lastImportIdx = -1;
      for (let i = 0; i < newLines.length; i++) {
        const trimmed = newLines[i]!.trimStart();
        if (
          trimmed.startsWith('import ') ||
          trimmed.startsWith('// [removed: missing file]')
        ) {
          lastImportIdx = i;
        }
      }
      if (lastImportIdx >= 0) {
        newLines.splice(lastImportIdx + 1, 0, stubs);
      }
    }

    await writeFile(appFilePath, newLines.join('\n'), 'utf-8');
  }

  return { removed: removedCount, total: totalCount };
}

/**
 * Scan page files in `pagesDir` and detect inline-defined components that
 * already exist as standalone files in `componentsDir`. When found, remove
 * the inline definition and ensure the page has a proper import statement.
 *
 * This is a defensive safety net: the App Shell Coder prompt forbids inline
 * re-definitions, but if the LLM does it anyway we fix it automatically.
 */
export async function deInlineComponents(
  pagesDir: string,
  componentsDir: string,
): Promise<number> {
  if (!existsSync(pagesDir) || !existsSync(componentsDir)) return 0;

  const compEntries = await readdir(componentsDir, { withFileTypes: true });
  const componentNames = new Set<string>();
  for (const e of compEntries) {
    if (e.isFile() && /\.tsx?$/.test(e.name)) {
      componentNames.add(e.name.replace(/\.tsx?$/, ''));
    }
  }
  if (componentNames.size === 0) return 0;

  const RESERVED_PAGES = new Set(['RouteErrorPage.tsx', 'NotFoundPage.tsx']);
  let totalFixed = 0;

  const pageEntries = await readdir(pagesDir, { withFileTypes: true });
  for (const pe of pageEntries) {
    if (!pe.isFile() || RESERVED_PAGES.has(pe.name)) continue;
    if (!pe.name.endsWith('.tsx') && !pe.name.endsWith('.ts')) continue;

    const pageFile = join(pagesDir, pe.name);
    const content = await readFile(pageFile, 'utf-8');
    const lines = content.split('\n');

    const inlinedNames: string[] = [];
    const inlineRanges: [number, number][] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Match: function ComponentName(...)  or  const ComponentName = (...) =>
      // or: const ComponentName: React.FC = (...) =>
      const funcMatch = line.match(
        /^(?:export\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*)\s*(?:[:(=])/,
      );
      if (!funcMatch) continue;
      const name = funcMatch[1]!;
      if (!componentNames.has(name)) continue;

      // Skip if this is just a stub from removeDeadImports
      if (line.includes('// stub for removed component')) continue;

      // Found an inlined component that exists in components dir.
      // Determine the extent of the inline definition (from current line to
      // its closing brace). We use a simple brace-counting heuristic.
      let braceDepth = 0;
      let start = i;
      let end = i;
      let started = false;

      for (let j = i; j < lines.length; j++) {
        const l = lines[j]!;
        for (const ch of l) {
          if (ch === '{') { braceDepth++; started = true; }
          else if (ch === '}') { braceDepth--; }
        }
        end = j;
        if (started && braceDepth <= 0) break;
      }

      inlinedNames.push(name);
      inlineRanges.push([start, end]);
    }

    if (inlinedNames.length === 0) continue;

    // Remove inline definitions (from bottom to top so indices stay valid)
    const newLines = [...lines];
    for (let r = inlineRanges.length - 1; r >= 0; r--) {
      const [start, end] = inlineRanges[r]!;
      newLines.splice(start, end - start + 1);
    }

    // Ensure import statements exist for each de-inlined component
    const existingImports = new Set<string>();
    for (const line of newLines) {
      const m = line.match(
        /import\s+.*?\bfrom\s+['"]@\/components\/([^'"]+)['"]/,
      );
      if (m) existingImports.add(m[1]!.replace(/\.tsx?$/, ''));
    }

    const missingImports: string[] = [];
    for (const name of inlinedNames) {
      if (!existingImports.has(name)) {
        missingImports.push(
          `import ${name} from '@/components/${name}';`,
        );
      }
    }

    if (missingImports.length > 0) {
      let lastImportIdx = -1;
      for (let i = 0; i < newLines.length; i++) {
        const trimmed = newLines[i]!.trimStart();
        if (trimmed.startsWith('import ') || trimmed.startsWith('// [removed:')) {
          lastImportIdx = i;
        }
      }
      const insertAt = lastImportIdx >= 0 ? lastImportIdx + 1 : 0;
      newLines.splice(insertAt, 0, ...missingImports);
    }

    await writeFile(pageFile, newLines.join('\n'), 'utf-8');
    totalFixed += inlinedNames.length;
  }

  return totalFixed;
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
    if (file.includes("node_modules")) continue;

    const relPath = file.replace(/\\/g, "/");
    if (!relPath.includes("src/App.tsx") && !relPath.includes("src/components/") && !relPath.includes("src/pages/")) continue;

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
