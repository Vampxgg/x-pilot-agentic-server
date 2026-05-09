import type { FastifyInstance } from "fastify";
import { getTenantId, getUserId } from "../middleware/auth.js";
import { fileObjectService, toFileObjectSummary } from "../../services/file-object-service.js";
import { logger } from "../../utils/logger.js";

export function registerUploadRoutes(app: FastifyInstance): void {
  app.post("/api/uploads", async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);

    if (!request.isMultipart()) {
      return reply.code(415).send({ error: "Content-Type must be multipart/form-data" });
    }

    const saved = [];
    const errors: Array<{ filename?: string; error: string }> = [];

    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        try {
          const file = await fileObjectService.importFromBuffer(tenantId, userId, {
            buffer: Buffer.concat(chunks),
            originalName: part.filename ?? "unnamed",
            mimeType: part.mimetype ?? "application/octet-stream",
          });
          saved.push(toFileObjectSummary(file));
        } catch (err) {
          errors.push({
            filename: part.filename,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[uploads] multipart parse failed: ${msg}`);
      return reply.code(400).send({ error: msg });
    }

    if (saved.length === 0 && errors.length > 0) {
      return reply.code(400).send({ files: [], errors });
    }
    return reply.code(201).send({ files: saved, errors: errors.length > 0 ? errors : undefined });
  });

  app.post("/api/uploads/from-url", async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const body = (request.body ?? {}) as { url?: string; urls?: string[] };
    const urls = Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [];
    if (urls.length === 0) {
      return reply.code(400).send({ error: "url or urls is required" });
    }

    const saved = [];
    const errors: Array<{ url: string; error: string }> = [];
    for (const url of urls) {
      try {
        const file = await fileObjectService.importFromUrl(tenantId, userId, url);
        saved.push(toFileObjectSummary(file));
      } catch (err) {
        errors.push({ url, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (saved.length === 0 && errors.length > 0) {
      return reply.code(400).send({ files: [], errors });
    }
    return reply.code(201).send({ files: saved, errors: errors.length > 0 ? errors : undefined });
  });
}
