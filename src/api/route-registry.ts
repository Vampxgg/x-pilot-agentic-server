import type { FastifyInstance } from "fastify";
import { logger } from "../utils/logger.js";

export type RouteRegistrar = (app: FastifyInstance) => void | Promise<void>;

class RouteRegistry {
  private registrars: { name: string; fn: RouteRegistrar }[] = [];

  register(name: string, fn: RouteRegistrar): void {
    this.registrars.push({ name, fn });
  }

  async applyAll(app: FastifyInstance): Promise<void> {
    for (const { name, fn } of this.registrars) {
      try {
        await fn(app);
        logger.info(`Business routes registered: ${name}`);
      } catch (err) {
        logger.error(`Failed to register routes for ${name}: ${err}`);
      }
    }
  }
}

export const routeRegistry = new RouteRegistry();
