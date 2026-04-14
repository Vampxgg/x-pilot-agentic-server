import { describe, it, expect, beforeEach } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { toolRegistry } from "../../src/tools/tool-registry.js";

describe("ToolRegistry", () => {
  it("should register and retrieve tools", () => {
    const testTool = tool(async () => "ok", {
      name: "test_tool_reg",
      description: "A test tool",
      schema: z.object({}),
    });

    toolRegistry.register({
      name: "test_tool_reg",
      description: "A test tool",
      tool: testTool,
    });

    expect(toolRegistry.has("test_tool_reg")).toBe(true);
    expect(toolRegistry.get("test_tool_reg")?.name).toBe("test_tool_reg");
  });

  it("should return tools by name list", () => {
    const tools = toolRegistry.getByNames(["test_tool_reg"]);
    expect(tools.length).toBe(1);
  });

  it("should return all tools with wildcard", () => {
    const tools = toolRegistry.getByNames(["*"]);
    expect(tools.length).toBeGreaterThanOrEqual(1);
  });

  it("should list tool names", () => {
    const names = toolRegistry.listNames();
    expect(names).toContain("test_tool_reg");
  });
});
