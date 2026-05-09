import { resolve } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import { registerAgentRoutes } from "./routes/agent.routes.js";
import { registerTaskRoutes } from "./routes/task.routes.js";
import { registerHealthRoutes } from "./routes/health.routes.js";
import { registerBusinessRoutes } from "./routes/business.routes.js";
import { registerImageRoutes } from "./routes/image.routes.js";
import { registerUploadRoutes } from "./routes/upload.routes.js";
import { routeRegistry } from "./route-registry.js";
import { imageService } from "../services/image-service.js";
import { registerDifyCompatRoutes } from "./routes/dify-compat.routes.js";

const DATA_DIR = resolve(process.cwd(), "data");

export async function createServer() {
  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: "*",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
    ],
    exposedHeaders: ["Content-Disposition"],
  });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await app.register(fastifyStatic, {
    root: DATA_DIR,
    prefix: "/api/files/",
    decorateReply: false,
  });

  app.addHook("preHandler", authMiddleware);

  registerHealthRoutes(app);
  registerAgentRoutes(app);
  registerTaskRoutes(app);
  registerBusinessRoutes(app);
  registerImageRoutes(app);
  registerUploadRoutes(app);

  // Auto-registered business routes from apps/<domain>/code/
  await routeRegistry.applyAll(app);

  if ((process.env.STREAM_PROTOCOL ?? "native") === "dify") {
    registerDifyCompatRoutes(app);
    logger.info("Dify-compatible REST routes registered (/v1/conversations, /v1/messages, /v1/chat-messages/*/stop)");
  }

  return app;
}

export async function startServer() {
  const config = getConfig();
  // Ensure global image library directory exists before accepting requests
  await imageService.ensureDirs();
  const app = await createServer();

  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    const httpServer = (app as unknown as { server?: import("node:http").Server }).server;
    if (httpServer) {
      const sseTimeoutMs = parseInt(process.env.SSE_KEEPALIVE_TIMEOUT_MS ?? "600000", 10);
      httpServer.keepAliveTimeout = sseTimeoutMs;
      httpServer.headersTimeout = sseTimeoutMs + 1000;
      logger.info(`SSE keep-alive timeout: ${sseTimeoutMs}ms`);
    }
    logger.info(`X-Pilot Agentic Server running at http://${config.server.host}:${config.server.port}`);
  } catch (err) {
    logger.error(`Server failed to start: ${err}`);
    process.exit(1);
  }

  return app;
}
