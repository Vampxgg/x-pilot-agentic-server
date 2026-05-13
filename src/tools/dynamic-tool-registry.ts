import type { StructuredToolInterface } from "@langchain/core/tools";
import { logger } from "../utils/logger.js";

export type DynamicToolFactory = (
  tenantId: string,
  userId: string,
  sessionId: string,
  abortSignal?: AbortSignal,
) => StructuredToolInterface;

interface DynamicToolEntry {
  name: string;
  factory: DynamicToolFactory;
  requiresSession: boolean;
}

class DynamicToolRegistry {
  private factories = new Map<string, DynamicToolEntry>();

  register(name: string, factory: DynamicToolFactory, requiresSession = true): void {
    this.factories.set(name, { name, factory, requiresSession });
    logger.info(`Dynamic tool factory registered: ${name} (requiresSession=${requiresSession})`);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  /**
   * Create tool instances for the given allowed names + session context.
   * Only returns tools whose names appear in `allowedNames` (or all if "*").
   */
  createTools(
    allowedNames: string[],
    tenantId: string,
    userId: string,
    sessionId?: string,
    abortSignal?: AbortSignal,
  ): StructuredToolInterface[] {
    const useAll = allowedNames.includes("*");
    const results: StructuredToolInterface[] = [];

    for (const [name, entry] of this.factories) {
      if (!useAll && !allowedNames.includes(name)) continue;
      if (entry.requiresSession && !sessionId) continue;
      results.push(entry.factory(tenantId, userId, sessionId ?? "", abortSignal));
    }

    return results;
  }

  listNames(): string[] {
    return Array.from(this.factories.keys());
  }
}

export const dynamicToolRegistry = new DynamicToolRegistry();
