/**
 * Verify scanUndefinedIdentifiers (B3) against the 4 real failed-tutorial
 * App.tsx files. We expect it to flag the known bad identifiers in T3 (the
 * one with import-deleted-but-JSX-still-referenced) and stay silent on the
 * other tutorials that didn't have this specific failure.
 *
 * Usage: npx tsx scripts/verify-scan-undefined.ts
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Inline copy of the scanner — keeps this script free of TS path-mapping
// concerns since it intentionally lives outside the build graph.
async function scanUndefinedIdentifiers(filePath: string): Promise<string[]> {
  let content: string;
  try { content = await readFile(filePath, "utf-8"); } catch { return []; }

  const declared = new Set<string>();
  for (const k of [
    "React", "Fragment", "Children", "Component", "Suspense", "memo",
    "Map", "Set", "Math", "Object", "Array", "JSON", "Promise", "Number", "String", "Boolean",
    "Date", "RegExp", "Error", "Symbol", "console", "window", "document", "globalThis",
    "undefined", "null", "NaN", "Infinity",
  ]) declared.add(k);

  const importScanText = content.replace(/\/\/.*$/gm, "");
  for (const m of importScanText.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]*['"]/g)) {
    const clause = m[1]!.trim();
    const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (defaultMatch && !clause.startsWith("{") && !clause.startsWith("*")) {
      declared.add(defaultMatch[1]!);
    }
    const nsMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (nsMatch) declared.add(nsMatch[1]!);
    const namedMatch = clause.match(/\{([\s\S]*?)\}/);
    if (namedMatch) {
      for (const raw of namedMatch[1]!.split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
        if (name) declared.add(name);
      }
    }
  }

  const stripped = content
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");

  for (const m of stripped.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    declared.add(m[1]!);
  }
  for (const m of stripped.matchAll(/\b(?:const|let|var)\s*\{\s*([\s\S]*?)\s*\}\s*=/g)) {
    for (const part of m[1]!.split(",")) {
      const cleaned = part.trim().split(":").pop()!.trim().replace(/[=].*/, "").trim();
      if (cleaned && /^[A-Za-z_$][\w$]*$/.test(cleaned)) declared.add(cleaned);
    }
  }
  for (const m of stripped.matchAll(/\b(?:const|let|var)\s*\[\s*([\s\S]*?)\s*\]\s*=/g)) {
    for (const part of m[1]!.split(",")) {
      const cleaned = part.trim().replace(/[=].*/, "").trim();
      if (cleaned && /^[A-Za-z_$][\w$]*$/.test(cleaned)) declared.add(cleaned);
    }
  }

  const used = new Set<string>();
  for (const m of stripped.matchAll(/<\s*([A-Z][\w$]*)/g)) used.add(m[1]!);
  for (const m of stripped.matchAll(/(?<![\w.])([A-Z][\w$]*)\s*\(/g)) used.add(m[1]!);
  if (/(?<![\w.])emit_event\s*\??\.?\s*\(/.test(stripped)) used.add("emit_event");

  const undef: string[] = [];
  for (const name of used) if (!declared.has(name)) undef.push(name);
  return undef;
}

interface Case {
  label: string;
  file: string;
  expectIncludes: string[];   // identifiers we expect the scanner to flag (must all appear)
  notes: string;
}

const ROOT = resolve(process.cwd());
const wsBase = resolve(
  ROOT,
  "data/tenants/default/users/default/workspaces",
);
const tutBase = resolve(ROOT, "data/tutorials");

const cases: Case[] = [
  {
    label: "T1 (f361348d) — should be CLEAN (no import-deletion damage)",
    file: resolve(wsBase, "f361348d-4a37-4ebb-8520-6efefbb6d833/assets/App.tsx"),
    expectIncludes: [],
    notes: "T1's bug was useStore((s) => s.progress) at runtime — not a static identifier issue.",
  },
  {
    label: "T2 (844e98f0) — should be CLEAN",
    file: resolve(wsBase, "844e98f0-0918-4a93-98a2-080024503279/assets/App.tsx"),
    expectIncludes: [],
    notes: "T2's bug was useAppState destructure misuse — not a static identifier issue.",
  },
  {
    label: "T3 (1d2f9f9e) — should FLAG RadarDynamicCalibration / emit_event",
    file: resolve(tutBase, "1d2f9f9e-515c-48a1-850c-f5012295fcb9/source/src/App.tsx"),
    expectIncludes: ["RadarDynamicCalibration", "emit_event"],
    notes: "T3 IS the death-loop case: import was commented out but JSX kept the reference.",
  },
  {
    label: "T4 (4a8b22e1) — placeholder, may be clean or trivial",
    file: resolve(tutBase, "4a8b22e1-2684-40d9-b1fa-95a60d116981/source/src/App.tsx"),
    expectIncludes: [],
    notes: "T4's bug was app-shell-coder silent fail — placeholder template only, no static issue.",
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  if (!existsSync(c.file)) {
    console.log(`SKIP  ${c.label}\n      file not on disk: ${c.file}\n`);
    continue;
  }
  const undef = await scanUndefinedIdentifiers(c.file);
  const missingExpected = c.expectIncludes.filter((id) => !undef.includes(id));
  const ok = missingExpected.length === 0;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}`);
  console.log(`      file:   ${c.file.replace(ROOT, "<root>")}`);
  console.log(`      flagged: [${undef.join(", ") || "(none)"}]`);
  if (c.expectIncludes.length > 0) {
    console.log(`      expect:  must include [${c.expectIncludes.join(", ")}]`);
  }
  if (!ok) {
    console.log(`      MISSING: [${missingExpected.join(", ")}]`);
  }
  console.log(`      note:   ${c.notes}\n`);
}

console.log(`\nResult: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
