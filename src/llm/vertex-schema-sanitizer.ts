import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { isOpenAITool } from "@langchain/core/language_models/base";
import { isLangChainTool } from "@langchain/core/utils/function_calling";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { logger } from "../utils/logger.js";

/**
 * Vertex / Gemini schema compatibility layer.
 *
 * Vertex AI function declarations are stricter than OpenAI-compatible schemas:
 * - forbidden metadata keys such as `additionalProperties`, `$schema`, `$ref`,
 *   `$id`, and `default`
 * - object schemas must have non-empty `properties`
 * - unions are represented as one concrete branch plus `nullable: true`
 *
 * The wrapper below normalizes LangChain, OpenAI, and Gemini tool shapes into
 * Gemini function declarations before binding tools to a Vertex model.
 */

const FORBIDDEN_KEYS = new Set([
  "additionalProperties",
  "$schema",
  "$ref",
  "$id",
  "default",
]);

interface JsonSchemaLike {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
}

/**
 * Recursively cleans a JSON Schema node for Gemini.
 *
 * Returning `undefined` means the node is an object without usable properties.
 * Callers drop that node from parent `properties` / `required`, omit top-level
 * `parameters`, or fall back array `items` to `{ type: "string" }`.
 */
export function sanitizeJsonSchemaForGemini(
  schema: unknown,
): JsonSchemaLike | undefined {
  if (schema === null || schema === undefined) return undefined;
  if (typeof schema !== "object") return schema as JsonSchemaLike;
  if (Array.isArray(schema)) return schema as unknown as JsonSchemaLike;

  const src = schema as Record<string, unknown>;
  const out: JsonSchemaLike = {};

  for (const [k, v] of Object.entries(src)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = v;
  }

  // type array, e.g. ["string", "null"], becomes one type plus nullable.
  if (Array.isArray(out.type)) {
    const types = (out.type as string[]).filter((t) => t !== "null");
    if ((out.type as string[]).includes("null")) out.nullable = true;
    out.type = types.length === 1 ? types[0] : types[0] ?? "string";
  }

  // anyOf / oneOf becomes one representable branch; nullable is preserved.
  const unionKey = out.anyOf ? "anyOf" : out.oneOf ? "oneOf" : undefined;
  if (unionKey && Array.isArray(out[unionKey])) {
    const branches = out[unionKey] as unknown[];
    delete out.anyOf;
    delete out.oneOf;

    const isNullBranch = (s: unknown): boolean =>
      typeof s === "object" && s !== null && (s as JsonSchemaLike).type === "null";

    const nonNull = branches.filter((b) => !isNullBranch(b));
    const hasNull = branches.length > nonNull.length;

    if (nonNull.length === 0) return undefined;

    if (nonNull.length > 1) {
      logger.warn(
        `[vertex-sanitizer] Cannot represent ${nonNull.length}-branch union for Gemini, using first branch`,
      );
    }

    const resolved = sanitizeJsonSchemaForGemini(nonNull[0]);
    if (!resolved) return undefined;

    if (out.description && !resolved.description) {
      resolved.description = out.description as string;
    }
    if (hasNull) resolved.nullable = true;
    return resolved;
  }

  // allOf is flattened to the first representable branch.
  if (Array.isArray(out.allOf)) {
    const items = out.allOf as unknown[];
    delete out.allOf;
    if (items.length >= 1) {
      if (items.length > 1) {
        logger.warn(
          `[vertex-sanitizer] allOf with ${items.length} elements, merging first only`,
        );
      }
      const resolved = sanitizeJsonSchemaForGemini(items[0]);
      if (!resolved) return undefined;
      if (out.description && !resolved.description) {
        resolved.description = out.description as string;
      }
      if (out.nullable) resolved.nullable = true;
      return resolved;
    }
  }

  // `not` is unsupported by Gemini.
  delete out.not;

  if (out.items !== undefined) {
    const cleanedItems = sanitizeJsonSchemaForGemini(out.items);
    out.items = cleanedItems ?? { type: "string" };
  }

  if (out.type === "object" || (out.properties && !out.type)) {
    const props =
      out.properties && typeof out.properties === "object"
        ? { ...(out.properties as Record<string, unknown>) }
        : null;

    if (!props || Object.keys(props).length === 0) {
      return undefined;
    }

    const cleanedProps: Record<string, JsonSchemaLike> = {};
    const dropped: string[] = [];
    for (const [pk, pv] of Object.entries(props)) {
      const cleaned = sanitizeJsonSchemaForGemini(pv);
      if (cleaned === undefined) {
        dropped.push(pk);
      } else {
        cleanedProps[pk] = cleaned;
      }
    }

    if (Object.keys(cleanedProps).length === 0) {
      return undefined;
    }

    out.properties = cleanedProps as unknown as Record<string, unknown>;

    if (Array.isArray(out.required)) {
      const filtered = (out.required as string[]).filter(
        (r) => !dropped.includes(r),
      );
      if (filtered.length === 0) delete out.required;
      else out.required = filtered;
    }
  }

  return out;
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: JsonSchemaLike;
}

