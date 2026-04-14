import type { FastifyInstance } from "fastify";
import { getTenantId, getUserId } from "../middleware/auth.js";
import { conversationStore } from "../../core/dify/conversation-store.js";
import { runningStreamRegistry } from "../../core/dify/stream-registry.js";

export function registerDifyCompatRoutes(app: FastifyInstance): void {

  // GET /v1/conversations — list conversations for a user
  app.get<{
    Querystring: { user?: string; limit?: string; first_id?: string };
  }>("/v1/conversations", async (request) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const { limit, first_id } = request.query;
    return conversationStore.listConversations(tenantId, userId, {
      limit: limit ? Number(limit) : 20,
      firstId: first_id,
    });
  });

  // GET /v1/messages — list messages in a conversation
  app.get<{
    Querystring: { conversation_id: string; user?: string; limit?: string; first_id?: string };
  }>("/v1/messages", async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const { conversation_id, limit, first_id } = request.query;
    if (!conversation_id) {
      return reply.code(400).send({ error: "conversation_id is required" });
    }
    return conversationStore.listMessages(tenantId, userId, conversation_id, {
      limit: limit ? Number(limit) : 20,
      firstId: first_id,
    });
  });

  // DELETE /v1/conversations/:id — delete a conversation
  app.delete<{
    Params: { id: string };
    Body: { user?: string };
  }>("/v1/conversations/:id", async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const { id } = request.params;
    const ok = await conversationStore.deleteConversation(tenantId, userId, id);
    if (!ok) {
      return reply.code(404).send({ error: "Conversation not found" });
    }
    return { result: "success" };
  });

  // POST /v1/chat-messages/:task_id/stop — stop a running stream
  app.post<{
    Params: { task_id: string };
    Body: { user?: string };
  }>("/v1/chat-messages/:task_id/stop", async (request, reply) => {
    const userId = getUserId(request);
    const { task_id } = request.params;
    const ok = runningStreamRegistry.stop(task_id, userId);
    if (!ok) {
      return reply.code(404).send({ error: "Task not found or already stopped" });
    }
    return { result: "success" };
  });
}
