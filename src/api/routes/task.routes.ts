import type { FastifyInstance } from "fastify";
import { taskExecutor } from "../../core/task-executor.js";
import { runningRunRegistry } from "../../core/run-cancel-registry.js";
import { runningStreamRegistry } from "../../core/dify/stream-registry.js";
import { getUserId } from "../middleware/auth.js";

export function registerTaskRoutes(app: FastifyInstance): void {
  // Cancel a running stream/run by task id
  app.post<{ Params: { runId: string } }>("/runs/:runId/cancel", async (request, reply) => {
    const userId = getUserId(request);
    const result = runningRunRegistry.cancel(request.params.runId, userId);
    if (result.ok) return { success: true };

    const stoppedDifyStream = runningStreamRegistry.stop(request.params.runId, userId);
    if (stoppedDifyStream) return { success: true };

    const cancelledPendingTask = taskExecutor.cancelTask(request.params.runId);
    if (cancelledPendingTask) return { success: true };

    if (result.reason === "forbidden") {
      return reply.code(403).send({ error: "Run does not belong to current user" });
    }
    return reply.code(404).send({ error: "Run not found or already finished" });
  });

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
