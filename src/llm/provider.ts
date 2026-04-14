import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";

export type SupportedProvider = "openai" | "anthropic" | "openrouter" | "zhipu" | "qwen" | "deepseek";

interface CreateModelOptions {
  provider?: SupportedProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

function resolveProvider(model: string): SupportedProvider {
  if (model.includes("/")) return "openrouter";
  if (model.startsWith("claude")) return "anthropic";
  if (model.startsWith("glm") || model.startsWith("chatglm")) return "zhipu";
  if (model.startsWith("qwen")) return "qwen";
  if (model.startsWith("deepseek")) return "deepseek";
  return "openai";
}

export function createModel(options: CreateModelOptions): BaseChatModel {
  const config = getConfig();
  const provider = options.provider ?? resolveProvider(options.model);
  const providerConfig = config.llm.providers[provider];
  const maxRetries = config.llm.retry?.maxRetries ?? 3;

  if (!providerConfig?.apiKey) {
    logger.warn(`No API key configured for provider: ${provider}`);
  }

  switch (provider) {
    case "anthropic":
      return new ChatAnthropic({
        anthropicApiKey: providerConfig?.apiKey,
        modelName: options.model,
        temperature: options.temperature ?? 0.7,
        maxTokens: options.maxTokens ?? 4096,
        maxRetries,
      });

    case "openrouter":
      return new ChatOpenAI({
        openAIApiKey: providerConfig?.apiKey,
        modelName: options.model,
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
        modelName: options.model,
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
        modelName: options.model,
        temperature: options.temperature ?? 0.7,
        maxTokens: options.maxTokens ?? 4096,
        maxRetries,
      });
  }
}
