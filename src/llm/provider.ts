import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatVertexAI } from "@langchain/google-vertexai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";

export type SupportedProvider = "openai" | "anthropic" | "openrouter" | "zhipu" | "qwen" | "deepseek" | "vertex";

interface CreateModelOptions {
  provider?: SupportedProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

function resolveProvider(model: string): SupportedProvider {
  if (model.startsWith("vertex/")) return "vertex";
  if (model.includes("/")) return "openrouter";
  if (model.startsWith("gemini")) return "vertex";
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("glm") || model.startsWith("chatglm")) return "zhipu";
  if (model.startsWith("qwen")) return "qwen";
  if (model.startsWith("deepseek")) return "deepseek";
  return "openai";
}

function normalizeModelName(provider: SupportedProvider, model: string): string {
  if (provider === "vertex" && model.startsWith("vertex/")) {
    return model.slice("vertex/".length);
  }
  return model;
}

export function createModel(options: CreateModelOptions): BaseChatModel {
  const config = getConfig();
  const provider = options.provider ?? resolveProvider(options.model);
  const modelName = normalizeModelName(provider, options.model);
  const providerConfig = config.llm.providers[provider];
  const maxRetries = config.llm.retry?.maxRetries ?? 3;

  if (!providerConfig?.apiKey) {
    logger.warn(`No API key configured for provider: ${provider}`);
  }

  switch (provider) {
    case "anthropic":
      return new ChatAnthropic({
        anthropicApiKey: providerConfig?.apiKey,
        modelName,
        temperature: options.temperature ?? 0.7,
        maxTokens: options.maxTokens ?? 4096,
        maxRetries,
      });

    case "vertex":
      return new ChatVertexAI({
        model: modelName,
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 4096,
        maxRetries,
        ...(providerConfig?.apiKey ? { apiKey: providerConfig.apiKey } : {}),
        ...(providerConfig?.project ? { project: providerConfig.project } : {}),
        ...(providerConfig?.location ? { location: providerConfig.location } : {}),
      });

    case "openrouter":
      return new ChatOpenAI({
        openAIApiKey: providerConfig?.apiKey,
        modelName,
        temperature: options.temperature ?? 0.7,
        maxTokens: options.maxTokens ?? 4096,
        maxRetries,
        configuration: {
          baseURL: providerConfig?.baseUrl ?? "https://openrouter.ai/api/v1",
        },
      });

    case "zhipu":
    case "qwen":
    case "deepseek":
      return new ChatOpenAI({
        openAIApiKey: providerConfig?.apiKey,
        modelName,
        temperature: options.temperature ?? 0.7,
        maxTokens: options.maxTokens ?? 4096,
        maxRetries,
        configuration: {
          baseURL: providerConfig?.baseUrl,
        },
      });

    case "openai":
    default:
      return new ChatOpenAI({
        openAIApiKey: providerConfig?.apiKey,
        modelName,
        temperature: options.temperature ?? 0.7,
        maxTokens: options.maxTokens ?? 4096,
        maxRetries,
      });
  }
}
