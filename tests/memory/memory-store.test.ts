import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { FileMemoryStore } from "../../src/memory/stores/file-store.js";

const TEST_DIR = resolve(process.cwd(), ".test-data");
const TENANT = "test-tenant";

describe("FileMemoryStore", () => {
  let store: FileMemoryStore;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    store = new FileMemoryStore(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("should write and read memory", async () => {
    await store.write(TENANT, "test-agent", "test.md", "hello world");
    const content = await store.read(TENANT, "test-agent", "test.md");
    expect(content).toBe("hello world");
  });

  it("should return null for non-existent key", async () => {
    const content = await store.read(TENANT, "test-agent", "missing.md");
    expect(content).toBeNull();
  });

  it("should append content", async () => {
    await store.write(TENANT, "test-agent", "log.md", "line 1");
    await store.append(TENANT, "test-agent", "log.md", "line 2");
    const content = await store.read(TENANT, "test-agent", "log.md");
    expect(content).toContain("line 1");
    expect(content).toContain("line 2");
  });

  it("should list .md files", async () => {
    await store.write(TENANT, "test-agent", "a.md", "a");
    await store.write(TENANT, "test-agent", "b.md", "b");
    const files = await store.list(TENANT, "test-agent");
    expect(files).toContain("a.md");
    expect(files).toContain("b.md");
  });

  it("should search by keyword", async () => {
    await store.write(TENANT, "test-agent", "doc1.md", "LangGraph is a framework for agents");
    await store.write(TENANT, "test-agent", "doc2.md", "FastAPI is a web framework");
    await store.write(TENANT, "test-agent", "doc3.md", "unrelated content");

    const results = await store.search(TENANT, "test-agent", "framework");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("should isolate different tenants", async () => {
    await store.write("school-1", "agent", "data.md", "School 1 data");
    await store.write("school-2", "agent", "data.md", "School 2 data");

    const data1 = await store.read("school-1", "agent", "data.md");
    const data2 = await store.read("school-2", "agent", "data.md");

    expect(data1).toBe("School 1 data");
    expect(data2).toBe("School 2 data");
    expect(data1).not.toBe(data2);
  });
});
