import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";

export interface ArtifactMeta {
  name: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
}

const DEFAULT_DATA_DIR = resolve(process.cwd(), "data");

export class WorkspaceManager {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_DATA_DIR;
  }

  async create(tenantId: string, userId: string, sessionId?: string): Promise<string> {
    const sid = sessionId ?? randomUUID();
    const isNew = !existsSync(this.getPath(tenantId, userId, sid));
    await this.ensureExists(tenantId, userId, sid);
    if (isNew) {
      logger.info(`Workspace created: tenant=${tenantId} user=${userId} session=${sid}`);
    }
    return sid;
  }

  getPath(tenantId: string, userId: string, sessionId: string): string {
    return join(this.baseDir, "tenants", tenantId, "users", userId, "workspaces", sessionId);
  }

  private artifactPath(tenantId: string, userId: string, sessionId: string, name: string): string {
    return join(this.getPath(tenantId, userId, sessionId), name);
  }

  async ensureExists(tenantId: string, userId: string, sessionId: string): Promise<void> {
    const dir = this.getPath(tenantId, userId, sessionId);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    
    // Initialize only required subdirectories; asset paths are created lazily when written.
    const subDirs = ["artifacts", "assets", "logs"];
    for (const subDir of subDirs) {
      const fullSubDir = join(dir, subDir);
      if (!existsSync(fullSubDir)) {
        await mkdir(fullSubDir, { recursive: true });
      }
    }
  }

  async writeArtifact(tenantId: string, userId: string, sessionId: string, name: string, content: string | Buffer): Promise<string> {
    await this.ensureExists(tenantId, userId, sessionId);
    const filePath = this.artifactPath(tenantId, userId, sessionId, name);

    const dir = dirname(filePath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });

    await writeFile(filePath, content, typeof content === "string" ? "utf-8" : undefined);
    logger.info(`Artifact written: tenant=${tenantId} session=${sessionId} file=${name}`);
    return filePath;
  }

  async readArtifact(tenantId: string, userId: string, sessionId: string, name: string): Promise<string | null> {
    const filePath = this.artifactPath(tenantId, userId, sessionId, name);
    if (!existsSync(filePath)) return null;
    return readFile(filePath, "utf-8");
  }

  async listArtifacts(tenantId: string, userId: string, sessionId: string): Promise<ArtifactMeta[]> {
    const dir = this.getPath(tenantId, userId, sessionId);
    if (!existsSync(dir)) return [];

    const artifacts: ArtifactMeta[] = [];
    
    async function scanDir(currentDir: string, baseDir: string) {
      if (!existsSync(currentDir)) return;
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const relPath = fullPath.substring(baseDir.length + 1).replace(/\\/g, '/');
        
        if (entry.isDirectory()) {
          await scanDir(fullPath, baseDir);
        } else if (entry.isFile()) {
          const info = await stat(fullPath);
          artifacts.push({
            name: relPath,
            size: info.size,
            createdAt: info.birthtime.toISOString(),
            modifiedAt: info.mtime.toISOString(),
          });
        }
      }
    }

    await scanDir(dir, dir);
    return artifacts;
  }

  async cleanup(tenantId: string, userId: string, sessionId: string): Promise<void> {
    const dir = this.getPath(tenantId, userId, sessionId);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true });
      logger.info(`Workspace cleaned up: tenant=${tenantId} session=${sessionId}`);
    }
  }
}

export const workspaceManager = new WorkspaceManager();
