import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { randomUUID } from "node:crypto";
import type { AgentDefinition, AgentInvokeResponse, TaskResult, AgentStreamEvent, StreamEvent, StreamEventTypeName } from "./types.js";
import { buildAgentGraph, buildSystemPrompt, type AgentGraphState, type ToolEventCallback } from "./agent-graph.js";
import { WorkflowEngine } from "./workflow-engine.js";
import {
  createStreamContext,
  createTaskStarted,
  createTaskFinished,
  createDone,
  createNodeStarted,
  createNodeFinished,
  createToolStarted,
  createToolFinished,
  createError,
  createMessage,
  createProgress,
  type StreamContext,
} from "./stream-protocol.js";
import { parseAgentOutput } from "./output-parser.js";
import { getModelForAgent } from "../llm/model-router.js";
import { toolRegistry } from "../tools/tool-registry.js";
import { subAgentManager } from "./sub-agent-manager.js";
import { taskExecutor } from "./task-executor.js";
import { MemoryManager } from "../memory/memory-manager.js";
import { SkillCrystallizer } from "../evolution/skill-crystallizer.js";
import { workspaceManager } from "./workspace.js";
import { eventBus } from "./event-bus.js";
import { createSpawnParallelTool } from "../tools/built-in/spawn-parallel.js";
import { createWorkspaceWriteTool, createWorkspaceReadTool, createWorkspaceListTool } from "../tools/built-in/workspace.js";
import { createEventEmitTool } from "../tools/built-in/event-emit.js";
import { createImageGenerateTool } from "../tools/built-in/image-generate.js";
import { createImageLibraryTool } from "../tools/built-in/image-library.js";
import { dynamicToolRegistry } from "../tools/dynamic-tool-registry.js";
import { logger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { WorkspaceTraceCallbackHandler } from "./callbacks/workspace-trace.js";

export interface InvokeOptions {
  threadId?: string;
  sessionId?: string;
  context?: Record<string, unknown>;
  tenantId: string;
  userId?: string;
  /** If true, skip the pipeline even if the agent has pipeline config — use LLM mode instead */
  skipPipeline?: boolean;
  /** Override agent's streamMode for think tokens. When true, think tokens are emitted as message events (typewriter). */
  streamThinkTokens?: boolean;
}

function createCheckpointer() {
  const config = getConfig();
  if (config.memory.store === "postgres") {
    logger.warn("PostgreSQL checkpointer not yet installed. Using MemorySaver. Install @langchain/langgraph-checkpoint-postgres for production.");
  }
  return new MemorySaver();
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item: any) => item?.type === "text" && typeof item?.text === "string")
      .map((item: any) => item.text)
      .join("");
  }
  return "";
}

export class AgentRuntime {
  private checkpointer = createCheckpointer();
  private memoryManager: MemoryManager;
  private skillCrystallizer: SkillCrystallizer;

  constructor() {
    const defaults = getConfig().agents.defaults;
    const model = getModelForAgent({
      model: defaults.workerModel ?? defaults.model,
      maxConcurrency: 5,
      allowedTools: [],
      heartbeat: { enabled: false, intervalMs: 0 },
      evolution: { enabled: false, requireApproval: false },
      timeout: 60_000,
    });
    this.memoryManager = new MemoryManager(model);
    this.skillCrystallizer = new SkillCrystallizer(model);

    subAgentManager.setInvoker(
      (agentName, input, opts) => this.invokeAgent(agentName, input, {
        tenantId: opts?.tenantId ?? "default",
        userId: opts?.userId,
        sessionId: opts?.sessionId,
        context: opts?.context,
      }),
    );

    subAgentManager.setStreamInvoker(
      (agentName, input, opts) => this.streamAgentV2(agentName, input, {
        tenantId: opts?.tenantId ?? "default",
        userId: opts?.userId,
        sessionId: opts?.sessionId,
        context: opts?.context,
      }),
    );

    // Registry reference is cached after first resolution to avoid circular import
    let registryCache: typeof import("./agent-registry.js") | null = null;
    subAgentManager.setAgentDefResolver((name) => {
      if (!registryCache) return undefined;
      return registryCache.agentRegistry.get(name);
    });
    import("./agent-registry.js").then((mod) => { registryCache = mod; });
  }

