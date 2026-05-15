import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { SpawnSubAgentOptions, SubAgentResult, AgentDefinition, StreamEvent, StreamEventTypeName } from "./types.js";
import {
  createAgentStarted,
  createAgentMessage,
  createAgentToolStarted,
  createAgentToolFinished,
  createAgentFinished,
  type StreamContext,
} from "./stream-protocol.js";
import type { SubAgentEventCallback } from "./agent-graph.js";
import { parseAgentOutput } from "./output-parser.js";
import { eventBus } from "./event-bus.js";
import { logger } from "../utils/logger.js";

type AgentInvoker = (
  agentName: string,
  input: string,
  options?: { threadId?: string; sessionId?: string; context?: Record<string, unknown>; tenantId?: string; userId?: string; abortSignal?: AbortSignal },
) => Promise<unknown>;

type StreamAgentInvoker = (
  agentName: string,
  input: string,
  options?: { threadId?: string; sessionId?: string; context?: Record<string, unknown>; tenantId?: string; userId?: string; streamThinkTokens?: boolean; abortSignal?: AbortSignal },
) => AsyncGenerator<StreamEvent<StreamEventTypeName>>;

type AgentDefResolver = (name: string) => AgentDefinition | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class SubAgentManager {
  private invoker: AgentInvoker | null = null;
  private streamInvoker: StreamAgentInvoker | null = null;
  private agentDefResolver: AgentDefResolver | null = null;
  private pendingResults = new Map<string, SubAgentResult[]>();

  setInvoker(invoker: AgentInvoker): void {
    this.invoker = invoker;
  }

  setStreamInvoker(invoker: StreamAgentInvoker): void {
    this.streamInvoker = invoker;
  }

  setAgentDefResolver(resolver: AgentDefResolver): void {
    this.agentDefResolver = resolver;
  }

  /**
   * Spawn a sub-agent with streaming event forwarding.
   * Iterates through the child's streamAgentV2, converts events to agent_* events,
   * and pushes them via the eventCallback to the parent's event queue.
   */
  async spawnStreaming(
    options: SpawnSubAgentOptions,
    parentCtx: StreamContext,
    eventCallback: SubAgentEventCallback,
  ): Promise<SubAgentResult> {
    if (!this.streamInvoker) {
      logger.warn("[SubAgentManager] streamInvoker not set, falling back to blocking spawn");
      return this.spawn(options);
    }

    const agentDef = this.agentDefResolver?.(options.agentName);
    const maxAttempts = agentDef?.config.retry?.maxAttempts ?? 1;
    const backoffMs = agentDef?.config.retry?.backoffMs ?? 2000;

    const childTaskId = `task_${randomUUID().slice(0, 8)}`;
    const start = Date.now();
    const sessionId = options.sessionId ?? "";

    logger.info(`Spawning sub-agent (streaming): ${options.agentName} (childTask=${childTaskId} parent=${options.parentId} session=${sessionId})`);

    eventCallback(createAgentStarted(parentCtx, {
      childTaskId,
      agentName: options.agentName,
      instruction: options.instruction.slice(0, 500),
      metadata: options.metadata,
    }));

    let lastError: string | undefined;
    let finalOutput: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const timeoutMs = options.timeout ?? agentDef?.config.timeout ?? 300_000;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; }, timeoutMs);

        try {
          const stream = this.streamInvoker(options.agentName, options.instruction, {
            sessionId: options.sessionId,
            context: options.context,
            tenantId: options.tenantId,
            userId: options.userId,
            abortSignal: options.abortSignal,
          });

          for await (const event of stream) {
            if (timedOut) break;
            this.forwardChildEvent(event, parentCtx, childTaskId, options.agentName, eventCallback);

            if (event.event === "task_finished") {
              const data = event.data as { output?: string; status?: string; error?: string };
              if (data.status === "failed") {
                lastError = data.error;
              } else {
                finalOutput = data.output;
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }

        if (timedOut) {
          throw new Error(`Sub-agent ${options.agentName} timed out after ${timeoutMs}ms`);
        }

        if (lastError && attempt < maxAttempts) {
          const waitMs = backoffMs * attempt;
          logger.warn(`Sub-agent ${options.agentName} attempt ${attempt}/${maxAttempts} failed: ${lastError}. Retrying in ${waitMs}ms...`);
          lastError = undefined;
          await sleep(waitMs);
          continue;
        }

        if (lastError) break;

        let parsedResult: unknown = finalOutput;
        if (agentDef?.config.outputFormat && finalOutput) {
          const { parsed, warnings } = parseAgentOutput(finalOutput, agentDef.config.outputFormat);
          if (warnings.length > 0) {
            logger.warn(`[${options.agentName}] Sub-agent output parsing warnings: ${warnings.join("; ")}`);
          }
          parsedResult = parsed;
        }

        const elapsed = (Date.now() - start) / 1000;
        const subResult: SubAgentResult = {
          agentName: options.agentName, taskId: childTaskId, instruction: options.instruction,
          result: parsedResult, success: true, duration: Date.now() - start,
        };

        eventCallback(createAgentFinished(parentCtx, {
          childTaskId, agentName: options.agentName,
          status: "succeeded", output: parsedResult, elapsedTime: elapsed,
        }));

        this.recordResult(options.parentId, subResult);
        logger.info(`Sub-agent completed (streaming): ${options.agentName} childTask=${childTaskId} (${subResult.duration}ms)`);
        return subResult;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
          const waitMs = backoffMs * attempt;
          logger.warn(`Sub-agent ${options.agentName} attempt ${attempt}/${maxAttempts} failed: ${lastError}. Retrying in ${waitMs}ms...`);
          await sleep(waitMs);
          continue;
        }
      }
    }

    const elapsed = (Date.now() - start) / 1000;
    const error = lastError ?? "Unknown sub-agent error";
    const subResult: SubAgentResult = {
      agentName: options.agentName, taskId: childTaskId, instruction: options.instruction,
      result: { error }, success: false, error, duration: Date.now() - start,
    };

    eventCallback(createAgentFinished(parentCtx, {
      childTaskId, agentName: options.agentName,
      status: "failed", error, elapsedTime: elapsed,
    }));

    this.recordResult(options.parentId, subResult);
    logger.error(`Sub-agent failed (streaming) after ${maxAttempts} attempt(s): ${options.agentName} - ${lastError}`);
    return subResult;
  }

  /**
   * Convert a child StreamEvent into an agent_* event on the parent stream.
   */
  private forwardChildEvent(
    event: StreamEvent<StreamEventTypeName>,
    parentCtx: StreamContext,
    childTaskId: string,
    agentName: string,
    cb: SubAgentEventCallback,
  ): void {
    switch (event.event) {
      case "message": {
        const data = event.data as { delta?: string };
        if (data.delta) {
          cb(createAgentMessage(parentCtx, childTaskId, agentName, data.delta));
        }
        break;
      }
      case "tool_started": {
        const data = event.data as { tool_call_id: string; tool_name: string; arguments: Record<string, unknown> };
        cb(createAgentToolStarted(parentCtx, {
          childTaskId, agentName,
          toolCallId: data.tool_call_id,
          toolName: data.tool_name,
          arguments: data.arguments,
        }));
        break;
      }
      case "tool_finished": {
        const data = event.data as { tool_call_id: string; tool_name: string; status: "succeeded" | "failed"; output?: unknown; error?: string; elapsed_time: number };
        cb(createAgentToolFinished(parentCtx, {
          childTaskId, agentName,
          toolCallId: data.tool_call_id,
          toolName: data.tool_name,
          status: data.status,
          output: data.output,
          error: data.error,
          elapsedTime: data.elapsed_time,
        }));
        break;
      }
      case "node_started":
      case "node_finished":
      case "thinking":
      case "progress": {
        const enriched = {
          ...event,
          data: { ...(event.data as Record<string, unknown>), _childTaskId: childTaskId },
        };
        cb(enriched as unknown as StreamEvent<StreamEventTypeName>);
        break;
      }
      // task_started, task_finished, done → not forwarded
      // (agent_started / agent_finished are emitted separately by spawnStreaming)
    }
  }

  async spawn(options: SpawnSubAgentOptions): Promise<SubAgentResult> {
    if (!this.invoker) {
      throw new Error("SubAgentManager invoker not set. Call setInvoker() first.");
    }

    const agentDef = this.agentDefResolver?.(options.agentName);
    const maxAttempts = agentDef?.config.retry?.maxAttempts ?? 1;
    const backoffMs = agentDef?.config.retry?.backoffMs ?? 2000;

    const taskId = randomUUID();
    const start = Date.now();
    const sessionId = options.sessionId ?? "";

    logger.info(`Spawning sub-agent: ${options.agentName} (parent=${options.parentId} tenant=${options.tenantId} session=${sessionId} maxAttempts=${maxAttempts})`);

    if (sessionId) eventBus.emitAgentStarted(options.agentName, sessionId);

    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const timeoutMs = options.timeout ?? agentDef?.config.timeout ?? 300_000;
        const result = await Promise.race([
          this.invoker(options.agentName, options.instruction, {
            sessionId: options.sessionId,
            context: options.context,
            tenantId: options.tenantId,
            userId: options.userId,
            abortSignal: options.abortSignal,
          }),
          new Promise<never>((_, reject) => {
            options.abortSignal?.addEventListener("abort", () => reject(new Error("Run cancelled")), { once: true });
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Sub-agent ${options.agentName} timed out after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);

        // Apply output format parsing if the target agent declares one
        let parsedResult = result;
        if (agentDef?.config.outputFormat) {
          const rawOutput = this.extractRawOutput(result);
          const { parsed, warnings } = parseAgentOutput(rawOutput, agentDef.config.outputFormat);
          if (warnings.length > 0) {
            logger.warn(`[${options.agentName}] Sub-agent output parsing warnings: ${warnings.join("; ")}`);
          }
          parsedResult = parsed;
        }

        const subResult: SubAgentResult = {
          agentName: options.agentName, taskId, instruction: options.instruction,
          result: parsedResult, success: true, duration: Date.now() - start,
        };

        this.recordResult(options.parentId, subResult);
        if (sessionId) eventBus.emitTaskComplete(options.agentName, sessionId, { taskId, duration: subResult.duration });

        logger.info(`Sub-agent completed: ${options.agentName} (${subResult.duration}ms, attempt ${attempt}/${maxAttempts})`);
        return subResult;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        if (attempt < maxAttempts) {
          const waitMs = backoffMs * attempt;
          logger.warn(`Sub-agent ${options.agentName} attempt ${attempt}/${maxAttempts} failed: ${lastError}. Retrying in ${waitMs}ms...`);
          await sleep(waitMs);
          continue;
        }
      }
    }

    // All attempts exhausted
    const error = lastError ?? "Unknown sub-agent error";
    const subResult: SubAgentResult = {
      agentName: options.agentName, taskId, instruction: options.instruction,
      result: { error }, success: false, error, duration: Date.now() - start,
    };

    this.recordResult(options.parentId, subResult);
    if (sessionId) eventBus.emitTaskFailed(options.agentName, sessionId, error);

    logger.error(`Sub-agent failed after ${maxAttempts} attempt(s): ${options.agentName} - ${lastError}`);
    return subResult;
  }

  private extractRawOutput(result: unknown): string {
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (typeof r.output === "string") return r.output;
    }
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  async spawnParallel(
    optionsList: SpawnSubAgentOptions[],
    parentCtx?: StreamContext,
    eventCallback?: SubAgentEventCallback,
  ): Promise<SubAgentResult[]> {
    logger.info(`Spawning ${optionsList.length} sub-agents in parallel`);

    if (parentCtx && eventCallback && this.streamInvoker) {
      return Promise.all(optionsList.map((opts) => this.spawnStreaming(opts, parentCtx, eventCallback)));
    }
    return Promise.all(optionsList.map((opts) => this.spawn(opts)));
  }

  private recordResult(parentId: string, result: SubAgentResult): void {
    const existing = this.pendingResults.get(parentId) ?? [];
    existing.push(result);
    this.pendingResults.set(parentId, existing);
  }

  getResults(parentId: string): SubAgentResult[] {
    return this.pendingResults.get(parentId) ?? [];
  }

  clearResults(parentId: string): void {
    this.pendingResults.delete(parentId);
  }

  createSubAgentTool(
    parentId: string,
    tenantId: string,
    userId?: string,
    sessionId?: string,
    parentCtx?: StreamContext,
    eventCallback?: SubAgentEventCallback,
    abortSignal?: AbortSignal,
  ): StructuredToolInterface {
    const manager = this;

    return tool(
      async ({ agentName, instruction, model, context, parallel }) => {
        try {
          const opts: SpawnSubAgentOptions = {
            parentId, agentName, instruction, model, sessionId, tenantId, userId,
            abortSignal,
            context: context as Record<string, unknown> | undefined,
            onComplete: parallel ? "silent" : "aggregate",
          };

          const result = parentCtx && eventCallback && manager.streamInvoker
            ? await manager.spawnStreaming(opts, parentCtx, eventCallback)
            : await manager.spawn(opts);

          return JSON.stringify({
            success: result.success, taskId: result.taskId,
            agentName: result.agentName, result: result.result, error: result.error, duration: result.duration,
          });
        } catch (err) {
          return JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
      {
        name: "spawn_sub_agent",
        description: "Spawn a sub-agent to handle a specific task. Sub-agent shares the same workspace and tenant isolation.",
        schema: z.object({
          agentName: z.string().describe("Name of the agent to spawn"),
          instruction: z.string().describe("Task instruction for the sub-agent"),
          model: z.string().optional().describe("Override LLM model"),
          context: z.record(z.unknown()).optional().describe("Structured context data"),
          parallel: z.boolean().optional().describe("If true, don't wait for completion"),
        }),
      },
    );
  }
}

export const subAgentManager = new SubAgentManager();
