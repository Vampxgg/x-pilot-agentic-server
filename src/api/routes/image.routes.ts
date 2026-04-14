import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { imageService } from "../../services/image-service.js";
import { fetchImages } from "../../services/image-fetch-service.js";
import { getTenantId, getUserId } from "../middleware/auth.js";

export function registerImageRoutes(app: FastifyInstance): void {
  // ---- Upload image (multipart) ----
  app.post("/api/images/upload", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const sessionId = (request as any).sessionId as string | undefined;

    const data = await request.file();
    if (!data) return reply.status(400).send({ error: "No file uploaded" });

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const tags = typeof (request.query as any).tags === "string"
      ? (request.query as any).tags.split(",").map((t: string) => t.trim())
      : [];

    const meta = await imageService.importFromBuffer(buffer, {
      tenantId,
      userId,
      sessionId,
      filename: data.filename,
      mimeType: data.mimetype,
      source: "upload",
      tags,
      domain: (request.query as any).domain,
      description: (request.query as any).description,
    });

    return reply.status(201).send({
      ...meta,
      url: imageService.getImageUrl(meta),
    });
  });

  // ---- List images ----
  app.get("/api/images", async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string>;
    const list = await imageService.list({
      tenantId: q.tenantId,
      userId: q.userId,
      source: q.source as any,
      domain: q.domain,
      tags: q.tags ? q.tags.split(",").map(t => t.trim()) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : 100,
      offset: q.offset ? parseInt(q.offset, 10) : 0,
    });
    return reply.send({ items: list.map(m => ({ ...m, url: imageService.getImageUrl(m) })), total: list.length });
  });

  // ---- Get image metadata ----
  app.get("/api/images/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const meta = await imageService.getById(id);
    if (!meta) return reply.status(404).send({ error: "Image not found" });
    return reply.send({ ...meta, url: imageService.getImageUrl(meta) });
  });

  // ---- Serve image file ----
  app.get("/api/images/:id/file", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const filePath = await imageService.getFilePath(id);
    const meta = await imageService.getById(id);

    if (!filePath || !meta) return reply.status(404).send({ error: "Image not found" });

    void reply
      .header("Content-Type", meta.mimeType)
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(createReadStream(filePath));
  });

  // ---- Update metadata ----
  app.patch("/api/images/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, any>;
    const updated = await imageService.updateMetadata(id, {
      tags: body.tags,
      domain: body.domain,
      description: body.description,
      visibility: body.visibility,
      extra: body.extra,
    });
    if (!updated) return reply.status(404).send({ error: "Image not found" });
    return reply.send({ ...updated, url: imageService.getImageUrl(updated) });
  });

  // ---- Delete image ----
  app.delete("/api/images/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const ok = await imageService.delete(id);
    if (!ok) return reply.status(404).send({ error: "Image not found" });
    return reply.send({ success: true });
  });

  // ---- Import from URL ----
  app.post("/api/images/from-url", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const body = request.body as Record<string, any>;

    if (!body?.url) return reply.status(400).send({ error: "url is required" });

    const meta = await imageService.importFromUrl(body.url, {
      tenantId,
      userId,
      sessionId: body.sessionId,
      source: body.source ?? "web_import",
      sourceDetail: {
        originalUrl: body.url,
        knowledgeBaseId: body.knowledgeBaseId,
        documentId: body.documentId,
        segmentId: body.segmentId,
        imgKeywords: body.imgKeywords,
        imgDescription: body.imgDescription,
      },
      tags: body.tags ?? [],
      domain: body.domain,
      description: body.description ?? body.imgDescription,
    });

    if (!meta) return reply.status(422).send({ error: "Failed to import image from URL" });

    return reply.status(201).send({ ...meta, url: imageService.getImageUrl(meta) });
  });

  // ---- Resolve: match images by section context ----
  app.post("/api/images/resolve", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, any>;

    if (!body?.sectionTitle) return reply.status(400).send({ error: "sectionTitle is required" });
    if (!body?.imageCount || typeof body.imageCount !== "number") {
      return reply.status(400).send({ error: "imageCount (number) is required" });
    }

    const result = await imageService.resolve({
      sectionTitle: body.sectionTitle,
      sectionId: body.sectionId,
      domain: body.domain,
      imageCount: body.imageCount,
      keywords: body.keywords,
    });

    return reply.send(result);
  });

  // ---- Fetch: one-stop image retrieval with four-tier fallback ----
  app.post("/api/images/fetch", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const body = request.body as Record<string, any>;

    if (!body?.keywords || !Array.isArray(body.keywords) || body.keywords.length === 0) {
      return reply.status(400).send({ error: "keywords (non-empty string[]) is required" });
    }
    if (!body?.count || typeof body.count !== "number" || body.count < 1) {
      return reply.status(400).send({ error: "count (positive number) is required" });
    }

    const result = await fetchImages({
      keywords: body.keywords,
      count: body.count,
      domain: body.domain,
      databaseId: body.databaseId,
      enableWebSearch: body.enableWebSearch,
      autoGenerate: body.autoGenerate,
      generateStyle: body.generateStyle,
      imageFilters: body.imageFilters,
      tenantId,
      userId,
      sessionId: body.sessionId,
    });

    return reply.send(result);
  });
}
