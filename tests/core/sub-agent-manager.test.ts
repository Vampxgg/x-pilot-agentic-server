import { describe, expect, it } from "vitest";
import { SubAgentManager } from "../../src/core/sub-agent-manager.js";

describe("SubAgentManager", () => {
  it("returns the real error when a blocking sub-agent fails", async () => {
    const manager = new SubAgentManager();
    manager.setInvoker(async () => {
      throw new Error("403 This model is not available in your region.");
    });

    const result = await manager.spawn({
      parentId: "parent",
      agentName: "tutorial-scene-editor",
      instruction: "fix file",
      tenantId: "default",
      userId: "default",
      timeout: 1_000,
    });

    expect(result.success).toBe(false);
    expect(result.result).toEqual({
      error: "403 This model is not available in your region.",
    });
  });
});
