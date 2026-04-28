import { randomUUID } from "node:crypto";
import type {
  AgentDefinition,
  AgentInvokeResponse,
  PipelineConfig,
  PipelineStep,
  PipelineHandler,
  PipelineHandlerContext,
} from "./types.js";
import type { InvokeOptions } from "./agent-runtime.js";
import { subAgentManager } from "./sub-agent-manager.js";
import { eventBus } from "./event-bus.js";
import { workspaceManager } from "./workspace.js";
import { logger } from "../utils/logger.js";

export interface PipelineResult {
  threadId: string;
  output: string;
  steps: Record<string, { success: boolean; result: unknown; duration: number }>;
  taskResult: {
    success: boolean;
    output: unknown;
    duration: number;
    toolCalls: [];
    subAgentResults: [];
  };
}

// -------------------------------------------------------------------------
// Topological sort — groups steps into batches that can run in parallel
// -------------------------------------------------------------------------

export function topologicalSort(steps: PipelineStep[]): PipelineStep[][] {
  const stepMap = new Map(steps.map((s) => [s.name, s]));
  const resolved = new Set<string>();
  const batches: PipelineStep[][] = [];

  let remaining = [...steps];
  let safety = steps.length + 1;

  while (remaining.length > 0 && safety-- > 0) {
    const batch = remaining.filter((s) =>
      !s.dependsOn?.length || s.dependsOn.every((dep) => resolved.has(dep)),
    );

    if (batch.length === 0) {
      const unresolved = remaining.map((s) => s.name).join(", ");
      throw new Error(`Pipeline has circular dependencies or missing steps: ${unresolved}`);
    }

    batches.push(batch);
    for (const s of batch) resolved.add(s.name);
    remaining = remaining.filter((s) => !resolved.has(s.name));
  }

  return batches;
}

// -------------------------------------------------------------------------
// Utility: resolve a dotted path like "script.scenes" from step results
// -------------------------------------------------------------------------

function getNestedValue(results: Map<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  const stepName = parts[0]!;
  let value = results.get(stepName);

  for (let i = 1; i < parts.length && value != null; i++) {
    if (typeof value === "object") {
      value = (value as Record<string, unknown>)[parts[i]!];
    } else {
      return undefined;
    }
  }

  return value;
}

// -------------------------------------------------------------------------
// Build instruction for a pipeline step by merging dependency outputs
// -------------------------------------------------------------------------

function buildStepInstruction(
  step: PipelineStep,
  results: Map<string, unknown>,
  initialInput: string,
  options?: InvokeOptions,
): string {
  const sections: string[] = [];

  sections.push(`You are executing pipeline step "${step.name}".`);
  sections.push(`\n【Original Request】\n${initialInput}`);

  if (options?.context) {
    const ctx = options.context as Record<string, unknown>;
    const contextLines: string[] = [];
    if (ctx.conversationId) contextLines.push(`conversation_id: ${ctx.conversationId}`);
    if (options.userId) contextLines.push(`user_id: ${options.userId}`);
    if (options.sessionId) contextLines.push(`session_id: ${options.sessionId}`);
    if (contextLines.length > 0) {
      sections.push(`\n【Pipeline Context】\n${contextLines.join("\n")}`);
    }
  }

  if (step.dependsOn?.length) {
    sections.push(`\n【Context from Previous Steps】`);
    for (const depName of step.dependsOn) {
      const depResult = results.get(depName);
      if (depResult !== undefined) {
        const serialized = typeof depResult === "string"
          ? depResult
          : JSON.stringify(depResult, null, 2);
        sections.push(`\n--- ${depName} output ---\n${serialized.slice(0, 50_000)}`);
      }
    }
  }

  if (step.inputMapping) {
    sections.push(`\n【Mapped Inputs】`);
    for (const [key, path] of Object.entries(step.inputMapping)) {
      const value = getNestedValue(results, path);
      if (value !== undefined) {
        sections.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
      }
    }
  }

  return sections.join("\n");
}

// -------------------------------------------------------------------------
// Extract the usable output from an AgentInvokeResponse
// -------------------------------------------------------------------------

function extractOutput(result: unknown): unknown {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.taskResult && typeof r.taskResult === "object") {
      const tr = r.taskResult as Record<string, unknown>;
      if (tr.output !== undefined) return tr.output;
    }
    if (r.output !== undefined) return r.output;
  }
  return result;
}

