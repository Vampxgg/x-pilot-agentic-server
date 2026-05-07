import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { isOpenAITool } from "@langchain/core/language_models/base";
import { isLangChainTool } from "@langchain/core/utils/function_calling";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { logger } from "../utils/logger.js";

/**
 * Vertex / Gemini Schema 兼容层（基座层兜底）
 *
 * Vertex AI 的 `Schema` 类型对 function declaration 有几条比 OpenAI 严格的限制：
 *   - 不接受 `additionalProperties` / `$schema` / `$ref` / `$id` / `default`
 *   - OBJECT 类型必须显式列出非空 `properties`，否则返回
 *     `INVALID_ARGUMENT (400) "properties: should be non-empty for OBJECT type"`
 *   - 不支持 union（anyOf/oneOf）；nullable 须用单独的 `nullable: true`
 *
 * langchain 自带的 `removeAdditionalProperties` 只处理了第一类，OBJECT 空 properties
 * 这一类（来自 `z.object({})` 或 `z.record(z.unknown())`）会原样发到 Gemini 触发 400。
 *
 * 我们在 vertex provider 出口处统一拦截 `bindTools`，把 zod / OpenAI / 已成型的
 * Gemini tool 形态都先转成 JSON Schema、再清洗、再以 `{ functionDeclarations: [...] }`
 * 形态喂回 `ChatGoogleBase.bindTools`。该格式会被 `convertToGeminiTools` 直接
 * push 进最终 payload，**跳过** `jsonSchemaToGeminiParameters` 二次转换。
 *
 * 效果：
 *   - 不需要修改任何工具的 zod 定义
 *   - 不需要修改任何 handler
 *   - 不需要修改 agent.config.yaml
 *   - 其它 provider（OpenAI/Anthropic/OpenRouter/...）不受影响
 *   - 未来新增的工具自动受益
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
 * 递归清洗一个 JSON Schema 节点，使其符合 Gemini Schema 规范。
 *
 * 返回 `undefined` 表示「该节点是无 properties 的 OBJECT 应被丢弃」。
 * 调用方需要根据这个信号决定：
 *  - 如果是某个工具的 top-level parameters → 整个 `parameters` 字段省略
 *  - 如果是 OBJECT 内的某个属性 → 从父 `properties` / `required` 中删除该 key
 *  - 如果是数组 items → 退化成 `{ type: "string" }`（极少见）
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

  // ── type as array (e.g. ["string", "null"]) → single type + nullable ──
  if (Array.isArray(out.type)) {
    const types = (out.type as string[]).filter((t) => t !== "null");
    if ((out.type as string[]).includes("null")) out.nullable = true;
    out.type = types.length === 1 ? types[0] : types[0] ?? "string";
  }

  // ── anyOf / oneOf → resolve to single branch; mark nullable if needed ──
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

  // ── allOf → flatten single element; multi-element: merge-attempt ──
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

  // ── `not` is unsupported by Gemini ──
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
 * 包装一个 ChatVertexAI 实例：覆盖其 `bindTools`，预处理工具 schema 使其
 * 符合 Gemini 规范后以 `{ functionDeclarations }` 形态传入，绕过内部
 * `jsonSchemaToGeminiParameters` 对空 OBJECT 的无效处理。
 *
 * 不动态修改原型，只覆写实例上的 `bindTools` 方法，避免影响其它 ChatVertexAI 实例。
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

    // 以 { functionDeclarations: [...] } 形态传入，convertToGeminiTools 会直接
    // push 进结果数组，不再经过 jsonSchemaToGeminiParameters 二次转换
    const geminiToolObj = { functionDeclarations: declarations };
    return original([geminiToolObj] as unknown[], kwargs);
  };

  return model;
}
