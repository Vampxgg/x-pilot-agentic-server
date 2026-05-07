import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AIMessage } from "@langchain/core/messages";
import { createActNode, routeAfterObserve, type AgentGraphState } from "../../src/core/agent-graph.js";
import { createWorkingMemory } from "../../src/memory/short-term.js";
import type { ToolCallRecord } from "../../src/core/types.js";

function makeSlowTool(name: string, delayMs: number) {
  return tool(
    async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return `${name}-done`;
    },
    { name, description: `Slow tool ${name}`, schema: z.object({}) },
  );
}

function makeFailTool(name: string, failCount: number) {
  let calls = 0;
  return tool(
    async () => {
      calls++;
      if (calls <= failCount) throw new Error(`Fail #${calls}`);
      return `${name}-ok-after-${calls}`;
    },
    { name, description: `Flaky tool ${name}`, schema: z.object({}) },
  );
}

describe("Parallel Act Node", () => {
  it("should execute multiple tool calls in parallel, not sequentially", async () => {
    const toolA = makeSlowTool("tool_a", 200);
    const toolB = makeSlowTool("tool_b", 200);
    const toolC = makeSlowTool("tool_c", 200);

    const actNode = createActNode([toolA, toolB, toolC]);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [
        { id: "tc1", name: "tool_a", args: {} },
        { id: "tc2", name: "tool_b", args: {} },
        { id: "tc3", name: "tool_c", args: {} },
      ],
    });

    const state: AgentGraphState = {
      messages: [aiMsg],
      agentName: "test",
      tenantId: "test-tenant",
      sessionId: "",
      taskContext: "",
      workingMemory: createWorkingMemory(),
      longTermMemory: "",
      systemPrompt: "",
      toolCalls: [],
      subAgentResults: [],
      reflections: [],
      iteration: 0,
      maxIterations: 20,
      emptyResponseRetries: 0,
      done: false,
    };

    const start = Date.now();
    const result = await actNode(state);
    const elapsed = Date.now() - start;

    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls!.every((tc) => tc.success)).toBe(true);
    expect(result.messages).toHaveLength(3);

    // If parallel: ~200ms. If sequential: ~600ms.
    expect(elapsed).toBeLessThan(500);
  });

  it("should retry a failed tool once before reporting failure", async () => {
    const flakyTool = makeFailTool("flaky", 1);
    const actNode = createActNode([flakyTool]);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "flaky", args: {} }],
    });

    const state: AgentGraphState = {
      messages: [aiMsg],
      agentName: "test",
      tenantId: "test-tenant",
      sessionId: "",
      taskContext: "",
      workingMemory: createWorkingMemory(),
      longTermMemory: "",
      systemPrompt: "",
      toolCalls: [],
      subAgentResults: [],
      reflections: [],
      iteration: 0,
      maxIterations: 20,
      emptyResponseRetries: 0,
      done: false,
    };

    const result = await actNode(state);

    expect(result.toolCalls).toHaveLength(1);
    // After 1 fail + 1 retry = success
    expect(result.toolCalls![0]!.success).toBe(true);
  });

  it("should report failure after retry is exhausted", async () => {
    const alwaysFailTool = makeFailTool("always_fail", 999);
    const actNode = createActNode([alwaysFailTool]);

    const aiMsg = new AIMessage({
      content: "",
      tool_calls: [{ id: "tc1", name: "always_fail", args: {} }],
    });

    const state: AgentGraphState = {
      messages: [aiMsg],
      agentName: "test",
      tenantId: "test-tenant",
      sessionId: "",
      taskContext: "",
      workingMemory: createWorkingMemory(),
      longTermMemory: "",
      systemPrompt: "",
      toolCalls: [],
      subAgentResults: [],
      reflections: [],
      iteration: 0,
      maxIterations: 20,
      emptyResponseRetries: 0,
      done: false,
    };

    const result = await actNode(state);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.success).toBe(false);
    expect(result.toolCalls![0]!.error).toBeTruthy();
  });
});

describe("routeAfterObserve error routing", () => {
  it("should route to think when recent calls succeed", () => {
    const state = {
      iteration: 1,
      maxIterations: 20,
      agentName: "test",
      toolCalls: [
        { toolName: "a", success: true },
        { toolName: "b", success: true },
        { toolName: "c", success: true },
      ] as ToolCallRecord[],
    } as unknown as AgentGraphState;

    expect(routeAfterObserve(state)).toBe("think");
  });

  it("should route to reflect after 3 consecutive failures", () => {
    const state = {
      iteration: 3,
      maxIterations: 20,
      agentName: "test",
      toolCalls: [
        { toolName: "a", success: true },
        { toolName: "b", success: false },
        { toolName: "c", success: false },
        { toolName: "d", success: false },
      ] as ToolCallRecord[],
    } as unknown as AgentGraphState;

    expect(routeAfterObserve(state)).toBe("reflect");
  });

  it("should route to reflect when max iterations reached", () => {
    const state = {
      iteration: 20,
      maxIterations: 20,
      agentName: "test",
      toolCalls: [],
    } as unknown as AgentGraphState;

    expect(routeAfterObserve(state)).toBe("reflect");
  });
});
