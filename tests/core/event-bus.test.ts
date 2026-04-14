import { describe, it, expect, vi } from "vitest";
import { eventBus, type AgentEvent } from "../../src/core/event-bus.js";

describe("AgentEventBus", () => {
  it("should emit and receive events by session", async () => {
    const received: AgentEvent[] = [];
    const handler = (e: AgentEvent) => received.push(e);

    eventBus.onSession("sess-1", handler);

    eventBus.emitTaskComplete("agent-a", "sess-1", { output: "done" });
    eventBus.emitTaskComplete("agent-b", "sess-2", { output: "other" });

    expect(received.length).toBe(1);
    expect(received[0]!.sourceAgent).toBe("agent-a");
    expect(received[0]!.type).toBe("task_complete");

    eventBus.offSession("sess-1", handler);
  });

  it("should emit and receive events by type", async () => {
    const received: AgentEvent[] = [];
    const handler = (e: AgentEvent) => received.push(e);

    eventBus.on("artifact_created", handler);

    eventBus.emitArtifactCreated("coder", "sess-x", "scene-1.tsx");

    expect(received.length).toBe(1);
    expect((received[0]!.data as Record<string, unknown>).artifact).toBe("scene-1.tsx");

    eventBus.off("artifact_created", handler);
  });

  it("should receive all events via onAll", () => {
    const received: AgentEvent[] = [];
    const handler = (e: AgentEvent) => received.push(e);

    eventBus.onAll(handler);

    eventBus.emitAgentStarted("director", "sess-all");
    eventBus.emitProgress("director", "sess-all", "Step 1 done", 0.5);

    expect(received.length).toBe(2);
    expect(received[0]!.type).toBe("agent_started");
    expect(received[1]!.type).toBe("progress");
    expect((received[1]!.data as Record<string, unknown>).progress).toBe(0.5);

    eventBus.offAll(handler);
  });

  it("should emit task_failed events", () => {
    const received: AgentEvent[] = [];
    const handler = (e: AgentEvent) => received.push(e);

    eventBus.on("task_failed", handler);
    eventBus.emitTaskFailed("broken-agent", "sess-fail", "timeout");

    expect(received.length).toBe(1);
    expect((received[0]!.data as Record<string, unknown>).error).toBe("timeout");

    eventBus.off("task_failed", handler);
  });
});