// -------------------------------------------------------------------------
// PipelineExecutor
// -------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const globalHandlers = new Map<string, PipelineHandler>();

export function registerPipelineHandler(name: string, handler: PipelineHandler): void {
  globalHandlers.set(name, handler);
  logger.info(`[Pipeline] Handler registered: ${name}`);
}

export class PipelineExecutor {
  private runtime: { invokeAgent: (name: string, input: string, opts: InvokeOptions) => Promise<unknown> };

  constructor(runtime: { invokeAgent: (name: string, input: string, opts: InvokeOptions) => Promise<unknown> }) {
    this.runtime = runtime;
  }

  async execute(
    agentDef: AgentDefinition,
    initialInput: string,
    options: InvokeOptions,
  ): Promise<PipelineResult> {
    const pipeline = agentDef.config.pipeline!;
    const threadId = options.threadId ?? randomUUID();
    const tenantId = options.tenantId;
    const userId = options.userId ?? "default";
    const sessionId = options.sessionId;
    const start = Date.now();

    if (sessionId) {
      await workspaceManager.ensureExists(tenantId, userId, sessionId);
      eventBus.emitAgentStarted(agentDef.name, sessionId);
    }

    logger.info(`[Pipeline] Starting pipeline for ${agentDef.name} with ${pipeline.steps.length} steps`);

    const batches = topologicalSort(pipeline.steps);
    const results = new Map<string, unknown>();
    const stepMeta: Record<string, { success: boolean; result: unknown; duration: number }> = {};

    for (const batch of batches) {
      logger.info(`[Pipeline] Executing batch: [${batch.map((s) => s.name).join(", ")}]`);

      await Promise.all(batch.map(async (step) => {
        const stepStart = Date.now();
        const maxAttempts = step.retry?.maxAttempts ?? 1;
        const backoffMs = step.retry?.backoffMs ?? 2000;
        let lastError: string | undefined;

        if (sessionId) {
          eventBus.emit({
            type: "progress",
            sourceAgent: agentDef.name,
            sessionId,
            data: {
              message: `Step "${step.name}" started`,
              phase: step.name,
              stage: "step_started",
              parallel: !!step.parallel,
              fanOutFrom: step.fanOutFrom,
            },
            timestamp: new Date().toISOString(),
          });
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            if (step.parallel && step.fanOutFrom) {
              await this.executeFanOut(step, results, initialInput, options, threadId);
            } else {
              await this.executeSingle(step, results, initialInput, options);
            }

            stepMeta[step.name] = {
              success: true,
              result: results.get(step.name),
              duration: Date.now() - stepStart,
            };

            if (sessionId) {
              eventBus.emit({
                type: "progress",
                sourceAgent: agentDef.name,
                sessionId,
                data: {
                  message: `Step "${step.name}" completed`,
                  phase: step.name,
                  stage: "step_finished",
                  durationMs: Date.now() - stepStart,
                },
                timestamp: new Date().toISOString(),
              });
            }

            lastError = undefined;
            break;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);

            if (attempt < maxAttempts) {
              const waitMs = backoffMs * attempt;
              logger.warn(
                `[Pipeline] Step "${step.name}" attempt ${attempt}/${maxAttempts} failed: ${lastError}. Retrying in ${waitMs}ms...`,
              );
              await sleep(waitMs);
              continue;
            }
          }
        }

        if (lastError) {
          logger.error(`[Pipeline] Step "${step.name}" failed after ${maxAttempts} attempt(s): ${lastError}`);

          stepMeta[step.name] = {
            success: false,
            result: { error: lastError },
            duration: Date.now() - stepStart,
          };

          if (step.optional) {
            logger.warn(`[Pipeline] Step "${step.name}" is optional, continuing pipeline`);
            results.set(step.name, null);
          } else {
            throw new Error(`Pipeline step "${step.name}" failed: ${lastError}`);
          }
        }
      }));
    }

    // Produce final output from the last step
    const lastStep = pipeline.steps[pipeline.steps.length - 1]!;
    const finalOutput = results.get(lastStep.name);
    const outputStr = typeof finalOutput === "string"
      ? finalOutput
      : JSON.stringify(finalOutput, null, 2);

    const pipelineResult: PipelineResult = {
      threadId,
      output: outputStr,
      steps: stepMeta,
      taskResult: {
        success: Object.values(stepMeta).every((s) => s.success),
        output: finalOutput,
        duration: Date.now() - start,
        toolCalls: [],
        subAgentResults: [],
      },
    };

    if (sessionId) {
      eventBus.emitTaskComplete(agentDef.name, sessionId, {
        output: outputStr.slice(0, 500),
        steps: Object.keys(stepMeta),
      });
    }

    logger.info(`[Pipeline] Completed for ${agentDef.name} in ${Date.now() - start}ms`);
    return pipelineResult;
  }

  async executeSingle(
    step: PipelineStep,
    results: Map<string, unknown>,
    initialInput: string,
    options: InvokeOptions,
  ): Promise<void> {
    if (step.handler) {
      const handler = globalHandlers.get(step.handler);
      if (!handler) {
        throw new Error(`Pipeline handler "${step.handler}" not registered`);
      }
      const ctx = options.context as Record<string, unknown> | undefined;
      logger.info(`[Pipeline] Running handler "${step.handler}" for step "${step.name}"`);
      const result = await handler({
        stepName: step.name,
        initialInput,
        previousResults: results,
        tenantId: options.tenantId,
        userId: options.userId ?? "default",
        sessionId: options.sessionId,
        conversationId: (ctx?.conversationId as string) ?? options.sessionId,
        context: ctx,
      });
      results.set(step.name, result);
      return;
    }

    if (!step.agent) {
      throw new Error(`Pipeline step "${step.name}" must have either "agent" or "handler"`);
    }

    const instruction = buildStepInstruction(step, results, initialInput, options);
    logger.info(`[Pipeline] Invoking agent "${step.agent}" for step "${step.name}"`);
    const result = await this.runtime.invokeAgent(step.agent, instruction, options);
    results.set(step.name, extractOutput(result));
  }

  private async executeFanOut(
    step: PipelineStep,
    results: Map<string, unknown>,
    initialInput: string,
    options: InvokeOptions,
    parentId: string,
  ): Promise<void> {
    const items = getNestedValue(results, step.fanOutFrom!) as unknown[];

    if (!Array.isArray(items)) {
      throw new Error(
        `Pipeline fan-out: "${step.fanOutFrom}" did not resolve to an array ` +
        `(got ${typeof items}). Ensure the upstream step outputs an array at this path.`,
      );
    }

    if (!step.agent) {
      throw new Error(`Pipeline fan-out step "${step.name}" requires an "agent" field`);
    }

    logger.info(`[Pipeline] Fan-out step "${step.name}": ${items.length} parallel invocations of "${step.agent}"`);

    if (options.sessionId) {
      eventBus.emit({
        type: "progress",
        sourceAgent: step.agent,
        sessionId: options.sessionId,
        data: {
          message: `Fan-out "${step.name}": dispatching ${items.length} parallel agents`,
          phase: step.name,
          stage: "fanout_started",
          count: items.length,
        },
        timestamp: new Date().toISOString(),
      });
    }

    const fanOutAgent = step.agent;
    const fanOutStart = Date.now();
    const subResults = await subAgentManager.spawnParallel(
      items.map((item, index) => ({
        parentId,
        agentName: fanOutAgent,
        instruction: buildStepInstruction(
          { ...step, dependsOn: undefined },
          new Map([["_item", item], ["_index", index]]),
          typeof item === "string" ? item : JSON.stringify(item, null, 2),
        ),
        tenantId: options.tenantId,
        sessionId: options.sessionId,
      })),
    );

    if (options.sessionId) {
      const successCount = subResults.filter((r) => r.success).length;
      eventBus.emit({
        type: "progress",
        sourceAgent: step.agent,
        sessionId: options.sessionId,
        data: {
          message: `Fan-out "${step.name}": ${successCount}/${items.length} succeeded`,
          phase: step.name,
          stage: "fanout_finished",
          count: items.length,
          successCount,
          durationMs: Date.now() - fanOutStart,
        },
        timestamp: new Date().toISOString(),
      });
    }

    const outputs = subResults.map((r) => {
      if (r.success) return extractOutput(r.result);
      if (step.optional) return null;
      throw new Error(`Fan-out sub-agent "${r.agentName}" failed for item`);
    });

    results.set(step.name, outputs);
  }
}
