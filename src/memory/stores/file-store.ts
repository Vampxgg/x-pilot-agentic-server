import { readFile, writeFile, readdir, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MemoryStore, MemorySearchResult } from "../../core/types.js";

const DEFAULT_DATA_DIR = resolve(process.cwd(), "data");

export class FileMemoryStore implements MemoryStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_DATA_DIR;
  }

  private memoryDir(tenantId: string, agentName: string): string {
    return join(this.baseDir, "tenants", tenantId, "agents", agentName, "memory");
  }

  private async ensureDir(dir: string): Promise<void> {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  async read(tenantId: string, agentName: string, key: string): Promise<string | null> {
    const filePath = join(this.memoryDir(tenantId, agentName), key);
    if (!existsSync(filePath)) return null;
    return readFile(filePath, "utf-8");
  }

  async write(tenantId: string, agentName: string, key: string, content: string): Promise<void> {
    const dir = this.memoryDir(tenantId, agentName);
    await this.ensureDir(dir);
    await writeFile(join(dir, key), content, "utf-8");
  }

  async append(tenantId: string, agentName: string, key: string, content: string): Promise<void> {
    const dir = this.memoryDir(tenantId, agentName);
    await this.ensureDir(dir);
    const filePath = join(dir, key);
    await appendFile(filePath, `\n${content}`, "utf-8");
  }

  async list(tenantId: string, agentName: string): Promise<string[]> {
    const dir = this.memoryDir(tenantId, agentName);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".md"));
  }

  async search(tenantId: string, agentName: string, query: string): Promise<MemorySearchResult[]> {
    const files = await this.list(tenantId, agentName);
    const results: MemorySearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (const file of files) {
      const content = await this.read(tenantId, agentName, file);
      if (!content) continue;

      const lines = content.split("\n");
      let score = 0;
      const queryTerms = queryLower.split(/\s+/);

      for (const term of queryTerms) {
        for (const line of lines) {
          if (line.toLowerCase().includes(term)) score++;
        }
      }

      if (score > 0) {
        results.push({ key: file, content: content.slice(0, 2_000), score });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 10);
  }
}