  private getToolsForAgent(
    agentDef: AgentDefinition,
    threadId: string,
    tenantId: string,
    userId: string,
    sessionId?: string,
    context?: Record<string, unknown>,
    streamCtx?: StreamContext,
    subAgentEventCb?: import("./agent-graph.js").SubAgentEventCallback,
  ): StructuredToolInterface[] {
    const allowedTools = agentDef.config.allowedTools;
    let baseTools = toolRegistry.getByNames(allowedTools);

    // When smart_search is false, exclude http_request for document-generation
    const businessInput = context?.businessInput as { smart_search?: boolean } | undefined;
    if (businessInput?.smart_search === false) {
      baseTools = baseTools.filter((t) => t.name !== "http_request");
    }

    // Allow skipping knowledge base if instructed by context
    if (context?.disableKnowledge) {
      baseTools = baseTools.filter((t) => t.name !== "knowledge_search" && t.name !== "knowledge_list");
      logger.info(`[AgentRuntime] Disabled knowledge tools for agent ${agentDef.name} due to context override`);
    }

    // web_search kept in baseTools; only session-specific tools filtered (workspace_*, emit_event)
    const dynamicToolNames = new Set([
      "spawn_sub_agent", "spawn_parallel_agents",
      "workspace_write", "workspace_read", "workspace_list",
      "emit_event", "image_generate", "image_library",
    ]);
    const filtered = baseTools.filter((t) => !dynamicToolNames.has(t.name));

    filtered.push(subAgentManager.createSubAgentTool(threadId, tenantId, userId, sessionId, streamCtx, subAgentEventCb));
    filtered.push(createSpawnParallelTool(threadId, tenantId, userId, sessionId, streamCtx, subAgentEventCb));

    if (allowedTools.includes("image_generate") || allowedTools.includes("*")) {
      filtered.push(createImageGenerateTool(tenantId, userId, sessionId));
    }

    if (allowedTools.includes("image_library") || allowedTools.includes("*")) {
      filtered.push(createImageLibraryTool(tenantId, userId, sessionId));
    }

    if (sessionId) {
      filtered.push(createWorkspaceWriteTool(tenantId, userId, sessionId, agentDef.name));
      filtered.push(createWorkspaceReadTool(tenantId, userId, sessionId));
      filtered.push(createWorkspaceListTool(tenantId, userId, sessionId));
      filtered.push(createEventEmitTool(sessionId, agentDef.name));

      filtered.push(...dynamicToolRegistry.createTools(allowedTools, tenantId, userId, sessionId));
    }

    return filtered;
  }

  private buildGraph(
    agentDef: AgentDefinition,
    threadId: string,
    tenantId: string,
    userId: string,
    sessionId?: string,
    context?: Record<string, unknown>,
    toolEventCb?: ToolEventCallback,
    streamCtx?: StreamContext,
  ) {
    const model = getModelForAgent(agentDef.config);
    const subAgentEventCb = toolEventCb?.onEvent;
    const tools = this.getToolsForAgent(agentDef, threadId, tenantId, userId, sessionId, context, streamCtx, subAgentEventCb);

    let graph;
    if (agentDef.workflow?.graph || agentDef.workflow?.modes) {
      logger.info(`[buildGraph] Using WorkflowEngine for agent ${agentDef.name}`);
      graph = WorkflowEngine.build(agentDef, agentDef.workflow, model, tools, toolEventCb);
    } else {
      graph = buildAgentGraph(agentDef, model, tools, toolEventCb);
    }
    return graph.compile({ checkpointer: this.checkpointer });
  }

