import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../../../src/utils/logger.js";
import { workspaceManager as defaultWorkspaceManager, type WorkspaceManager } from "../../../../src/core/workspace.js";
import { fileObjectService, type FileObjectService, type FileObject } from "../../../../src/services/file-object-service.js";
import type { ChatFileUrlInput } from "../types.js";
import type { UploadedFile, UploadsManifest } from "./types.js";
import { manifestPath, uploadsDir } from "./paths.js";

// Per-session manifest write serialization (in-memory, single-process).
const writeChains = new Map<string, Promise<unknown>>();

function sessionKey(t: string, u: string, sid: string): string {
  return `${t}::${u}::${sid}`;
}

function chain<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(key, next.catch(() => undefined));
  return next;
}

export interface UploadsServiceOptions {
  fileService?: FileObjectService;
  workspaceManager?: WorkspaceManager;
}

function deps(options?: UploadsServiceOptions): Required<UploadsServiceOptions> {
  return {
    fileService: options?.fileService ?? fileObjectService,
    workspaceManager: options?.workspaceManager ?? defaultWorkspaceManager,
  };
}

function manifestPathFor(wm: WorkspaceManager, t: string, u: string, sid: string): string {
  return optionsAwareManifestPath(wm, t, u, sid);
}

function uploadsDirFor(wm: WorkspaceManager, t: string, u: string, sid: string): string {
  return wm === defaultWorkspaceManager ? uploadsDir(t, u, sid) : join(wm.getPath(t, u, sid), "uploads");
}

function optionsAwareManifestPath(wm: WorkspaceManager, t: string, u: string, sid: string): string {
  return wm === defaultWorkspaceManager ? manifestPath(t, u, sid) : join(uploadsDirFor(wm, t, u, sid), "manifest.json");
}

function asUploadedFile(file: FileObject): UploadedFile {
  return {
    ...file,
    byteSize: file.size,
    uploadedAt: file.createdAt,
  };
}

async function readManifest(t: string, u: string, sid: string, options?: UploadsServiceOptions): Promise<UploadsManifest> {
  const { workspaceManager } = deps(options);
  const p = manifestPathFor(workspaceManager, t, u, sid);
  if (!existsSync(p)) return { version: 2, files: [] };
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as UploadsManifest | { version: 1; files: Array<{ fileId: string; uploadedAt?: string }> };
    if (!Array.isArray(parsed.files)) {
      logger.warn(`[uploads] manifest version mismatch at ${p}, resetting in-memory`);
      return { version: 2, files: [] };
    }
    if (parsed.version === 1) {
      return {
        version: 2,
        files: parsed.files
          .filter((file) => typeof file.fileId === "string")
          .map((file) => ({ fileId: file.fileId, addedAt: file.uploadedAt ?? new Date().toISOString() })),
      };
    }
    return { version: 2, files: parsed.files };
  } catch (err) {
    logger.warn(`[uploads] manifest parse failed at ${p}: ${err}`);
    return { version: 2, files: [] };
  }
}

async function writeManifest(t: string, u: string, sid: string, m: UploadsManifest, options?: UploadsServiceOptions): Promise<void> {
  const { workspaceManager } = deps(options);
  const dir = uploadsDirFor(workspaceManager, t, u, sid);
  await mkdir(dir, { recursive: true });
  const p = manifestPathFor(workspaceManager, t, u, sid);
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(m, null, 2), "utf-8");
  await rename(tmp, p);
}

export interface AddFileInput {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}

/**
 * Compatibility wrapper for the legacy session upload endpoint.
 * New code should import files through FileObjectService, then bind fileIds.
 */
export async function addFile(
  tenantId: string,
  userId: string,
  sessionId: string,
  input: AddFileInput,
  options?: UploadsServiceOptions,
): Promise<UploadedFile> {
  const { fileService } = deps(options);
  const file = await fileService.importFromBuffer(tenantId, userId, {
    buffer: input.buffer,
    originalName: input.originalName,
    mimeType: input.mimeType,
  });
  const [bound] = await bindFilesToSession(tenantId, userId, sessionId, [file.fileId], options);
  if (!bound) throw new Error(`failed to bind uploaded file: ${file.fileId}`);
  logger.info(`[uploads] added fileId=${file.fileId} session=${sessionId} name="${bound.name}" bytes=${bound.byteSize}`);
  return bound;
}

