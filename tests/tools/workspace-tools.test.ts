import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceManager } from "../../src/core/workspace.js";
import { createWorkspaceListTool, createWorkspaceReadTool } from "../../src/tools/built-in/workspace.js";

const TENANT = "test-tenant";
const USER = "test-user";
const SESSION = "workspace-tools-session";

describe("workspace tools", () => {
  afterEach(() => {
    const dir = resolve(process.cwd(), "data", "tenants", TENANT);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("blocks reading logs artifacts through workspace_read", async () => {
    await workspaceManager.writeArtifact(TENANT, USER, SESSION, "logs/execution.json", "{}");
    const tool = createWorkspaceReadTool(TENANT, USER, SESSION);

    const result = JSON.parse(await tool.invoke({ name: "logs/execution.json" }) as string) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Reading logs/ artifacts is not allowed");
  });

  it("filters trace files from workspace_list", async () => {
    await workspaceManager.writeArtifact(TENANT, USER, SESSION, "logs/trace_director_123.json", "{}");
    await workspaceManager.writeArtifact(TENANT, USER, SESSION, "logs/assemble-metrics.json", "{}");
    await workspaceManager.writeArtifact(TENANT, USER, SESSION, "assets/App.tsx", "export default [];");
    const tool = createWorkspaceListTool(TENANT, USER, SESSION);

    const result = JSON.parse(await tool.invoke({}) as string) as {
      success: boolean;
      artifacts: Array<{ name: string }>;
    };

    expect(result.success).toBe(true);
    expect(result.artifacts.map((artifact) => artifact.name)).not.toContain("logs/trace_director_123.json");
    expect(result.artifacts.map((artifact) => artifact.name)).toContain("logs/assemble-metrics.json");
    expect(result.artifacts.map((artifact) => artifact.name)).toContain("assets/App.tsx");
  });
});
