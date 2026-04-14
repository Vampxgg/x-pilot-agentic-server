import type { FastifyInstance } from "fastify";
import { taskExecutor } from "../../core/task-executor.js";

export function registerTaskRoutes(app: FastifyInstance): void {
  // Get task status
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = taskExecutor.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    return task;
  });

  // Get tasks by agent
  app.get<{ Querystring: { agent?: string; parent?: string } }>(
    "/api/tasks",
    async (request) => {
      if (request.query.parent) {
        return taskExecutor.getTasksByParent(request.query.parent);
      }
      if (request.query.agent) {
        return taskExecutor.getTasksByAgent(request.query.agent);
      }
      return { stats: taskExecutor.getStats() };
    },
  );

  // Cancel task
  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const success = taskExecutor.cancelTask(request.params.id);
    if (!success) {
      return reply.code(400).send({ error: "Task cannot be cancelled (not pending or not found)" });
    }
    return { success: true };
  });
}
