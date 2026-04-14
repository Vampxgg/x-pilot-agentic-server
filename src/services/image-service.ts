import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile, unlink, access } from "node:fs/promises";
import { join, resolve, extname } from "node:path";

const DATA_DIR = resolve(process.cwd(), "data");
const IMAGE_LIB_DIR = join(DATA_DIR, "images", "library");
const METADATA_FILE = join(DATA_DIR, "images", "metadata.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageMetadata {
  // Identity
  id: string;
  hash: string;

  // Ownership
  tenantId: string;
  userId: string;
  sessionId?: string;

  // File info
  filename: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;

  // Source tracing
  source: "upload" | "ai_generated" | "web_import" | "knowledge_recall";
  sourceDetail?: {
    knowledgeBaseId?: string;
    documentId?: string;
    segmentId?: string;
    originalUrl?: string;
    imgKeywords?: string[];
    imgDescription?: string;
    generationPrompt?: string;
    generationModel?: string;
  };

  // Classification
  tags: string[];
  domain?: string;
  description?: string;

  // Storage (decoupled from access URL)
  storagePath: string;

  // Usage stats
  usageCount: number;
  lastUsedAt?: string;

  // Access control
  visibility: "shared" | "tenant" | "private";

  // Extension slot
  extra?: Record<string, unknown>;

  // Time
  createdAt: string;
  updatedAt?: string;
}

export interface ImportFromUrlOptions {
  tenantId: string;
  userId: string;
  sessionId?: string;
  source: ImageMetadata["source"];
  sourceDetail?: ImageMetadata["sourceDetail"];
  tags?: string[];
  domain?: string;
  description?: string;
  visibility?: ImageMetadata["visibility"];
}

export interface ImportFromBufferOptions extends ImportFromUrlOptions {
  filename: string;
  mimeType: string;
}

export interface ResolveContext {
  sectionTitle: string;
  sectionId?: string;
  domain?: string;
  imageCount: number;
  keywords?: string[];
}

export interface ResolvedImage {
  imageId: string;
  url: string;
  matchScore: number;
  source: ImageMetadata["source"];
}

export interface ResolveResult {
  resolved: ResolvedImage[];
  unresolved: number;
}

export interface SmartMatchResult {
  imageId: string;
  url: string;
  matchScore: number;
  source: ImageMetadata["source"];
  keywords: string[];
}

export interface SmartMatchOptions {
  keywords: string[];
  count: number;
  domain?: string;
  excludeIds?: string[];
}

// ---------------------------------------------------------------------------
// ImageService
// ---------------------------------------------------------------------------

export class ImageService {
  private static _instance: ImageService | null = null;

  static getInstance(): ImageService {
    if (!ImageService._instance) {
      ImageService._instance = new ImageService();
    }
    return ImageService._instance;
  }

  // ---- Metadata I/O ----

  private async readMetadata(): Promise<ImageMetadata[]> {
    try {
      const raw = await readFile(METADATA_FILE, "utf-8");
      return JSON.parse(raw) as ImageMetadata[];
    } catch {
      return [];
    }
  }

  private async writeMetadata(list: ImageMetadata[]): Promise<void> {
    await mkdir(join(DATA_DIR, "images"), { recursive: true });
    await writeFile(METADATA_FILE, JSON.stringify(list, null, 2), "utf-8");
  }

  // ---- Helpers ----

  getImageUrl(image: ImageMetadata): string {
    const base = (process.env.IMAGE_SERVE_BASE_URL ?? "").replace(/\/$/, "");
    if (base) return `${base}/${image.storagePath}`;
    return `/api/files/${image.storagePath}`;
  }

  getAbsoluteImageUrl(image: ImageMetadata): string {
    let base = process.env.IMAGE_SERVE_BASE_URL;
    if (!base) {
      const publicBase = process.env.PUBLIC_BASE_URL;
      base = publicBase
        ? `${publicBase.replace(/\/$/, "")}/api/files`
        : `http://localhost:${process.env.PORT ?? 3000}/api/files`;
    }
    return `${base.replace(/\/$/, "")}/${image.storagePath}`;
  }

