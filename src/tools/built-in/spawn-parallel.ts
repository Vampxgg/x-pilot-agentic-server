import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { subAgentManager } from "../../core/sub-agent-manager.js";
import type { SubAgentEventCallback } from "../../core/agent-graph.js";
import type { StreamContext } from "../../core/stream-protocol.js";

export function createSpawnParallelTool(
  parentId: string,
  tenantId: string,
  userId?: string,
  sessionId?: string,
  parentCtx?: StreamContext,
  eventCallback?: SubAgentEventCallback,
  abortSignal?: AbortSignal,
): StructuredToolInterface {
  return tool(
    async ({ tasks }) => {
      try {
        const results = await subAgentManager.spawnParallel(
          tasks.map((t: { agentName: string; instruction: string; model?: string; context?: Record<string, unknown> }) => ({
            parentId, agentName: t.agentName, instruction: t.instruction,
            model: t.model, context: t.context, sessionId, tenantId, userId, abortSignal,
            onComplete: "aggregate" as const,
          })),
          parentCtx,
          eventCallback,
        );

        return JSON.stringify({
          success: true, totalTasks: results.length,
          succeeded: results.filter((r) => r.success).length,
          failed: results.filter((r) => !r.success).length,
          results: results.map((r) => ({
            agentName: r.agentName, taskId: r.taskId, success: r.success, duration: r.duration, result: r.result,
          })),
        });
      } catch (err) {
        return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      name: "spawn_parallel_agents",
      description: "Spawn multiple sub-agents in parallel. All share the same workspace and tenant isolation.",
      schema: z.object({
        tasks: z.array(z.object({
          agentName: z.string().describe("Agent name"),
          instruction: z.string().describe("Task instruction"),
          model: z.string().optional().describe("Override model"),
          context: z.record(z.unknown()).optional().describe("Context data"),
        })).min(1).describe("Tasks to execute in parallel"),
      }),
    },
  );
}