interface AnyTool {
  name?: string;
  description?: string;
  schema?: unknown;
  function?: { name: string; description?: string; parameters?: unknown };
  functionDeclarations?: GeminiFunctionDeclaration[];
}

function toFunctionDeclarations(tool: unknown): GeminiFunctionDeclaration[] {
  const t = tool as AnyTool;

  if (Array.isArray(t?.functionDeclarations)) {
    return t.functionDeclarations.map((decl) => {
      const cleaned = decl.parameters
        ? sanitizeJsonSchemaForGemini(decl.parameters)
        : undefined;
      return {
        name: decl.name,
        description: decl.description ?? "A function available to call.",
        ...(cleaned ? { parameters: cleaned } : {}),
      };
    });
  }

  if (isOpenAITool(tool)) {
    const fn = (tool as { function: { name: string; description?: string; parameters?: unknown } }).function;
    const cleaned = fn.parameters
      ? sanitizeJsonSchemaForGemini(fn.parameters)
      : undefined;
    return [
      {
        name: fn.name,
        description: fn.description ?? "A function available to call.",
        ...(cleaned ? { parameters: cleaned } : {}),
      },
    ];
  }

  if (isLangChainTool(tool)) {
    const lct = tool as { name: string; description?: string; schema?: unknown };
    let jsonSchema: unknown;
    try {
      jsonSchema = lct.schema
        ? toJsonSchema(lct.schema as Parameters<typeof toJsonSchema>[0])
        : undefined;
    } catch (err) {
      logger.warn(
        `[vertex-sanitizer] toJsonSchema failed for tool "${lct.name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      jsonSchema = undefined;
    }
    const cleaned = jsonSchema
      ? sanitizeJsonSchemaForGemini(jsonSchema)
      : undefined;
    return [
      {
        name: lct.name,
        description: lct.description ?? "A function available to call.",
        ...(cleaned ? { parameters: cleaned } : {}),
      },
    ];
  }

  logger.warn(
    `[vertex-sanitizer] Unrecognized tool shape, passing through unchanged: ${JSON.stringify(
      tool,
    ).slice(0, 200)}`,
  );
  return [];
}

/**
 * Wraps a ChatVertexAI instance and overrides `bindTools` on that instance only.
 * Tools are passed as `{ functionDeclarations }` to bypass LangChain's stricter
 * JSON-Schema-to-Gemini conversion for empty object schemas.
 */
export function wrapVertexModelForSafeTools<T extends BaseChatModel>(
  model: T,
): T {
  const m = model as unknown as {
    bindTools?: (tools: unknown[], kwargs?: unknown) => unknown;
  };

  if (typeof m.bindTools !== "function") {
    return model;
  }

  const original = m.bindTools.bind(m);
  m.bindTools = (tools: unknown[], kwargs?: unknown) => {
    const declarations: GeminiFunctionDeclaration[] = [];
    for (const t of tools ?? []) {
      declarations.push(...toFunctionDeclarations(t));
    }

    if (declarations.length === 0) {
      return original(tools, kwargs);
    }

    // `convertToGeminiTools` accepts this shape directly and skips a second
    // JSON-Schema-to-Gemini conversion pass.
    const geminiToolObj = { functionDeclarations: declarations };
    return original([geminiToolObj] as unknown[], kwargs);
  };

  return model;
}
