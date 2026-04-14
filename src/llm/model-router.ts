import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createModel, type SupportedProvider } from "./provider.js";
import { withRetryAndFallback } from "./resilient-model.js";
import type { AgentConfig } from "../core/types.js";
import { logger } from "../utils/logger.js";

export type TaskComplexity = "low" | "medium" | "high";

const modelCache = new Map<string, BaseChatModel>();

function cacheKey(provider: SupportedProvider | undefined, model: string, fallbacks?: string[], maxTokens?: number): string {
  const base = `${provider ?? "auto"}:${model}${maxTokens ? `:mt${maxTokens}` : ""}`;
  if (fallbacks?.length) return `${base}|fb:${fallbacks.join(",")}`;
  return base;
}

function buildWithFallbacks(primary: BaseChatModel, fallbackModels?: string[], maxTokens?: number): BaseChatModel {
  if (!fallbackModels?.length) return primary;

  const fallbacks = fallbackModels.map((name) => {
    const existing = modelCache.get(cacheKey(undefined, name, undefined, maxTokens));
    if (existing) return existing;
    const m = createModel({ model: name, maxTokens });
    modelCache.set(cacheKey(undefined, name, undefined, maxTokens), m);
    return m;
  });

  return withRetryAndFallback(primary, fallbacks);
}

export function getModelForAgent(agentConfig: AgentConfig): BaseChatModel {
  const key = cacheKey(undefined, agentConfig.model, agentConfig.fallbackModels, agentConfig.maxTokens);
  let model = modelCache.get(key);
  if (!model) {
    const primary = createModel({ model: agentConfig.model, maxTokens: agentConfig.maxTokens });
    modelCache.set(cacheKey(undefined, agentConfig.model, undefined, agentConfig.maxTokens), primary);
    model = buildWithFallbacks(primary, agentConfig.fallbackModels, agentConfig.maxTokens);
    if (agentConfig.fallbackModels?.length) {
      modelCache.set(key, model);
      logger.info(`Model "${agentConfig.model}" configured with fallback chain: [${agentConfig.fallbackModels.join(", ")}]`);
    }
  }
  return model;
}

export function getWorkerModel(agentConfig: AgentConfig): BaseChatModel {
  const modelName = agentConfig.workerModel ?? agentConfig.model;
  const key = cacheKey(undefined, modelName, undefined, agentConfig.maxTokens);
  let model = modelCache.get(key);
  if (!model) {
    model = createModel({ model: modelName, maxTokens: agentConfig.maxTokens });
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