  private extFromMime(mimeType: string): string {
    const map: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
    };
    return map[mimeType] ?? "jpg";
  }

  private mimeFromExt(ext: string): string {
    const map: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
    };
    return map[ext.toLowerCase().replace(".", "")] ?? "image/jpeg";
  }

  // ---- Core: import from buffer ----

  async importFromBuffer(buffer: Buffer, opts: ImportFromBufferOptions): Promise<ImageMetadata> {
    const hash = createHash("sha256").update(buffer).digest("hex");
    const existing = await this.findByHash(hash);
    if (existing) return existing;

    const ext = this.extFromMime(opts.mimeType);
    const filename = `${hash}.${ext}`;
    const storagePath = `images/library/${filename}`;
    const destPath = join(IMAGE_LIB_DIR, filename);

    await mkdir(IMAGE_LIB_DIR, { recursive: true });
    await writeFile(destPath, buffer);

    const meta: ImageMetadata = {
      id: randomUUID(),
      hash,
      tenantId: opts.tenantId,
      userId: opts.userId,
      sessionId: opts.sessionId,
      filename: opts.filename,
      mimeType: opts.mimeType,
      size: buffer.length,
      source: opts.source,
      sourceDetail: opts.sourceDetail,
      tags: opts.tags ?? [],
      domain: opts.domain,
      description: opts.description,
      storagePath,
      usageCount: 0,
      visibility: opts.visibility ?? "shared",
      createdAt: new Date().toISOString(),
    };

    const list = await this.readMetadata();
    list.push(meta);
    await this.writeMetadata(list);

    return meta;
  }

  // ---- Core: import from URL ----

  async importFromUrl(url: string, opts: ImportFromUrlOptions): Promise<ImageMetadata | null> {
    // Check if already imported by originalUrl to avoid redundant downloads
    const existingByUrl = await this.findByOriginalUrl(url);
    if (existingByUrl) return existingByUrl;

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) return null;

      const contentType = resp.headers.get("content-type") ?? "image/jpeg";
      const mimeType = contentType.split(";")[0].trim();
      const buffer = Buffer.from(await resp.arrayBuffer());

      const ext = extname(new URL(url).pathname).slice(1) || this.extFromMime(mimeType);
      const filename = `imported-${Date.now()}.${ext}`;

      return await this.importFromBuffer(buffer, {
        ...opts,
        filename,
        mimeType,
        sourceDetail: { ...opts.sourceDetail, originalUrl: url },
      });
    } catch {
      return null;
    }
  }

  // ---- Core: import from local file path ----

  async importFromFilePath(
    filePath: string,
    opts: Omit<ImportFromBufferOptions, "mimeType"> & { mimeType?: string },
  ): Promise<ImageMetadata | null> {
    try {
      const buffer = await readFile(filePath);
      const ext = extname(filePath).slice(1);
      const mimeType = opts.mimeType ?? this.mimeFromExt(ext);
      return await this.importFromBuffer(buffer, { ...opts, mimeType });
    } catch {
      return null;
    }
  }

  // ---- Query ----

  async findByHash(hash: string): Promise<ImageMetadata | null> {
    const list = await this.readMetadata();
    return list.find(m => m.hash === hash) ?? null;
  }

  async findByOriginalUrl(url: string): Promise<ImageMetadata | null> {
    const list = await this.readMetadata();
    return list.find(m => m.sourceDetail?.originalUrl === url) ?? null;
  }

  async getById(id: string): Promise<ImageMetadata | null> {
    const list = await this.readMetadata();
    return list.find(m => m.id === id) ?? null;
  }

  async list(filter?: {
    tenantId?: string;
    userId?: string;
    source?: ImageMetadata["source"];
    domain?: string;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<ImageMetadata[]> {
    let list = await this.readMetadata();

    if (filter?.tenantId) list = list.filter(m => m.tenantId === filter.tenantId || m.visibility === "shared");
    if (filter?.userId) list = list.filter(m => m.userId === filter.userId);
    if (filter?.source) list = list.filter(m => m.source === filter.source);
    if (filter?.domain) list = list.filter(m => m.domain === filter.domain);
    if (filter?.tags?.length) list = list.filter(m => filter.tags!.some(t => m.tags.includes(t)));

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 100;
    return list.slice(offset, offset + limit);
  }

  async updateMetadata(id: string, patch: Partial<Pick<ImageMetadata, "tags" | "domain" | "description" | "visibility" | "extra">>): Promise<ImageMetadata | null> {
    const list = await this.readMetadata();
    const idx = list.findIndex(m => m.id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch, updatedAt: new Date().toISOString() } as ImageMetadata;
    await this.writeMetadata(list);
    return list[idx]!;
  }

  async delete(id: string): Promise<boolean> {
    const list = await this.readMetadata();
    const idx = list.findIndex(m => m.id === id);
    if (idx === -1) return false;

    const meta = list[idx]!;
    const filePath = join(DATA_DIR, meta.storagePath);

    // Only delete file if no other record references the same hash
    const othersWithSameHash = list.filter(m => m.hash === meta.hash && m.id !== id);
    if (othersWithSameHash.length === 0) {
      try { await unlink(filePath); } catch { /* ignore */ }
    }

    list.splice(idx, 1);
    await this.writeMetadata(list);
    return true;
  }

  async incrementUsage(id: string): Promise<void> {
    const list = await this.readMetadata();
    const idx = list.findIndex(m => m.id === id);
    if (idx === -1) return;
    list[idx]!.usageCount = (list[idx]!.usageCount ?? 0) + 1;
    list[idx]!.lastUsedAt = new Date().toISOString();
    await this.writeMetadata(list);
  }

  async getFilePath(id: string): Promise<string | null> {
    const meta = await this.getById(id);
    if (!meta) return null;
    const filePath = join(DATA_DIR, meta.storagePath);
    try {
      await access(filePath);
      return filePath;
    } catch {
      return null;
    }
  }

  // ---- Resolve: imgKeywords intersection matching ----

  async resolve(context: ResolveContext): Promise<ResolveResult> {
    const list = await this.readMetadata();

    // Build input keyword set from sectionTitle + keywords
    const inputKeywords = tokenize(`${context.sectionTitle} ${(context.keywords ?? []).join(" ")}`);

    // Score each image
    const scored = list
      .filter(m => m.visibility === "shared" || !context.domain || m.domain === context.domain)
      .map(m => {
        const imgKws = m.sourceDetail?.imgKeywords ?? [];
        const score = computeKeywordIntersectionScore(inputKeywords, imgKws);
        return { meta: m, score };
      })
      .filter(({ score }) => score >= 2) // threshold: at least 2 keyword matches
      .sort((a, b) => {
        // Primary: score desc; secondary: usageCount desc (proven relevance)
        if (b.score !== a.score) return b.score - a.score;
        return (b.meta.usageCount ?? 0) - (a.meta.usageCount ?? 0);
      });

    const needed = context.imageCount;
    const matched = scored.slice(0, needed);

    // Increment usage for matched images
    await Promise.all(matched.map(({ meta }) => this.incrementUsage(meta.id)));

    const resolved: ResolvedImage[] = matched.map(({ meta, score }) => ({
      imageId: meta.id,
      url: this.getImageUrl(meta),
      matchScore: score,
      source: meta.source,
    }));

    return {
      resolved,
      unresolved: Math.max(0, needed - resolved.length),
    };
  }

  // ---- Smart Match: multi-dimensional scoring ----

  async smartMatch(opts: SmartMatchOptions): Promise<SmartMatchResult[]> {
    const list = await this.readMetadata();
    const inputTokens = tokenize(opts.keywords.join(" "));
    if (!inputTokens.length) return [];

    const excludeSet = new Set(opts.excludeIds ?? []);

    const scored = list
      .filter(m => {
        if (excludeSet.has(m.id)) return false;
        if (opts.domain) return m.visibility === "shared" || m.domain === opts.domain;
        return true;
      })
      .map(m => {
        let score = 0;

        const imgKws = m.sourceDetail?.imgKeywords ?? [];
        score += computeKeywordIntersectionScore(inputTokens, imgKws) * 1.0;

        if (m.tags?.length) {
          score += computeKeywordIntersectionScore(inputTokens, m.tags) * 0.8;
        }

        if (m.description) {
          const descTokens = tokenize(m.description);
          score += computeKeywordIntersectionScore(inputTokens, descTokens) * 0.5;
        }

        if (m.sourceDetail?.generationPrompt) {
          const promptTokens = tokenize(m.sourceDetail.generationPrompt);
          score += computeKeywordIntersectionScore(inputTokens, promptTokens) * 0.3;
        }

        if (m.sourceDetail?.imgDescription) {
          const imgDescTokens = tokenize(m.sourceDetail.imgDescription);
          score += computeKeywordIntersectionScore(inputTokens, imgDescTokens) * 0.5;
        }

        return { meta: m, score };
      })
      .filter(({ score }) => score >= 1.0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.meta.usageCount ?? 0) - (a.meta.usageCount ?? 0);
      });

    const matched = scored.slice(0, opts.count);
    await Promise.all(matched.map(({ meta }) => this.incrementUsage(meta.id)));

    return matched.map(({ meta, score }) => ({
      imageId: meta.id,
      url: this.getAbsoluteImageUrl(meta),
      matchScore: Math.round(score * 10) / 10,
      source: meta.source,
      keywords: meta.sourceDetail?.imgKeywords ?? meta.tags ?? [],
    }));
  }

  // ---- Ensure directories exist ----

  async ensureDirs(): Promise<void> {
    await mkdir(IMAGE_LIB_DIR, { recursive: true });
    await mkdir(join(DATA_DIR, "images"), { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  // Split on Chinese/Japanese punctuation, spaces, commas, and common delimiters
  return text
    .split(/[\s,，、。！？\.\!\?\/\-\_]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2);
}

function computeKeywordIntersectionScore(inputKws: string[], imgKws: string[]): number {
  if (!imgKws.length || !inputKws.length) return 0;
  let score = 0;
  for (const kw of imgKws) {
    for (const input of inputKws) {
      if (kw.includes(input) || input.includes(kw)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

// Singleton export
export const imageService = ImageService.getInstance();
