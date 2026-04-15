import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { getModelByName } from "../../../src/llm/model-router.js";
import { getConfig } from "../../../src/utils/config.js";
import { logger } from "../../../src/utils/logger.js";
import type { BuildError } from "./types.js";
import { getTemplateDir } from "./template-dir.js";

const COMPONENT_ALLOWED_IMPORTS = [
  "@/sdk",
  "react",
  "framer-motion",
  "lucide-react",
  "react-katex",
  "recharts",
  "three",
  "@react-three/fiber",
  "@react-three/drei",
  "zustand",
  "react-router-dom",
  "react-resizable-panels",
  "@monaco-editor/react",
  "matter-js",
  "react-syntax-highlighter",
  "katex",
];

export interface RepairRequest {
  filePath: string;
  sourceCode: string;
  errors: string;
}

export interface RepairResult {
  filePath: string;
  fixed: boolean;
  fixedCode?: string;
  originalErrors: string;
}

let _sdkExportsCache: string | null = null;

async function loadSdkExports(): Promise<string> {
  if (_sdkExportsCache) return _sdkExportsCache;

  const indexPath = resolve(getTemplateDir(), "src", "sdk", "index.ts");
  if (!existsSync(indexPath)) {
    _sdkExportsCache = "(SDK exports unavailable)";
    return _sdkExportsCache;
  }

  const content = await readFile(indexPath, "utf-8");
  const exports: string[] = [];
  const exportRegex = /export\s*\{\s*(\w+)\s*\}/g;
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(match[1]!);
  }

  _sdkExportsCache = exports.length > 0
    ? exports.join(", ")
    : "(no exports found)";
  return _sdkExportsCache;
}

function getRepairModel() {
  const config = getConfig();
  const workerModel = config.agents.defaults.workerModel ?? config.agents.defaults.model;
  return getModelByName(workerModel);
}

function buildRepairPrompt(
  filePath: string,
  sourceCode: string,
  errors: string,
  sdkExports: string,
): string {
  const fileName = filePath.replace(/.*[/\\]/, "");
  const isAppFile = fileName === "App.tsx";

  return `你是一个 React/TypeScript 代码修复专家。请修复以下构建错误，返回完整的修正后代码。

## 环境约束
- 允许的第三方导入: ${COMPONENT_ALLOWED_IMPORTS.join(", ")}
- SDK 组件统一从 '@/sdk' 导入，可用: ${sdkExports}
- 组件之间使用相对路径 './' 或 '../' 导入
- ${isAppFile ? "这是主入口文件 App.tsx，必须有 export default" : "这是子组件文件，必须有 export default 或 export function/const"}
- 必须保持组件原有功能，仅修复错误

## 文件: ${fileName}

## 构建错误:
${errors}

## 当前源代码:
${sourceCode}

请直接返回修复后的完整 TypeScript/TSX 代码。不要包含 markdown 代码块标记（不要 \`\`\`）。不要包含任何解释文字，只返回代码。`;
}

function extractCodeFromResponse(response: string): string | null {
  let code = response.trim();

  const fenceMatch = code.match(/```(?:tsx|typescript|ts)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    code = fenceMatch[1]!.trim();
  }

  if (!code.includes("export")) return null;
  if (code.length < 20) return null;

  return code;
}

export async function repairFile(request: RepairRequest): Promise<RepairResult> {
  try {
    const sdkExports = await loadSdkExports();
    const model = getRepairModel();

    const prompt = buildRepairPrompt(
      request.filePath,
      request.sourceCode,
      request.errors,
      sdkExports,
    );

    logger.info(`[ai-repair] Attempting repair: ${request.filePath}`);

    const response = await model.invoke([new HumanMessage(prompt)]);
    const responseText = typeof response.content === "string"
      ? response.content
      : (response.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");

    const fixedCode = extractCodeFromResponse(responseText);

    if (fixedCode && fixedCode !== request.sourceCode) {
      logger.info(`[ai-repair] Successfully repaired: ${request.filePath} (${fixedCode.length} chars)`);
      return {
        filePath: request.filePath,
        fixed: true,
        fixedCode,
        originalErrors: request.errors,
      };
    }

    logger.warn(`[ai-repair] Repair returned no valid code: ${request.filePath}`);
    return {
      filePath: request.filePath,
      fixed: false,
      originalErrors: request.errors,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[ai-repair] Repair failed for ${request.filePath}: ${msg}`);
    return {
      filePath: request.filePath,
      fixed: false,
      originalErrors: request.errors,
    };
  }
}

export async function repairFiles(requests: RepairRequest[]): Promise<RepairResult[]> {
  const results: RepairResult[] = [];
  for (const req of requests) {
    const result = await repairFile(req);
    results.push(result);
  }
  return results;
}

export function groupErrorsByFile(errors: BuildError[]): Map<string, BuildError[]> {
  const grouped = new Map<string, BuildError[]>();
  for (const err of errors) {
    const existing = grouped.get(err.file) ?? [];
    existing.push(err);
    grouped.set(err.file, existing);
  }
  return grouped;
}

export function formatBuildErrors(errors: BuildError[]): string {
  return errors
    .map((e) => `Line ${e.line ?? "?"}: [${e.type}] ${e.message}`)
    .join("\n");
}

export { COMPONENT_ALLOWED_IMPORTS };
