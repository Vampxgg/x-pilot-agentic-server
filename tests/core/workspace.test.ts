import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { WorkspaceManager } from "../../src/core/workspace.js";

const TEST_DIR = resolve(process.cwd(), ".test-data");
const TENANT = "test-tenant";

describe("WorkspaceManager", () => {
  let ws: WorkspaceManager;
  const USER = "test-user";

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    ws = new WorkspaceManager(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("should create a workspace and return sessionId", async () => {
    const sid = await ws.create(TENANT, USER, "test-session");
    expect(sid).toBe("test-session");
    expect(existsSync(ws.getPath(TENANT, USER, "test-session"))).toBe(true);
  });

  it("should auto-generate sessionId if not provided", async () => {
    const sid = await ws.create(TENANT, USER);
    expect(sid).toBeTruthy();
    expect(sid.length).toBeGreaterThan(10);
    expect(existsSync(ws.getPath(TENANT, USER, sid))).toBe(true);
  });

  it("should write and read artifacts", async () => {
    const sid = await ws.create(TENANT, "ws-1", "ws-1-session");
    await ws.writeArtifact(TENANT, "ws-1", sid, "research.md", "# Research\nThis is research content.");
    const content = await ws.readArtifact(TENANT, "ws-1", sid, "research.md");
    expect(content).toContain("Research");
    expect(content).toContain("research content");
  });

  it("should return null for non-existent artifact", async () => {
    const sid = await ws.create(TENANT, "ws-2", "ws-2-session");
    const content = await ws.readArtifact(TENANT, "ws-2", sid, "missing.txt");
    expect(content).toBeNull();
  });

  it("should list artifacts", async () => {
    const sid = await ws.create(TENANT, "ws-3", "ws-3-session");
    await ws.writeArtifact(TENANT, "ws-3", sid, "file-a.md", "a");
    await ws.writeArtifact(TENANT, "ws-3", sid, "file-b.tsx", "b");

    const artifacts = await ws.listArtifacts(TENANT, "ws-3", sid);
    expect(artifacts.length).toBe(2);
    expect(artifacts.map((a) => a.name).sort()).toEqual(["file-a.md", "file-b.tsx"]);
  });

  it("should cleanup workspace", async () => {
    const sid = await ws.create(TENANT, "ws-cleanup", "ws-cleanup-session");
    await ws.writeArtifact(TENANT, "ws-cleanup", sid, "temp.txt", "temp");
    expect(existsSync(ws.getPath(TENANT, "ws-cleanup", sid))).toBe(true);

    await ws.cleanup(TENANT, "ws-cleanup", sid);
    expect(existsSync(ws.getPath(TENANT, "ws-cleanup", sid))).toBe(false);
  });

  it("should support nested artifact paths", async () => {
    const sid = await ws.create(TENANT, "ws-nested", "ws-nested-session");
    await ws.writeArtifact(TENANT, "ws-nested", sid, "scenes/scene-1.tsx", "export default () => <div>Scene 1</div>");
    const content = await ws.readArtifact(TENANT, "ws-nested", sid, "scenes/scene-1.tsx");
    expect(content).toContain("Scene 1");
  });

  it("should isolate different tenants", async () => {
    const sessionId = "shared-session";
    const userId = "shared-user";
    await ws.create("tenant-a", userId, sessionId);
    await ws.create("tenant-b", userId, sessionId);

    await ws.writeArtifact("tenant-a", userId, sessionId, "secret.md", "Tenant A secret");
    await ws.writeArtifact("tenant-b", userId, sessionId, "secret.md", "Tenant B secret");

    const contentA = await ws.readArtifact("tenant-a", userId, sessionId, "secret.md");
    const contentB = await ws.readArtifact("tenant-b", userId, sessionId, "secret.md");

    expect(contentA).toBe("Tenant A secret");
    expect(contentB).toBe("Tenant B secret");
    expect(contentA).not.toBe(contentB);
  });
});
