import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ToolDefinition } from "../core/types.js";
import { logger } from "../utils/logger.js";

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
    logger.info(`Tool registered: ${def.name}`);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getByNames(names: string[]): StructuredToolInterface[] {
    if (names.includes("*")) {
      return this.getAll().map((t) => t.tool);
    }
    return names
      .map((n) => this.tools.get(n))
      .filter((t): t is ToolDefinition => t !== undefined)
      .map((t) => t.tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  listNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

export const toolRegistry = new ToolRegistry();
