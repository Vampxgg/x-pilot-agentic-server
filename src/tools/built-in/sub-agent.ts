import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * This tool is a placeholder that gets dynamically replaced at runtime
 * with the actual sub-agent spawning logic from sub-agent-manager.
 * The schema stays the same but the implementation is injected.
 */
export const subAgentTool = tool(
  async ({ agentName, instruction, model, parallel }) => {
    return JSON.stringify({
      error: "Sub-agent tool not initialized. This should be replaced at runtime by sub-agent-manager.",
    });
  },
  {
    name: "spawn_sub_agent",
    description:
      "Spawn a sub-agent to handle a specific task autonomously. " +
      "Use this to delegate work to specialized agents or run tasks in parallel. " +
      "The sub-agent runs independently and returns results when complete.",
    schema: z.object({
      agentName: z.string().describe("Name of the agent to spawn (must be registered)"),
      instruction: z.string().describe("The task instruction for the sub-agent"),
      model: z.string().optional().describe("Override LLM model for the sub-agent (cost optimization)"),
      parallel: z.boolean().optional().describe("If true, don't wait for completion"),
    }),
  },
);
