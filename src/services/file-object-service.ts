import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { resolvePublicBaseUrl } from "../utils/public-url.js";
import { logger } from "../utils/logger.js";
import { extractText, type FileKind } from "./file-text-extractor.js";

export type { FileKind };

export interface FileObject {
  fileId: string;
  tenantId: string;
  userId: string;
  name: string;
  storedName: string;
  mimeType: string;
  kind: FileKind;
  size: number;
  storagePath: string;
  url: string;
  source: "upload" | "url";
  originalUrl?: string;
  createdAt: string;
  textCachePath?: string;
  textChars?: number;
  unreadable?: boolean;
  unreadableReason?: string;
}

export interface ImportBufferInput {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  source?: "upload" | "url";
  originalUrl?: string;
}

export interface FileObjectSummary {
  fileId: string;
  name: string;
  mimeType: string;
  kind: FileKind;
  size: number;
  byteSize: number;
  url: string;
  textChars?: number;
  unreadable?: boolean;
}

interface FileObjectManifest {
  version: 1;
  files: FileObject[];
}

const DEFAULT_BASE_DIR = resolve(process.cwd(), "data", "uploads");
const QUOTA_MB = Number(process.env.FILE_UPLOAD_QUOTA_MB ?? 200);
const QUOTA_BYTES = QUOTA_MB * 1024 * 1024;
const URL_IMPORT_MAX_BYTES = Number(process.env.FILE_URL_IMPORT_MAX_BYTES ?? 50 * 1024 * 1024);

const REJECTED_MIME = new Set([
  "application/x-msdownload",
  "application/x-sh",
  "application/x-bat",
  "application/x-msi",
  "application/x-msdos-program",
]);

const MIME_EXT_MAP: Record<string, string> = {
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/msword": "doc",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.ms-excel": "xls",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

const SAFE_EXT_RE = /^[a-z0-9]{1,8}$/;

function inferKind(mimeType: string, ext: string): FileKind {
  const mt = mimeType.toLowerCase();
  if (mt.startsWith("image/")) return "image";
  if (mt.startsWith("audio/")) return "audio";
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("text/") || mt === "application/json") return "doc";
  if (
    mt === "application/pdf" ||
    mt.includes("officedocument.wordprocessing") ||
    mt.includes("officedocument.presentation") ||
    mt === "application/msword" ||
    mt === "application/vnd.ms-powerpoint"
  ) {
    return "doc";
  }
  if (mt.includes("spreadsheet") || mt === "text/csv" || ext === ".csv" || ext === ".tsv") {
    return "data";
  }
  if ([".txt", ".md", ".markdown", ".log", ".yaml", ".yml", ".html", ".htm", ".xml", ".srt", ".vtt"].includes(ext)) {
    return "doc";
  }
  return "unknown";
}

function pickExt(originalName: string, mimeType: string): string {
  const native = extname(originalName).toLowerCase().replace(/^\./, "");
  if (SAFE_EXT_RE.test(native)) return native;
  const mapped = MIME_EXT_MAP[mimeType.toLowerCase()];
  if (mapped && SAFE_EXT_RE.test(mapped)) return mapped;
  return "bin";
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const parts = address.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((x) => Number.isNaN(x))) return false;
  const [a, b] = parts;
  return a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0;
}

function basenameFromUrl(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop();
  return last ? decodeURIComponent(last) : "download";
}

export function toFileObjectSummary(file: FileObject): FileObjectSummary {
  return {
    fileId: file.fileId,
    name: file.name,
    mimeType: file.mimeType,
    kind: file.kind,
    size: file.size,
    byteSize: file.size,
    url: file.url,
    textChars: file.textChars,
    unreadable: file.unreadable,
  };
}

export class FileObjectService {
  private readonly baseDir: string;
  private readonly publicFilesBaseUrl: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(baseDir = DEFAULT_BASE_DIR, publicFilesBaseUrl?: string) {
    this.baseDir = baseDir;
    this.publicFilesBaseUrl = publicFilesBaseUrl ?? `${resolvePublicBaseUrl()}/api/files`;
  }

  absolutePath(file: FileObject): string {
    return join(this.baseDir, file.storagePath.replace(/^uploads[\\/]/, ""));
  }

  async importFromBuffer(tenantId: string, userId: string, input: ImportBufferInput): Promise<FileObject> {
    const mt = (input.mimeType || "application/octet-stream").trim();
    if (REJECTED_MIME.has(mt.toLowerCase())) {
      throw new Error(`Rejected MIME type: ${mt}`);
    }
    if (input.buffer.byteLength > QUOTA_BYTES) {
      throw new Error(`File upload quota exceeded: ${input.buffer.byteLength} > ${QUOTA_BYTES} bytes`);
    }

    await this.ensureDirs();
    const fileId = `file_${randomUUID()}`;
    const ext = pickExt(input.originalName, mt);
    const storedName = `${fileId}.${ext}`;
    const relativeObjectPath = join("objects", storedName);
    const storagePath = `uploads/objects/${storedName}`;
    const absPath = join(this.baseDir, relativeObjectPath);
    const tmpPath = `${absPath}.tmp`;

    await writeFile(tmpPath, input.buffer);
    await rename(tmpPath, absPath);

    const file: FileObject = {
      fileId,
      tenantId,
      userId,
      name: input.originalName || storedName,
      storedName,
      mimeType: mt,
      kind: inferKind(mt, `.${ext}`),
      size: input.buffer.byteLength,
      storagePath,
      url: `${this.publicFilesBaseUrl.replace(/\/$/, "")}/${storagePath}`,
      source: input.source ?? "upload",
      originalUrl: input.originalUrl,
      createdAt: new Date().toISOString(),
    };

    await this.withManifest(async (manifest) => {
      manifest.files.push(file);
      return manifest;
    });

    logger.info(`[file-objects] imported fileId=${fileId} tenant=${tenantId} user=${userId} name="${file.name}" bytes=${file.size}`);
    return file;
  }

