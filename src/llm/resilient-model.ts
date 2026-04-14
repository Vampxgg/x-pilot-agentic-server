import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { logger } from "../utils/logger.js";

/**
 * Wraps a primary model with fallback models using LangChain's built-in
 * `.withFallbacks()`. When the primary model fails (429, 503, network error,
 * etc.) after exhausting its own HTTP-level retries (`maxRetries`), the
 * fallback models are tried in order.
 *
 * Two-layer resilience:
 *  Layer 1 – HTTP retry (handled by `maxRetries` on each ChatOpenAI/ChatAnthropic)
 *  Layer 2 – Model fallback (handled here via `.withFallbacks()`)
 */
export function withRetryAndFallback(
  primary: BaseChatModel,
  fallbacks: BaseChatModel[],
): BaseChatModel {
  if (fallbacks.length === 0) return primary;

  logger.info(
    `Building fallback chain: primary + ${fallbacks.length} fallback(s)`,
  );

  return primary.withFallbacks({
    fallbacks,
  }) as unknown as BaseChatModel;
}

export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate_limit") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("quota") ||
    msg.includes("resource_exhausted")
  );
}

export function isTransientError(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("500") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("service unavailable") ||
    msg.includes("internal server error")
  );
}
