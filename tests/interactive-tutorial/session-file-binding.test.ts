import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { WorkspaceManager } from "../../src/core/workspace.js";
import { FileObjectService } from "../../src/services/file-object-service.js";
import {
  bindFilesToSession,
  listFiles,
  resolveByIds,
} from "../../apps/interactive-tutorial/code/uploads/uploads-service.js";

const TEST_DATA_DIR = resolve(process.cwd(), ".test-data", "session-bindings");
const FILE_DIR = resolve(TEST_DATA_DIR, "files");
const WORKSPACE_DIR = resolve(TEST_DATA_DIR, "workspaces");

describe("interactive-tutorial session file binding", () => {
  let fileService: FileObjectService;
  let workspaceManager: WorkspaceManager;

  beforeEach(() => {
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fileService = new FileObjectService(FILE_DIR, "http://test.local/api/files");
    workspaceManager = new WorkspaceManager(WORKSPACE_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("binds user-level file objects to a newly created session", async () => {
    const file = await fileService.importFromBuffer("tenant-a", "user-a", {
      buffer: Buffer.from("session reference"),
      originalName: "reference.md",
      mimeType: "text/markdown",
    });
    const sessionId = await workspaceManager.create("tenant-a", "user-a");

    const bound = await bindFilesToSession(
      "tenant-a",
      "user-a",
      sessionId,
      [file.fileId],
      { fileService, workspaceManager },
    );

    expect(bound.map((f) => f.fileId)).toEqual([file.fileId]);
    expect(bound[0]?.name).toBe("reference.md");

    const listed = await listFiles("tenant-a", "user-a", sessionId, { fileService, workspaceManager });
    expect(listed.map((f) => f.fileId)).toEqual([file.fileId]);

    const resolved = await resolveByIds("tenant-a", "user-a", sessionId, [file.fileId], {
      fileService,
      workspaceManager,
    });
    expect(resolved.map((f) => f.url)).toEqual([file.url]);
  });

  it("does not bind another user's file object", async () => {
    const file = await fileService.importFromBuffer("tenant-a", "other-user", {
      buffer: Buffer.from("not yours"),
      originalName: "secret.txt",
      mimeType: "text/plain",
    });
    const sessionId = await workspaceManager.create("tenant-a", "user-a");

    await expect(
      bindFilesToSession("tenant-a", "user-a", sessionId, [file.fileId], {
        fileService,
        workspaceManager,
      }),
    ).rejects.toThrow(/file not found or not accessible/);
  });
});
