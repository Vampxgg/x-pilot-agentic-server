import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";

/**
 * Tool that lets the LLM autonomously create a new agent type at runtime
 * by copying _template/ and customizing its .md prompt files.
 */
export const createAgentTool: StructuredToolInterface = tool(
  async ({ name, group, identity, mission, soul, model, allowedTools }) => {
    try {
      const { agentRegistry } = await import("../../core/agent-registry.js");

      if (agentRegistry.has(name)) {
        return JSON.stringify({ success: false, error: `Agent "${name}" already exists` });
      }

      const config: Record<string, unknown> = {};
      if (model) config.model = model;
      if (allowedTools) config.allowedTools = allowedTools;

      const agent = await agentRegistry.create({
        name,
        group,
        identity,
        mission,
        soul,
        config: config as any,
      });

      return JSON.stringify({
        success: true,
        agentName: agent.name,
        group: group ?? null,
        model: agent.config.model,
        skills: agent.skills.map((s) => s.name),
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  {
    name: "create_agent",
    description:
      "Create a new specialized agent at runtime. The agent is created from the _template folder " +
      "with customized identity, mission, and soul. Once created, it can be spawned via spawn_sub_agent " +
      "or spawn_parallel_agents. Use this when no existing agent fits the required task. " +
      "Use the 'group' parameter to place the agent under an existing application (e.g. 'video-course').",
    schema: z.object({
      name: z.string().describe("Unique name for the new agent (lowercase-hyphenated, must be globally unique)"),
      group: z.string().optional().describe("Application group to place this agent under (e.g. 'video-course'). If omitted, created at apps/ root."),
      identity: z.string().describe("Agent identity: who it is, its role and capabilities"),
      mission: z.string().describe("Agent mission: primary objective and success criteria"),
      soul: z.string().optional().describe("Agent soul: behavioral values and constraints (CORE/MUTABLE format)"),
      model: z.string().optional().describe("LLM model to use (default: inherited from global config)"),
      allowedTools: z.array(z.string()).optional().describe("List of tool names this agent can use (default: all)"),
    }),
  },
);
