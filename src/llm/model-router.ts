import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createModel, type SupportedProvider } from "./provider.js";
import { withRetryAndFallback } from "./resilient-model.js";
import type { AgentConfig, FallbackModelEntry } from "../core/types.js";
import { logger } from "../utils/logger.js";

export type TaskComplexity = "low" | "medium" | "high";

const modelCache = new Map<string, BaseChatModel>();

interface NormalizedFallback {
  model: string;
  provider?: SupportedProvider;
  maxTokens?: number;
}

function normalizeFallback(raw: string | FallbackModelEntry): NormalizedFallback {
  if (typeof raw === "string") return { model: raw };
  return {
    model: raw.model,
    provider: raw.provider as SupportedProvider | undefined,
    maxTokens: raw.maxTokens,
  };
}

function fallbackToken(fb: NormalizedFallback, parentMaxTokens?: number): string {
  const mt = fb.maxTokens ?? parentMaxTokens;
  return `${fb.provider ?? "auto"}:${fb.model}${mt ? `:mt${mt}` : ""}`;
}

function cacheKey(
  provider: SupportedProvider | undefined,
  model: string,
  fallbacks?: NormalizedFallback[],
  maxTokens?: number,
): string {
  const base = `${provider ?? "auto"}:${model}${maxTokens ? `:mt${maxTokens}` : ""}`;
  if (fallbacks?.length) {
    const tokens = fallbacks.map((fb) => fallbackToken(fb, maxTokens)).join(",");
    return `${base}|fb:${tokens}`;
  }
  return base;
}

function buildWithFallbacks(
  primary: BaseChatModel,
  rawFallbacks?: Array<string | FallbackModelEntry>,
  parentMaxTokens?: number,
): BaseChatModel {
  if (!rawFallbacks?.length) return primary;

  const fallbacks = rawFallbacks.map((raw) => {
    const fb = normalizeFallback(raw);
    const mt = fb.maxTokens ?? parentMaxTokens;
    const key = cacheKey(fb.provider, fb.model, undefined, mt);
    const cached = modelCache.get(key);
    if (cached) return cached;
    const m = createModel({ model: fb.model, provider: fb.provider, maxTokens: mt });
    modelCache.set(key, m);
    return m;
  });

  return withRetryAndFallback(primary, fallbacks);
}

function formatFallbackChain(fallbacks: Array<string | FallbackModelEntry>): string {
  return fallbacks
    .map((raw) => {
      const fb = normalizeFallback(raw);
      return `${fb.provider ?? "auto"}:${fb.model}`;
    })
    .join(", ");
}

export function getModelForAgent(agentConfig: AgentConfig): BaseChatModel {
  const provider = agentConfig.provider as SupportedProvider | undefined;
  const normalizedFallbacks = agentConfig.fallbackModels?.map(normalizeFallback);
  const key = cacheKey(provider, agentConfig.model, normalizedFallbacks, agentConfig.maxTokens);
  let model = modelCache.get(key);
  if (!model) {
    const primaryKey = cacheKey(provider, agentConfig.model, undefined, agentConfig.maxTokens);
    let primary = modelCache.get(primaryKey);
    if (!primary) {
      primary = createModel({
        model: agentConfig.model,
        provider,
        maxTokens: agentConfig.maxTokens,
      });
      modelCache.set(primaryKey, primary);
    }
    model = buildWithFallbacks(primary, agentConfig.fallbackModels, agentConfig.maxTokens);
    if (agentConfig.fallbackModels?.length) {
      modelCache.set(key, model);
      logger.info(`Model "${provider ?? "auto"}:${agentConfig.model}" configured with fallback chain: [${formatFallbackChain(agentConfig.fallbackModels)}]`);
    }
  }
  return model;
}

export function getWorkerModel(agentConfig: AgentConfig): BaseChatModel {
  const modelName = agentConfig.workerModel ?? agentConfig.model;
  const provider =
    agentConfig.workerModel === undefined
      ? (agentConfig.provider as SupportedProvider | undefined)
      : undefined;
  const key = cacheKey(provider, modelName, undefined, agentConfig.maxTokens);
  let model = modelCache.get(key);
  if (!model) {
    model = createModel({ model: modelName, provider, maxTokens: agentConfig.maxTokens });
    modelCache.set(key, model);
  }
  return model;
}

export function getModelByComplexity(agentConfig: AgentConfig, complexity: TaskComplexity): BaseChatModel {
  switch (complexity) {
    case "low":
      return getWorkerModel(agentConfig);
    case "medium":
    case "high":
    default:
      return getModelForAgent(agentConfig);
  }
}

export function getModelByName(modelName: string, provider?: SupportedProvider): BaseChatModel {
  const key = cacheKey(provider, modelName);
  let model = modelCache.get(key);
  if (!model) {
    model = createModel({ model: modelName, provider });
    modelCache.set(key, model);
    logger.info(`Created model instance: ${key}`);
  }
  return model;
}
