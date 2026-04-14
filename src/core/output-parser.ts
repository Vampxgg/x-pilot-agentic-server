import type { OutputFormatConfig } from "./types.js";
import { logger } from "../utils/logger.js";

export interface ParsedOutput {
  parsed: unknown;
  raw: string;
  format: "text" | "json" | "code";
  warnings: string[];
}

const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)```/;
const FENCED_CODE_RE = (lang?: string) =>
  new RegExp(`\`\`\`(?:${lang ?? "\\w+"})\\s*\\n([\\s\\S]*?)\`\`\``);

function tryParseJson(raw: string): { value: unknown; source: string } | null {
  const trimmed = raw.trim();

  // Try the raw string directly (bare JSON)
  try {
    return { value: JSON.parse(trimmed), source: "bare" };
  } catch { /* not bare JSON */ }

  // Try extracting from fenced code block
  const fenced = FENCED_JSON_RE.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return { value: JSON.parse(fenced[1].trim()), source: "fenced" };
    } catch { /* invalid JSON inside fence */ }
  }

  // Try extracting the first { ... } or [ ... ] block
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  const start = firstBrace >= 0 && firstBracket >= 0
    ? Math.min(firstBrace, firstBracket)
    : Math.max(firstBrace, firstBracket);

  if (start >= 0) {
    const isArray = trimmed[start] === "[";
    const closer = isArray ? "]" : "}";
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === trimmed[start]) depth++;
      else if (trimmed[i] === closer) depth--;
      if (depth === 0) {
        try {
          return { value: JSON.parse(trimmed.slice(start, i + 1)), source: "extracted" };
        } catch { break; }
      }
    }
  }

  return null;
}

function extractCodeBlock(raw: string, language?: string): string | null {
  const re = FENCED_CODE_RE(language);
  const match = re.exec(raw.trim());
  return match?.[1]?.trim() ?? null;
}

function validateJsonSchema(value: unknown, schema: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  if (typeof value !== "object" || value === null) {
    warnings.push(`Expected object/array, got ${typeof value}`);
    return warnings;
  }

  const schemaType = schema.type as string | undefined;
  if (schemaType === "object" && !Array.isArray(value)) {
    const required = (schema.required as string[]) ?? [];
    const obj = value as Record<string, unknown>;
    for (const key of required) {
      if (!(key in obj)) {
        warnings.push(`Missing required field: "${key}"`);
      }
    }
  } else if (schemaType === "array" && !Array.isArray(value)) {
    warnings.push(`Expected array, got object`);
  }

  return warnings;
}

export function parseAgentOutput(raw: string, format?: OutputFormatConfig): ParsedOutput {
  if (!format || format.type === "text") {
    return { parsed: raw, raw, format: "text", warnings: [] };
  }

  if (format.type === "json") {
    const result = tryParseJson(raw);
    if (!result) {
      logger.warn("Output format is json but failed to extract JSON from agent output");
      return {
        parsed: raw,
        raw,
        format: "json",
        warnings: ["Failed to extract JSON from agent output; returning raw text"],
      };
    }

    const warnings: string[] = [];
    if (format.schema) {
      warnings.push(...validateJsonSchema(result.value, format.schema));
    }

    return { parsed: result.value, raw, format: "json", warnings };
  }

  if (format.type === "code") {
    const code = extractCodeBlock(raw, format.codeLanguage);
    if (!code) {
      logger.warn("Output format is code but no code block found in agent output");
      return {
        parsed: raw,
        raw,
        format: "code",
        warnings: [`No fenced code block (${format.codeLanguage ?? "any"}) found; returning raw text`],
      };
    }

    return { parsed: code, raw, format: "code", warnings: [] };
  }

  return { parsed: raw, raw, format: "text", warnings: [] };
}