  async invokeAgent(
    agentName: string,
    input: string,
    options: InvokeOptions,
  ): Promise<unknown> {
    const { agentRegistry } = await import("./agent-registry.js");
    const agentDef = agentRegistry.get(agentName);
    if (!agentDef) throw new Error(`Agent not found: ${agentName}`);

    // Pipeline branch: deterministic multi-agent orchestration
    // Can be bypassed with skipPipeline for interactive/LLM-driven mode
    if (agentDef.config.pipeline && !options.skipPipeline) {
      const { PipelineExecutor } = await import("./pipeline-executor.js");
      const executor = new PipelineExecutor(this);
      return executor.execute(agentDef, input, options);
    }

    const tenantId = options.tenantId;
    const userId = options.userId ?? "default";
    const tid = options.threadId ?? randomUUID();
    const sessionId = options.sessionId;
    const context = options.context;

    if (sessionId) {
      await workspaceManager.ensureExists(tenantId, userId, sessionId);
      eventBus.emitAgentStarted(agentName, sessionId);
    }

    const compiled = this.buildGraph(agentDef, tid, tenantId, userId, sessionId, context);

    const longTermMemory = await this.memoryManager.loadLongTermMemory(tenantId, agentName);
    const taskContext = context ? JSON.stringify(context, null, 2) : undefined;
    const systemPrompt = buildSystemPrompt(agentDef, longTermMemory, taskContext, sessionId);

    logger.info(`Invoking agent: ${agentName} tenant=${tenantId} user=${userId} thread=${tid} session=${sessionId ?? "none"}`);

    const traceHandler = sessionId ? new WorkspaceTraceCallbackHandler(tenantId, userId, sessionId, agentName) : undefined;

    const result = await compiled.invoke(
      {
        messages: [new HumanMessage(input)],
        agentName,
        tenantId,
        sessionId: sessionId ?? "",
        taskContext: taskContext ?? "",
        systemPrompt,
        longTermMemory,
      } as Record<string, unknown>,
      { 
        configurable: { thread_id: tid },
        recursionLimit: agentDef.config.maxIterations ?? 50,
        callbacks: traceHandler ? [traceHandler] : undefined,
      },
    );

    if (traceHandler) {
      await traceHandler.saveTrace();
    }

    await this.memoryManager.logDaily(tenantId, agentName, `Task completed. Input: ${input.slice(0, 200)}`);

    const state = result as AgentGraphState;

    if (state.reflections?.length > 0) {
      const lastReflection = state.reflections[state.reflections.length - 1]!;
      if (lastReflection.confidence >= 0.6 && lastReflection.lessonsLearned.length > 0) {
        const lessonText = lastReflection.lessonsLearned.map((l) => `- ${l}`).join("\n");
        await this.memoryManager.appendLesson(tenantId, agentName, lessonText);
      }
    }

    if (state.toolCalls?.length > 0) {
      this.skillCrystallizer.recordPattern(tenantId, agentName, state.toolCalls);
      try {
        const newSkill = await this.skillCrystallizer.trycrystallize(tenantId, agentDef);
        if (newSkill) {
          logger.info(`Skill crystallized for tenant=${tenantId} agent=${agentName}: ${newSkill.name}`);
        }
      } catch (err) {
        logger.warn(`Skill crystallization failed for ${agentName}: ${err}`);
      }
    }

    const lastAiMessage = [...state.messages].reverse().find((m) => m._getType() === "ai");
    const rawOutput = lastAiMessage
      ? typeof lastAiMessage.content === "string"
        ? lastAiMessage.content
        : JSON.stringify(lastAiMessage.content)
      : "No output generated.";

    // Apply output format parsing based on agent config
    const { parsed, warnings } = parseAgentOutput(rawOutput, agentDef.config.outputFormat);
    if (warnings.length > 0) {
      logger.warn(`[${agentName}] Output parsing warnings: ${warnings.join("; ")}`);
    }

    const output = typeof parsed === "string" ? parsed : JSON.stringify(parsed);

    const response: AgentInvokeResponse = {
      threadId: tid,
      output,
      taskResult: {
        success: state.done,
        output: parsed,
        duration: 0,
        toolCalls: state.toolCalls ?? [],
        subAgentResults: state.subAgentResults ?? [],
      },
    };

    if (sessionId) {
      eventBus.emitTaskComplete(agentName, sessionId, { output: output.slice(0, 500) });

      try {
        await workspaceManager.writeArtifact(
          tenantId,
          userId,
          sessionId,
          "logs/execution.json",
          JSON.stringify(response, null, 2)
        );
        await workspaceManager.writeArtifact(
          tenantId,
          userId,
          sessionId,
          `logs/${agentName}-raw-output.txt`,
          rawOutput,
        );
      } catch (err) {
        logger.error(`Failed to persist execution logs for session ${sessionId}: ${err}`);
      }
    }

    return response;
  }

  async invokeAgentAsync(
    agentName: string,
    input: string,
    options: InvokeOptions & { webhookUrl?: string },
  ): Promise<{ taskId: string; sessionId: string; status: string }> {
    const tenantId = options.tenantId;
    const userId = options.userId ?? "default";
    const sessionId = options.sessionId ?? await workspaceManager.create(tenantId, userId);

    const task = await taskExecutor.submit(
      agentName,
      input,
      async () => {
        const result = await this.invokeAgent(agentName, input, { ...options, sessionId });

        if (options.webhookUrl) {
          try {
            await fetch(options.webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ taskId: task.id, tenantId, sessionId, result }),
            });
          } catch (err) {
            logger.error(`Webhook delivery failed: ${err}`);
          }
        }

