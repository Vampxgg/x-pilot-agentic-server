import type { FastifyInstance } from "fastify";
import { agentRegistry } from "../../core/agent-registry.js";
import { taskExecutor } from "../../core/task-executor.js";
import { toolRegistry } from "../../tools/tool-registry.js";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/api/health", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      agents: agentRegistry.list().length,
      tools: toolRegistry.listNames().length,
      tasks: taskExecutor.getStats(),
    };
  });
}