export async function bindFilesToSession(
  tenantId: string,
  userId: string,
  sessionId: string,
  fileIds: string[],
  options?: UploadsServiceOptions,
): Promise<UploadedFile[]> {
  const { fileService } = deps(options);
  const unique = [...new Set(fileIds)];
  const files = await fileService.resolveByIds(tenantId, userId, unique);
  if (files.length !== unique.length) {
    throw new Error("file not found or not accessible");
  }

  await chain(sessionKey(tenantId, userId, sessionId), async () => {
    const m = await readManifest(tenantId, userId, sessionId, options);
    const existing = new Set(m.files.map((file) => file.fileId));
    for (const fileId of unique) {
      if (!existing.has(fileId)) {
        m.files.push({ fileId, addedAt: new Date().toISOString() });
      }
    }
    await writeManifest(tenantId, userId, sessionId, m, options);
  });

  return files.map(asUploadedFile);
}

export async function listFiles(tenantId: string, userId: string, sessionId: string, options?: UploadsServiceOptions): Promise<UploadedFile[]> {
  const { fileService, workspaceManager } = deps(options);
  if (!existsSync(uploadsDirFor(workspaceManager, tenantId, userId, sessionId))) return [];
  const m = await readManifest(tenantId, userId, sessionId, options);
  const files = await fileService.resolveByIds(tenantId, userId, m.files.map((file) => file.fileId));
  return files.map(asUploadedFile);
}

export async function getFile(
  tenantId: string,
  userId: string,
  sessionId: string,
  fileId: string,
  options?: UploadsServiceOptions,
): Promise<UploadedFile | null> {
  const resolved = await resolveByIds(tenantId, userId, sessionId, [fileId], options);
  return resolved[0] ?? null;
}

export async function deleteFile(
  tenantId: string,
  userId: string,
  sessionId: string,
  fileId: string,
  options?: UploadsServiceOptions,
): Promise<boolean> {
  return chain(sessionKey(tenantId, userId, sessionId), async () => {
    const m = await readManifest(tenantId, userId, sessionId, options);
    const idx = m.files.findIndex((f) => f.fileId === fileId);
    if (idx < 0) return false;
    m.files.splice(idx, 1);
    await writeManifest(tenantId, userId, sessionId, m, options);
    logger.info(`[uploads] deleted fileId=${fileId} session=${sessionId}`);
    return true;
  });
}

export async function cacheText(
  tenantId: string,
  userId: string,
  sessionId: string,
  fileId: string,
  text: string,
  options?: UploadsServiceOptions,
): Promise<void> {
  const { fileService } = deps(options);
  if (!(await getFile(tenantId, userId, sessionId, fileId, options))) return;
  await fileService.cacheText(fileId, text);
}

export async function markUnreadable(
  tenantId: string,
  userId: string,
  sessionId: string,
  fileId: string,
  reason: string,
  options?: UploadsServiceOptions,
): Promise<void> {
  const { fileService } = deps(options);
  if (!(await getFile(tenantId, userId, sessionId, fileId, options))) return;
  await fileService.markUnreadable(fileId, reason);
}

/** Resolve fileIds against manifest, silently dropping unknown ones (avoids hard 400 on stale ID). */
export async function resolveByIds(
  tenantId: string,
  userId: string,
  sessionId: string,
  fileIds: string[],
  options?: UploadsServiceOptions,
): Promise<UploadedFile[]> {
  const { fileService } = deps(options);
  const m = await readManifest(tenantId, userId, sessionId, options);
  const set = new Set(fileIds);
  const boundIds = m.files.map((f) => f.fileId).filter((id) => set.has(id));
  const files = await fileService.resolveByIds(tenantId, userId, boundIds);
  return files.map(asUploadedFile);
}

export async function importFileUrls(
  tenantId: string,
  userId: string,
  fileUrls: ChatFileUrlInput[] | undefined,
  options?: UploadsServiceOptions,
): Promise<UploadedFile[]> {
  if (!Array.isArray(fileUrls) || fileUrls.length === 0) return [];
  const { fileService } = deps(options);
  const files = [];
  for (const [index, file] of fileUrls.entries()) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.fileName !== "string" ||
      file.fileName.trim() === "" ||
      typeof file.fileType !== "string" ||
      file.fileType.trim() === "" ||
      typeof file.url !== "string" ||
      file.url.trim() === ""
    ) {
      throw new Error(`fileUrls[${index}] must be an object with fileName, fileType, and url`);
    }
    files.push(asUploadedFile(await fileService.importFromUrl(tenantId, userId, file.url.trim(), {
      originalName: file.fileName.trim(),
      mimeType: file.fileType.trim(),
    })));
  }
  return files;
}
