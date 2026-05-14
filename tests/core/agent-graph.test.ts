import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createThinkNode, type AgentGraphState } from "../../src/core/agent-graph.js";
import { createWorkingMemory } from "../../src/memory/short-term.js";

describe("createThinkNode", () => {
  it("rehydrates checkpointed message objects before invoking the model", async () => {
    let invokedMessages: BaseMessage[] = [];
    const model = {
      invoke: async (messages: BaseMessage[]) => {
        invokedMessages = messages;
        return new AIMessage("ok");
      },
    } as unknown as BaseChatModel;

    const think = createThinkNode(model, []);
    const workingMemory = createWorkingMemory();
    workingMemory.facts.push("remember uploaded blueprint");

    const plainHumanMessage = {
      lc_id: ["langchain_core", "messages", "HumanMessage"],
      content: "Build the scene",
      additional_kwargs: {},
      response_metadata: {},
    };

    await think({
      messages: [plainHumanMessage as unknown as BaseMessage],
      agentName: "agent",
      tenantId: "tenant",
      sessionId: "session",
      taskContext: "",
      workingMemory,
      longTermMemory: "",
      systemPrompt: "You are helpful",
      toolCalls: [],
      subAgentResults: [],
      reflections: [],
      iteration: 0,
      maxIterations: 10,
      done: false,
      emptyResponseRetries: 0,
      disableNudge: false,
    } as AgentGraphState);

    expect(invokedMessages).toHaveLength(2);
    expect(invokedMessages[0]?._getType()).toBe("system");
    expect(String(invokedMessages[0]?.content)).toContain("## Working Memory");
    expect(invokedMessages[1]).toBeInstanceOf(HumanMessage);
    expect(invokedMessages[1]?.content).toBe("Build the scene");
  });
});
