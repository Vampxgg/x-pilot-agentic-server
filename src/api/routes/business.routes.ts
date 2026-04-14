import type { FastifyInstance } from "fastify";

/**
 * Legacy business routes stub. Teaching resource / document-generation routes
 * have been moved to apps/document-generation/code/routes.ts and are
 * auto-registered via routeRegistry from apps/<domain>/code/.
 */
export function registerBusinessRoutes(_app: FastifyInstance): void {
  // No-op: document-generation routes are in apps/document-generation/code/
}
