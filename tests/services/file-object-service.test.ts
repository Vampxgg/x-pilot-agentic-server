import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FileObjectService } from "../../src/services/file-object-service.js";

const TEST_DIR = resolve(process.cwd(), ".test-data", "file-objects");

describe("FileObjectService", () => {
  let service: FileObjectService;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    service = new FileObjectService(TEST_DIR, "http://test.local/api/files");
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("imports an uploaded buffer as a user-owned file object without a session", async () => {
    const file = await service.importFromBuffer("tenant-a", "user-a", {
      buffer: Buffer.from("hello file"),
      originalName: "notes.txt",
      mimeType: "text/plain",
    });

    expect(file.fileId).toMatch(/^file_/);
    expect(file.tenantId).toBe("tenant-a");
    expect(file.userId).toBe("user-a");
    expect(file.name).toBe("notes.txt");
    expect(file.kind).toBe("doc");
    expect(file.size).toBe(10);
    expect(file.url).toContain("/api/files/uploads/objects/");
    expect(file).not.toHaveProperty("sessionId");

    const stored = await readFile(service.absolutePath(file), "utf-8");
    expect(stored).toBe("hello file");
  });

  it("rejects unsafe URL imports before fetching", async () => {
    await expect(
      service.importFromUrl("tenant-a", "user-a", "file:///etc/passwd"),
    ).rejects.toThrow(/Only http and https URLs are supported/);

    await expect(
      service.importFromUrl("tenant-a", "user-a", "http://127.0.0.1/private.txt"),
    ).rejects.toThrow(/private or loopback addresses are not allowed/);
  });
});
