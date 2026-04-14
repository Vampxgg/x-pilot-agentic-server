import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ToolCallRecord } from "../core/types.js";
import { logger } from "../utils/logger.js";

const DEFAULT_TIMEOUT = 60_000;

export async function executeTool(
  tool: StructuredToolInterface,
  input: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
): Promise<ToolCallRecord> {
  const start = Date.now();

  try {
    const result = await Promise.race([
      tool.invoke(input),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${tool.name}" timed out after ${timeout}ms`)), timeout),
      ),
    ]);

    return {
      toolName: tool.name,
      input,
      output: result,
      duration: Date.now() - start,
      success: true,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Tool "${tool.name}" failed: ${errorMsg}`);

    return {
      toolName: tool.name,
      input,
      output: null,
      duration: Date.now() - start,
      success: false,
      error: errorMsg,
    };
  }
}
