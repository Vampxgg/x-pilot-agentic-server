import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { eventBus } from "../../core/event-bus.js";

export function createEventEmitTool(sessionId: string, agentName: string): StructuredToolInterface {
  return tool(
    async ({ eventType, message, data }) => {
      try {
        eventBus.emit({
          type: eventType === "progress" ? "progress" : "custom",
          sourceAgent: agentName,
          sessionId,
          data: { message, ...data },
          timestamp: new Date().toISOString(),
        });
        return JSON.stringify({ success: true, eventType, sessionId });
      } catch (err) {
        return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      name: "emit_event",
      description:
        "Emit an event to the session event bus. Other agents and the frontend can listen for these events. " +
        "Use to notify progress, signal completion, or send custom messages to sibling agents.",
      schema: z.object({
        eventType: z.enum(["progress", "custom"]).describe("Event type"),
        message: z.string().describe("Human-readable event message"),
        data: z.record(z.unknown()).optional().describe("Additional structured data"),
      }),
    },
  );
}