  async importFromUrl(tenantId: string, userId: string, rawUrl: string): Promise<FileObject> {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http and https URLs are supported");
    }
    await this.assertPublicHostname(url.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) {
        throw new Error(`URL import failed: HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > URL_IMPORT_MAX_BYTES) {
        throw new Error(`URL import too large: ${contentLength} > ${URL_IMPORT_MAX_BYTES} bytes`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > URL_IMPORT_MAX_BYTES) {
        throw new Error(`URL import too large: ${buffer.byteLength} > ${URL_IMPORT_MAX_BYTES} bytes`);
      }
      return this.importFromBuffer(tenantId, userId, {
        buffer,
        originalName: basenameFromUrl(url),
        mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
        source: "url",
        originalUrl: rawUrl,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async getById(tenantId: string, userId: string, fileId: string): Promise<FileObject | null> {
    const manifest = await this.readManifest();
    return manifest.files.find((file) => file.fileId === fileId && file.tenantId === tenantId && file.userId === userId) ?? null;
  }

  async resolveByIds(tenantId: string, userId: string, fileIds: string[]): Promise<FileObject[]> {
    const manifest = await this.readManifest();
    const ids = new Set(fileIds);
    return manifest.files.filter((file) => ids.has(file.fileId) && file.tenantId === tenantId && file.userId === userId);
  }

  async delete(tenantId: string, userId: string, fileId: string): Promise<boolean> {
    let removed: FileObject | undefined;
    await this.withManifest(async (manifest) => {
      const idx = manifest.files.findIndex((file) => file.fileId === fileId && file.tenantId === tenantId && file.userId === userId);
      if (idx < 0) return manifest;
      [removed] = manifest.files.splice(idx, 1);
      return manifest;
    });
    if (!removed) return false;
    for (const p of [this.absolutePath(removed), removed.textCachePath].filter(Boolean) as string[]) {
      try {
        if (existsSync(p)) await rm(p);
      } catch (err) {
        logger.warn(`[file-objects] failed to remove ${p}: ${err}`);
      }
    }
    return true;
  }

  async readText(file: FileObject): Promise<string> {
    if (file.unreadable) {
      throw new Error(file.unreadableReason ?? "binary asset");
    }
    if (file.textCachePath && existsSync(file.textCachePath)) {
      return readFile(file.textCachePath, "utf-8");
    }
    const result = await extractText(file, this.absolutePath(file));
    if (!result.ok) {
      await this.markUnreadable(file.fileId, result.reason);
      throw new Error(result.reason);
    }
    await this.cacheText(file.fileId, result.text);
    return result.text;
  }

  async cacheText(fileId: string, text: string): Promise<void> {
    await this.ensureDirs();
    const cachePath = join(this.baseDir, "text-cache", `${fileId}.text`);
    await writeFile(cachePath, text, "utf-8");
    await this.withManifest(async (manifest) => {
      const file = manifest.files.find((x) => x.fileId === fileId);
      if (file) {
        file.textCachePath = cachePath;
        file.textChars = text.length;
        delete file.unreadable;
        delete file.unreadableReason;
      }
      return manifest;
    });
  }

  async markUnreadable(fileId: string, reason: string): Promise<void> {
    await this.withManifest(async (manifest) => {
      const file = manifest.files.find((x) => x.fileId === fileId);
      if (file) {
        file.unreadable = true;
        file.unreadableReason = reason;
      }
      return manifest;
    });
  }

  private async assertPublicHostname(hostname: string): Promise<void> {
    const address = hostname.replace(/^\[|\]$/g, "");
    if (isIP(address)) {
      if (isPrivateAddress(address)) {
        throw new Error("private or loopback addresses are not allowed");
      }
      return;
    }
    const records = await lookup(hostname, { all: true });
    if (records.some((record) => isPrivateAddress(record.address))) {
      throw new Error("private or loopback addresses are not allowed");
    }
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(join(this.baseDir, "objects"), { recursive: true });
    await mkdir(join(this.baseDir, "text-cache"), { recursive: true });
  }

  private manifestPath(): string {
    return join(this.baseDir, "metadata.json");
  }

  private async readManifest(): Promise<FileObjectManifest> {
    const p = this.manifestPath();
    if (!existsSync(p)) return { version: 1, files: [] };
    try {
      const raw = await readFile(p, "utf-8");
      const parsed = JSON.parse(raw) as FileObjectManifest;
      if (parsed.version !== 1 || !Array.isArray(parsed.files)) return { version: 1, files: [] };
      return parsed;
    } catch (err) {
      logger.warn(`[file-objects] manifest read failed: ${err}`);
      return { version: 1, files: [] };
    }
  }

  private async writeManifest(manifest: FileObjectManifest): Promise<void> {
    await this.ensureDirs();
    const p = this.manifestPath();
    const tmp = `${p}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest, null, 2), "utf-8");
    await rename(tmp, p);
  }

  private async withManifest(fn: (manifest: FileObjectManifest) => FileObjectManifest | Promise<FileObjectManifest>): Promise<void> {
    const next = this.writeChain.then(async () => {
      const manifest = await this.readManifest();
      await this.writeManifest(await fn(manifest));
    });
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}

export const fileObjectService = new FileObjectService();