        return result;
      },
    );

    return { taskId: task.id, sessionId, status: "pending" };
  }

  /**
   * @deprecated Use streamAgentV2 for new protocol. Kept for backward compat during migration.
   */
  async *streamAgent(
    agentName: string,
    input: string,
    options: InvokeOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    const { agentRegistry } = await import("./agent-registry.js");
    const agentDef = agentRegistry.get(agentName);
    if (!agentDef) throw new Error(`Agent not found: ${agentName}`);

    const tenantId = options.tenantId;
    const userId = options.userId ?? "default";
    const tid = options.threadId ?? randomUUID();
    const sessionId = options.sessionId;
    const context = options.context;

    if (sessionId) {
      await workspaceManager.ensureExists(tenantId, userId, sessionId);
    }

    const compiled = this.buildGraph(agentDef, tid, tenantId, userId, sessionId, context);

    const longTermMemory = await this.memoryManager.loadLongTermMemory(tenantId, agentName);
    const taskContext = context ? JSON.stringify(context, null, 2) : undefined;
    const systemPrompt = buildSystemPrompt(agentDef, longTermMemory, taskContext, sessionId);

    logger.info(`Streaming agent (legacy): ${agentName} tenant=${tenantId} user=${userId} thread=${tid} session=${sessionId ?? "none"}`);

    const traceHandler = sessionId ? new WorkspaceTraceCallbackHandler(tenantId, userId, sessionId, agentName) : undefined;

    const stream = await compiled.stream(
      {
        messages: [new HumanMessage(input)],
        agentName,
        tenantId,
        sessionId: sessionId ?? "",
        taskContext: taskContext ?? "",
        systemPrompt,
        longTermMemory,
      } as Record<string, unknown>,
      { 
        configurable: { thread_id: tid }, 
        recursionLimit: agentDef.config.maxIterations ?? 50,
        streamMode: "updates",
        callbacks: traceHandler ? [traceHandler] : undefined,
      },
    );

    const SPAWN_TOOL_NAMES = new Set(["spawn_sub_agent", "spawn_parallel_agents"]);

    for await (const event of stream) {
      for (const [nodeName, nodeOutput] of Object.entries(event)) {
        const output = nodeOutput as Partial<AgentGraphState>;

        if (nodeName === "perceive" || nodeName === "observe") {
          yield {
            type: "status",
            data: { node: nodeName, iteration: (output as any).iteration ?? 0 },
            timestamp: new Date().toISOString(),
          };
        }

        if (nodeName === "think" && output.messages) {
          for (const msg of output.messages) {
            if (msg._getType() === "ai") {
              const text = extractTextContent(msg.content);
              if (text) {
                yield { type: "token", data: { content: text, node: nodeName }, timestamp: new Date().toISOString() };
              }
            }
          }
        }

        if (nodeName === "act" && output.toolCalls) {
          for (const tc of output.toolCalls) {
            if (SPAWN_TOOL_NAMES.has(tc.toolName)) {
              yield { type: "sub_agent_spawn", data: tc, timestamp: new Date().toISOString() };
              if (tc.success) {
                yield { type: "sub_agent_complete", data: tc, timestamp: new Date().toISOString() };
              } else {
                yield { type: "error", data: tc, timestamp: new Date().toISOString() };
              }
            } else {
              yield { type: tc.success ? "tool_result" : "error", data: tc, timestamp: new Date().toISOString() };
            }
          }
        }

        if (nodeName === "reflect" && output.reflections) {
          for (const r of output.reflections) {
            yield { type: "reflection", data: r, timestamp: new Date().toISOString() };
          }
        }
      }
    }

    if (traceHandler) {
      await traceHandler.saveTrace();
    }

    yield { type: "done", data: { threadId: tid, sessionId }, timestamp: new Date().toISOString() };
  }

  /**
   * Stream agent with the new unified event protocol (v2).
   * Yields StreamEvent objects conforming to the SSE event protocol spec.
   *
   * Uses a concurrent event channel so that tool and sub-agent events
   * are yielded in real-time during act node execution (not batched).
   */
  async *streamAgentV2(
    agentName: string,
    input: string,
    options: InvokeOptions,
  ): AsyncGenerator<StreamEvent<StreamEventTypeName>> {
    const { agentRegistry } = await import("./agent-registry.js");
    const agentDef = agentRegistry.get(agentName);
    if (!agentDef) throw new Error(`Agent not found: ${agentName}`);

    if (agentDef.config.pipeline && !options.skipPipeline) {
      yield* this.streamPipeline(agentDef, input, options);
      return;
    }

    const tenantId = options.tenantId;
    const userId = options.userId ?? "default";
    const tid = options.threadId ?? randomUUID();
    const sessionId = options.sessionId ?? "";
    const context = options.context;

    const shouldStreamThink = options.streamThinkTokens
      ?? (agentDef.config.streamMode === "stream");

    const ctx = createStreamContext(sessionId);
    const nodeIdMap = agentDef.workflow?.nodeIdMap;
    const taskStart = Date.now();

    if (sessionId) {
      await workspaceManager.ensureExists(tenantId, userId, sessionId);
    }

    // --- Async event channel ---
    // Events pushed by tool/sub-agent callbacks are queued here and consumed
    // concurrently by the merged output stream below.
    type ChannelItem =
      | { kind: "tool_event"; event: StreamEvent<StreamEventTypeName> }
      | { kind: "graph_update"; nodeName: string; output: Partial<AgentGraphState> }
      | { kind: "message_token"; token: string; nodeName: string }
      | { kind: "end"; error?: string };

    const queue: ChannelItem[] = [];
    let resolve: (() => void) | null = null;

    function push(item: ChannelItem) {
      queue.push(item);
      if (resolve) { resolve(); resolve = null; }
    }

    function waitForItem(): Promise<void> {
      if (queue.length > 0) return Promise.resolve();
      return new Promise<void>((r) => { resolve = r; });
    }

    const toolEventCb: ToolEventCallback = {
      onToolStarted: (toolCallId, toolName, args) => {
        push({ kind: "tool_event", event: createToolStarted(ctx, toolCallId, toolName, args) });
      },
      onToolFinished: (toolCallId, toolName, status, output, error, elapsedTime) => {
        push({ kind: "tool_event", event: createToolFinished(ctx, { toolCallId, toolName, status, output, error, elapsedTime }) });
      },
      onEvent: (event) => {
        push({ kind: "tool_event", event });
      },
    };

    const compiled = this.buildGraph(agentDef, tid, tenantId, userId, sessionId || undefined, context, toolEventCb, ctx);

    const longTermMemory = await this.memoryManager.loadLongTermMemory(tenantId, agentName);
    const taskContext = context ? JSON.stringify(context, null, 2) : undefined;
    const systemPrompt = buildSystemPrompt(agentDef, longTermMemory, taskContext, sessionId || undefined);

    logger.info(`Streaming agent (v2): ${agentName} tenant=${tenantId} user=${userId} thread=${tid} session=${sessionId || "none"} task=${ctx.taskId}`);

    // --- task_started ---
    yield createTaskStarted(ctx, agentName, tid);

    const traceHandler = sessionId ? new WorkspaceTraceCallbackHandler(tenantId, userId, sessionId, agentName) : undefined;

    // --- Run LangGraph stream in background, pushing graph_update items ---
    const NODE_TYPES = new Set(["perceive", "think", "act", "observe", "reflect"]);

    const graphPromise = (async () => {
      try {
        const stream = await compiled.stream(
          {
            messages: [new HumanMessage(input)],
            agentName,
            tenantId,
            sessionId: sessionId ?? "",
            taskContext: taskContext ?? "",
            systemPrompt,
            longTermMemory,
          } as Record<string, unknown>,
          {
            configurable: { thread_id: tid },
            recursionLimit: agentDef.config.maxIterations ?? 50,
            streamMode: ["updates", "messages"],
            callbacks: traceHandler ? [traceHandler] : undefined,
          },
        );

        for await (const chunk of stream) {
          const [mode, data] = chunk as [string, any];

          if (mode === "updates") {
            for (const [nodeName, nodeOutput] of Object.entries(data)) {
              if (!NODE_TYPES.has(nodeName)) continue;
              push({ kind: "graph_update", nodeName, output: nodeOutput as Partial<AgentGraphState> });
            }
          } else if (mode === "messages") {
            const [messageChunk, metadata] = data as [any, any];
            const content = typeof messageChunk?.content === "string" ? messageChunk.content : "";
            if (content && metadata?.langgraph_node) {
              push({ kind: "message_token", token: content, nodeName: metadata.langgraph_node });
            }
          }
        }
        push({ kind: "end" });
      } catch (err) {
        push({ kind: "end", error: err instanceof Error ? err.message : String(err) });
      }
    })();

    // --- Consume merged channel ---
    let lastError: string | undefined;
    let currentIteration = 0;
    let lastNodeEndTime = Date.now();

    // Think token accumulation — always buffer for node_finished(think).output.
    // When shouldStreamThink is true, also emit message events for typewriter effect.
    let thinkTokenBuffer = "";
    let lastThinkOutput = "";

    // Act ordering — emit node_started(act) BEFORE the first tool event,
    // so that tool_call / tool_result are always between act_started and
    // act_finished in the stream.
    let actStarted = false;
    let actStartTime = Date.now();

    outer:
    while (true) {
      await waitForItem();

      while (queue.length > 0) {
        const item = queue.shift()!;

        if (item.kind === "end") {
          lastError = item.error;
          if (lastError) {
            logger.error(`[streamAgentV2] Error: ${lastError}`);
            yield createError(ctx, "AGENT_EXECUTION_FAILED", lastError, false);
          }
          break outer;
        }

        // --- Token accumulation for think ---
        if (item.kind === "message_token") {
          if (item.nodeName === "think") {
            thinkTokenBuffer += item.token;
            if (shouldStreamThink) {
              yield createMessage(ctx, item.token);
            }
          }
          continue;
        }

        // --- Tool / sub-agent events: ensure act_started comes first ---
        if (item.kind === "tool_event") {
          if (!actStarted) {
            actStarted = true;
            actStartTime = Date.now();
            yield createNodeStarted(ctx, "act", currentIteration, nodeIdMap?.get("act"));
          }
          yield item.event;
          continue;
        }

        // --- Node-level updates from graph (streamMode: "updates") ---
        const { nodeName, output } = item;
        const nodeType = nodeName as import("./types.js").NodeType;
        currentIteration = (output as any).iteration ?? currentIteration;
        const nodeStartTime = lastNodeEndTime;

        const resolvedNodeId = nodeIdMap?.get(nodeName);

        if (nodeName === "think") {
          let fullText = thinkTokenBuffer;
          if (!fullText && output.messages) {
            for (const msg of output.messages) {
              if (msg._getType() === "ai") {
                fullText += extractTextContent(msg.content);
              }
            }
          }

          if (fullText) lastThinkOutput = fullText;

          yield createNodeStarted(ctx, nodeType, currentIteration, resolvedNodeId);
          const now = Date.now();
          lastNodeEndTime = now;
          yield createNodeFinished(ctx, {
            nodeType,
            status: "succeeded",
            elapsedTime: (now - nodeStartTime) / 1000,
            iteration: currentIteration,
            output: fullText,
            nodeId: resolvedNodeId,
          });

          thinkTokenBuffer = "";

        } else if (nodeName === "act") {
          if (!actStarted) {
            yield createNodeStarted(ctx, nodeType, currentIteration, resolvedNodeId);
          }
          const now = Date.now();
          lastNodeEndTime = now;
          yield createNodeFinished(ctx, {
            nodeType,
            status: "succeeded",
            elapsedTime: (now - (actStarted ? actStartTime : nodeStartTime)) / 1000,
            iteration: currentIteration,
            nodeId: resolvedNodeId,
          });
          actStarted = false;

        } else if (nodeName === "reflect") {
          let reflectOutput: unknown = "";
          if (output.reflections?.length) {
            reflectOutput = output.reflections[output.reflections.length - 1];
          }

          yield createNodeStarted(ctx, nodeType, currentIteration, resolvedNodeId);
          const now = Date.now();
          lastNodeEndTime = now;
          yield createNodeFinished(ctx, {
            nodeType,
            status: "succeeded",
            elapsedTime: (now - nodeStartTime) / 1000,
            iteration: currentIteration,
            output: reflectOutput,
            nodeId: resolvedNodeId,
          });

        } else {
          yield createNodeStarted(ctx, nodeType, currentIteration, resolvedNodeId);
          const now = Date.now();
          lastNodeEndTime = now;
          yield createNodeFinished(ctx, {
            nodeType,
            status: "succeeded",
            elapsedTime: (now - nodeStartTime) / 1000,
            iteration: currentIteration,
            nodeId: resolvedNodeId,
          });
        }
      }
    }

    // Wait for graph promise to settle (should already be done)
    await graphPromise;

    if (traceHandler) {
      await traceHandler.saveTrace();
    }

    // --- task_finished ---
    const totalElapsed = (Date.now() - taskStart) / 1000;
    yield createTaskFinished(ctx, {
      status: lastError ? "failed" : "succeeded",
      output: lastThinkOutput || undefined,
      error: lastError,
      elapsedTime: totalElapsed,
    });

    // --- done ---
    yield createDone(ctx);
  }

  private async *streamPipeline(
    agentDef: AgentDefinition,
    initialInput: string,
    options: InvokeOptions,
  ): AsyncGenerator<StreamEvent<StreamEventTypeName>> {
    const { PipelineExecutor, topologicalSort } = await import("./pipeline-executor.js");
    const executor = new PipelineExecutor(this);
    const pipeline = agentDef.config.pipeline!;
    const threadId = options.threadId ?? randomUUID();
    const tenantId = options.tenantId;
    const userId = options.userId ?? "default";
    const sessionId = options.sessionId ?? "";

    const ctx = createStreamContext(sessionId);
    const taskStart = Date.now();

    if (sessionId) {
      await workspaceManager.ensureExists(tenantId, userId, sessionId);
    }

    logger.info(`[streamPipeline] Starting for ${agentDef.name}, ${pipeline.steps.length} steps`);

    yield createTaskStarted(ctx, agentDef.name, threadId);

    const batches = topologicalSort(pipeline.steps);
    const results = new Map<string, unknown>();
    let pipelineError: string | undefined;

    for (const batch of batches) {
      if (pipelineError) break;

      const batchPromises = batch.map(async (step) => {
        const stepStart = Date.now();
        const maxAttempts = step.retry?.maxAttempts ?? 1;
        const backoffMs = step.retry?.backoffMs ?? 2000;
        let lastError: string | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            if (step.parallel && step.fanOutFrom) {
              await executor.execute(agentDef, initialInput, options);
              break;
            }
            await executor.executeSingle(step, results, initialInput, options);
            lastError = undefined;
            break;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (attempt < maxAttempts) {
              await new Promise((r) => setTimeout(r, backoffMs * attempt));
            }
          }
        }

        return { step, lastError, duration: (Date.now() - stepStart) / 1000 };
      });

      const batchResults = await Promise.all(batchPromises);

      for (const { step, lastError, duration } of batchResults) {
        const nodeType = step.name as import("./types.js").NodeType;

        yield createNodeStarted(ctx, nodeType, 0, step.name);

        if (lastError) {
          yield createNodeFinished(ctx, {
            nodeType,
            status: "failed",
            elapsedTime: duration,
            iteration: 0,
            nodeId: step.name,
          });

          if (step.optional) {
            logger.warn(`[streamPipeline] Optional step "${step.name}" failed, continuing`);
            results.set(step.name, null);
          } else {
            pipelineError = `Pipeline step "${step.name}" failed: ${lastError}`;
            yield createError(ctx, "PIPELINE_STEP_FAILED", pipelineError, false);
            break;
          }
        } else {
          const stepOutput = results.get(step.name);
          yield createNodeFinished(ctx, {
            nodeType,
            status: "succeeded",
            elapsedTime: duration,
            iteration: 0,
            output: stepOutput,
            nodeId: step.name,
          });
        }

        yield createProgress(ctx, `Step "${step.name}" completed`, {
          phase: step.name,
          percentage: Math.round(
            ((Array.from(results.keys()).length) / pipeline.steps.length) * 100,
          ),
        });
      }
    }

    const totalElapsed = (Date.now() - taskStart) / 1000;
    const lastStep = pipeline.steps[pipeline.steps.length - 1]!;
    const finalOutput = results.get(lastStep.name);
    const outputStr = finalOutput != null
      ? (typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput, null, 2))
      : undefined;

    yield createTaskFinished(ctx, {
      status: pipelineError ? "failed" : "succeeded",
      output: outputStr,
      error: pipelineError,
      elapsedTime: totalElapsed,
    });

    yield createDone(ctx);
  }

  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }
}

export const agentRuntime = new AgentRuntime();
