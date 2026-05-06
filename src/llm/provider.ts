import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatVertexAI } from "@langchain/google-vertexai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { wrapVertexModelForSafeTools } from "./vertex-schema-sanitizer.js";

export type SupportedProvider =
  | "openai"
  | "anthropic"
  | "openrouter"
  | "zhipu"
  | "qwen"
  | "deepseek"
  | "vertex";

interface CreateModelOptions {
  provider?: SupportedProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * 仅在未显式指定 provider 时调用。
 * 注意：vertex 不参与自动识别，必须由 agent.config.yaml 显式 `provider: vertex` 触发，
 * 避免与 OpenRouter 上的 `google/...` 命名空间冲突。
 */
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

  if (provider === "vertex") {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_API_KEY) {
      logger.warn(
        "Vertex AI provider selected but neither GOOGLE_APPLICATION_CREDENTIALS nor GOOGLE_API_KEY is set",
      );
    }
  } else if (!providerConfig?.apiKey) {
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

    case "vertex": {
      const vertexCfg = providerConfig as
        | { project?: string; location?: string }
        | undefined;
      const vertexModel = new ChatVertexAI({
        model: options.model,
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens ?? 4096,
        maxRetries,
        location: vertexCfg?.location ?? "us-central1",
        // 安全兜底：基座层已在 createThinkNode 等处保证只发送一条 SystemMessage，
        // 但若未来扩展不慎插入第二条 SystemMessage，开启此开关可让 google-common
        // 适配层自动把多余的 system 转成 human，避免抛
        // "System messages are only permitted as the first passed message."
        // 见 node_modules/@langchain/.../google-common/dist/utils/gemini.cjs:923
        convertSystemMessageToHumanContent: true,
      });
      // Vertex/Gemini 对 function declaration schema 的限制比 OpenAI 严格：
      // OBJECT 必须有非空 properties，不接受 additionalProperties / $schema 等。
      // 在 bindTools 出口处统一兜底清洗，所有 vertex agent 自动受益，
      // 工具 zod 定义、handler、其它 provider 全部零改动。
      return wrapVertexModelForSafeTools(
        vertexModel as unknown as BaseChatModel,
      );
    }

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
