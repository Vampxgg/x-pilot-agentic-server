import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { agentRegistry } from "../../core/agent-registry.js";
import { agentRuntime } from "../../core/agent-runtime.js";
import { workspaceManager } from "../../core/workspace.js";
import { eventBus, type AgentEvent } from "../../core/event-bus.js";
import { SSEWriter } from "../../core/sse-writer.js";
import { getTenantId, getUserId } from "../middleware/auth.js";
import type { AgentInvokeRequest, AgentInvokeAsyncRequest, AgentCreateRequest } from "../../core/types.js";
import { logger } from "../../utils/logger.js";

const MIME_MAP: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".json": "application/json", ".zip": "application/zip",
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".ts": "text/plain", ".tsx": "text/plain", ".md": "text/markdown", ".txt": "text/plain",
  ".yaml": "text/yaml", ".yml": "text/yaml", ".csv": "text/csv",
};

function getMimeType(filename: string): string {
  return MIME_MAP[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export function registerAgentRoutes(app: FastifyInstance): void {
  app.get("/api/agents", async (request) => {
    const agents = agentRegistry.getAll();
    return agents.map((a) => ({
      name: a.name,
      model: a.config.model,
      tools: a.config.allowedTools,
      skills: a.skills.map((s) => s.name),
      heartbeatEnabled: a.config.heartbeat.enabled,
      evolutionEnabled: a.config.evolution.enabled,
    }));
  });

  app.get<{ Params: { name: string } }>("/api/agents/:name", async (request, reply) => {
    const agent = agentRegistry.get(request.params.name);
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    return {
      name: agent.name,
      config: agent.config,
      prompts: Object.fromEntries(
        Object.entries(agent.prompts).filter(([_, v]) => v).map(([k, v]) => [k, (v as string).slice(0, 500)]),
      ),
      skills: agent.skills.map((s) => ({ name: s.name, description: s.description })),
      memoryPath: agent.memoryPath,
    };
  });

  app.get<{ Params: { name: string } }>("/api/agents/:name/workflow", async (request, reply) => {
    const agent = agentRegistry.get(request.params.name);
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    if (!agent.workflow) {
      return reply.code(404).send({ error: "No workflow definition found for this agent" });
    }

    const { nodeIdMap, ...serializable } = agent.workflow;
    return serializable;
  });

  // Invoke agent (blocking)
  app.post<{ Params: { name: string }; Body: AgentInvokeRequest }>(
    "/api/agents/:name/invoke",
    async (request, reply) => {
      const { name } = request.params;
      const tenantId = getTenantId(request);
      const userId = getUserId(request);
      const { input, threadId, sessionId, context } = request.body;

      if (!agentRegistry.has(name)) return reply.code(404).send({ error: "Agent not found" });

      try {
        const result = await agentRuntime.invokeAgent(name, input, { tenantId, userId, threadId, sessionId, context });
        return result;
      } catch (err) {
        logger.error(`Agent invocation failed: ${err}`);
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Invoke agent (async)
  app.post<{ Params: { name: string }; Body: AgentInvokeAsyncRequest }>(
    "/api/agents/:name/invoke-async",
    async (request, reply) => {
      const { name } = request.params;
      const tenantId = getTenantId(request);
      const userId = getUserId(request);
      const { input, threadId, sessionId, context, webhookUrl } = request.body;

      if (!agentRegistry.has(name)) return reply.code(404).send({ error: "Agent not found" });

      try {
        const result = await agentRuntime.invokeAgentAsync(name, input, {
          tenantId, userId, threadId, sessionId, context, webhookUrl,
        });
        return reply.code(202).send(result);
      } catch (err) {
        logger.error(`Async agent invocation failed: ${err}`);
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Stream agent (SSE) — v2 protocol
  app.post<{ Params: { name: string }; Body: AgentInvokeRequest }>(
    "/api/agents/:name/stream",
    async (request, reply) => {
      const { name } = request.params;
      const tenantId = getTenantId(request);
      const userId = getUserId(request);
      const { input, threadId, sessionId, context } = request.body;

      if (!agentRegistry.has(name)) return reply.code(404).send({ error: "Agent not found" });

      let writer: SSEWriter | null = null;

      try {
        for await (const event of agentRuntime.streamAgentV2(name, input, { tenantId, userId, threadId, sessionId, context })) {
          if (!writer) {
            writer = SSEWriter.create(reply.raw, {
              taskId: event.task_id,
              sessionId: event.session_id,
            });
          }
          if (!writer.isOpen) break;
          writer.write(event);
        }
      } catch (err) {
        logger.error(`[stream] Agent stream error for ${name}: ${err}`);
      }

      if (writer) writer.end();
    },
  );

  // Create agent at runtime
  app.post<{ Body: AgentCreateRequest }>("/api/agents", async (request, reply) => {
    try {
      const agent = await agentRegistry.create(request.body);
      return reply.code(201).send({
        name: agent.name, config: agent.config, skills: agent.skills.map((s) => s.name),
      });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Reload agent
  app.post<{ Params: { name: string } }>("/api/agents/:name/reload", async (request, reply) => {
    const agent = await agentRegistry.reload(request.params.name);
    if (!agent) return reply.code(404).send({ error: "Agent not found" });
    return { name: agent.name, config: agent.config };
  });

  // Agent memory
  app.get<{ Params: { name: string }; Querystring: { query?: string } }>(
    "/api/agents/:name/memory",
    async (request, reply) => {
      if (!agentRegistry.has(request.params.name)) return reply.code(404).send({ error: "Agent not found" });

      const tenantId = getTenantId(request);
      const memoryManager = agentRuntime.getMemoryManager();
      const query = request.query.query;

      if (query) {
        const results = await memoryManager.search(tenantId, request.params.name, query);
        return { results };
      }

      const longTerm = await memoryManager.loadLongTermMemory(tenantId, request.params.name);
      return { longTermMemory: longTerm };
    },
  );

  app.post<{ Params: { name: string }; Body: { content: string } }>(
    "/api/agents/:name/memory",
    async (request, reply) => {
      if (!agentRegistry.has(request.params.name)) return reply.code(404).send({ error: "Agent not found" });

      const tenantId = getTenantId(request);
      const memoryManager = agentRuntime.getMemoryManager();
      await memoryManager.appendLesson(tenantId, request.params.name, request.body.content);
      return { success: true };
    },
  );

  // Evolution proposals
  app.get<{ Params: { name: string } }>(
    "/api/agents/:name/evolution",
    async (request, reply) => {
      if (!agentRegistry.has(request.params.name)) return reply.code(404).send({ error: "Agent not found" });

      const tenantId = getTenantId(request);
      const { heartbeatRunner } = await import("../../index.js");
      if (!heartbeatRunner) return reply.code(503).send({ error: "Heartbeat not initialized" });

      const proposals = heartbeatRunner.getEvolver().getPendingProposals(tenantId, request.params.name);
      return { proposals };
    },
  );

  app.post<{ Params: { name: string; id: string } }>(
    "/api/agents/:name/evolution/:id/approve",
    async (request, reply) => {
      const agentDef = agentRegistry.get(request.params.name);
      if (!agentDef) return reply.code(404).send({ error: "Agent not found" });

      const { heartbeatRunner } = await import("../../index.js");
      if (!heartbeatRunner) return reply.code(503).send({ error: "Heartbeat not initialized" });

      const proposal = heartbeatRunner.getEvolver().approveProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: "Proposal not found" });

      const applied = await heartbeatRunner.getApplier().apply(proposal, agentDef);
      return { success: applied, proposal };
    },
  );

  app.post<{ Params: { name: string; id: string } }>(
    "/api/agents/:name/evolution/:id/reject",
    async (request, reply) => {
      if (!agentRegistry.has(request.params.name)) return reply.code(404).send({ error: "Agent not found" });

      const { heartbeatRunner } = await import("../../index.js");
      if (!heartbeatRunner) return reply.code(503).send({ error: "Heartbeat not initialized" });

      const proposal = heartbeatRunner.getEvolver().rejectProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: "Proposal not found" });

      return { success: true, proposal };
    },
  );

  // Session events SSE
  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/events",
    async (request, reply) => {
      const { sessionId } = request.params;

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const handler = (event: AgentEvent) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      eventBus.onSession(sessionId, handler);
      request.raw.on("close", () => { eventBus.offSession(sessionId, handler); });
    },
  );

  // Session artifacts — list
  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/artifacts",
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const userId = getUserId(request);
      const { sessionId } = request.params;

      try {
        const artifacts = await workspaceManager.listArtifacts(tenantId, userId, sessionId);
        return { sessionId, artifacts };
      } catch (err) {
        logger.error(`Failed to list artifacts: ${err}`);
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Session artifacts — download
  app.get<{ Params: { sessionId: string; "*": string } }>(
    "/api/sessions/:sessionId/artifacts/*",
    async (request, reply) => {
      const tenantId = getTenantId(request);
      const userId = getUserId(request);
      const { sessionId } = request.params;
      const artifactName = (request.params as Record<string, string>)["*"];

      if (!artifactName || artifactName.includes("..")) {
        return reply.code(400).send({ error: "Invalid artifact name" });
      }

      const workspacePath = workspaceManager.getPath(tenantId, userId, sessionId);
      const artifactsDir = join(workspacePath, "artifacts");
      const filePath = normalize(join(artifactsDir, artifactName));

      if (!filePath.startsWith(artifactsDir)) {
        return reply.code(403).send({ error: "Path traversal not allowed" });
      }

      if (!existsSync(filePath)) {
        return reply.code(404).send({ error: "Artifact not found" });
      }

      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) {
          return reply.code(400).send({ error: "Not a file" });
        }

        const mimeType = getMimeType(artifactName);
        const stream = createReadStream(filePath);

        return reply
          .header("Content-Type", mimeType)
          .header("Content-Length", stat.size)
          .header("Content-Disposition", `inline; filename="${encodeURIComponent(artifactName)}"`)
          .send(stream);
      } catch (err) {
        logger.error(`Failed to serve artifact: ${err}`);
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // WebSocket
  app.register(async (fastify) => {
    fastify.get<{ Params: { name: string } }>(
      "/ws/agents/:name",
      { websocket: true },
      async (socket, request) => {
        const { name } = request.params;
        const tenantId = getTenantId(request);
        const userId = getUserId(request);

        if (!agentRegistry.has(name)) {
          socket.send(JSON.stringify({ error: "Agent not found" }));
          socket.close();
          return;
        }

        socket.on("message", async (rawMessage: { toString(): string }) => {
          try {
            const message = JSON.parse(rawMessage.toString());
            const { input, threadId, sessionId, context } = message;

            let seq = 0;
            for await (const event of agentRuntime.streamAgentV2(name, input, { tenantId, userId, threadId, sessionId, context })) {
              const stamped = { ...event, id: ++seq };
              socket.send(JSON.stringify(stamped));
            }
          } catch (err) {
            socket.send(JSON.stringify({ event: "error", data: { code: "WS_ERROR", message: String(err), recoverable: false } }));
          }
        });
      },
    );
  });
}
