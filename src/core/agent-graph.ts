import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { BaseMessage, HumanMessage, SystemMessage, AIMessage, AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  AgentDefinition,
  WorkingMemory,
  Reflection,
  TaskResult,
  ToolCallRecord,
  ToolLimitsConfig,
  SubAgentResult,
} from "./types.js";
import { summarizeWorkingMemory, addMemoryEntry, createWorkingMemory } from "../memory/short-term.js";
import { formatSkillsForPrompt } from "../skills/skill-loader.js";
import { logger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";

// ---------------------------------------------------------------------------
// State Annotation
// ---------------------------------------------------------------------------

function messagesReducer(current: BaseMessage[], update: BaseMessage[]): BaseMessage[] {
  const merged = [...current, ...update];
  const maxMessages = getConfig().memory.checkpoint?.maxMessages ?? 100;

  if (merged.length <= maxMessages) return merged;

  const systemMsgs = merged.filter((m) => m._getType() === "system");
  const nonSystem = merged.filter((m) => m._getType() !== "system");
  const trimmed = nonSystem.slice(-maxMessages);

  return systemMsgs.length > 0 ? [systemMsgs[0]!, ...trimmed] : trimmed;
}

function toolCallsReducer(current: ToolCallRecord[], update: ToolCallRecord[]): ToolCallRecord[] {
  return [...current, ...update];
}

function subAgentReducer(current: SubAgentResult[], update: SubAgentResult[]): SubAgentResult[] {
  return [...current, ...update];
}

function reflectionsReducer(current: Reflection[], update: Reflection[]): Reflection[] {
  return [...current, ...update];
}

const lastValueStr = (a: string, b: string) => b;
const lastValueNum = (a: number, b: number) => b;
const lastValueBool = (a: boolean, b: boolean) => b;
const lastValueMem = (_: WorkingMemory, b: WorkingMemory) => b;

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesReducer, default: () => [] }),
  agentName: Annotation<string>({ reducer: lastValueStr, default: () => "" }),
  tenantId: Annotation<string>({ reducer: lastValueStr, default: () => "" }),
  sessionId: Annotation<string>({ reducer: lastValueStr, default: () => "" }),
  taskContext: Annotation<string>({ reducer: lastValueStr, default: () => "" }),
  workingMemory: Annotation<WorkingMemory>({ reducer: lastValueMem, default: () => createWorkingMemory() }),
  longTermMemory: Annotation<string>({ reducer: lastValueStr, default: () => "" }),
  systemPrompt: Annotation<string>({ reducer: lastValueStr, default: () => "" }),
  toolCalls: Annotation<ToolCallRecord[]>({ reducer: toolCallsReducer, default: () => [] }),
  subAgentResults: Annotation<SubAgentResult[]>({ reducer: subAgentReducer, default: () => [] }),
  reflections: Annotation<Reflection[]>({ reducer: reflectionsReducer, default: () => [] }),
  iteration: Annotation<number>({ reducer: lastValueNum, default: () => 0 }),
  maxIterations: Annotation<number>({ reducer: lastValueNum, default: () => 20 }),
  done: Annotation<boolean>({ reducer: lastValueBool, default: () => false }),
  /** Tracks consecutive empty-response nudges to cap retries. */
  emptyResponseRetries: Annotation<number>({ reducer: lastValueNum, default: () => 0 }),
  /** When true, skip nudge even if no tools were called (e.g. conversational director). */
  disableNudge: Annotation<boolean>({ reducer: lastValueBool, default: () => false }),
});

export type AgentGraphState = typeof AgentState.State;

// ---------------------------------------------------------------------------
// System prompt assembly
// ---------------------------------------------------------------------------

const MAX_MEMORY_INJECT_CHARS = 40_000;

export function buildSystemPrompt(agentDef: AgentDefinition, longTermMemory: string, taskContext?: string, sessionId?: string): string {
  const sections: string[] = [];

  if (agentDef.prompts.identity) {
    sections.push(`# Identity\n${agentDef.prompts.identity}`);
  }
  if (agentDef.prompts.soul) {
    sections.push(`# Soul\n${agentDef.prompts.soul}`);
  }
  if (agentDef.prompts.mission) {
    sections.push(`# Mission\n${agentDef.prompts.mission}`);
  }
  if (agentDef.prompts.tools) {
    sections.push(`# Tool Usage Guidelines\n${agentDef.prompts.tools}`);
  }

  // Inject extra .md prompts
  for (const [key, value] of Object.entries(agentDef.prompts)) {
    if (["identity", "soul", "mission", "tools", "bootstrap", "heartbeat"].includes(key)) continue;
    if (value) sections.push(`# ${key.charAt(0).toUpperCase() + key.slice(1)}\n${value}`);
  }

  const skillsPrompt = formatSkillsForPrompt(agentDef.skills);
  if (skillsPrompt) sections.push(skillsPrompt);

  if (taskContext) {
    sections.push(`# Task Context\n${taskContext}`);
  }

  if (sessionId) {
    sections.push(`# Session\nYou are operating in shared workspace session: ${sessionId}\nUse workspace_write/workspace_read/workspace_list tools to share files with other agents in this session.`);
  }

  if (longTermMemory) {
    const trimmed = longTermMemory.length > MAX_MEMORY_INJECT_CHARS
      ? longTermMemory.slice(0, MAX_MEMORY_INJECT_CHARS) + "\n...(memory truncated)"
      : longTermMemory;
    sections.push(`# Long-term Memory\n${trimmed}`);
  }

  return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Graph Node Functions
// ---------------------------------------------------------------------------

export function createPerceiveNode(agentDef: AgentDefinition) {
  return async (state: AgentGraphState): Promise<Partial<AgentGraphState>> => {
    logger.info(`[${agentDef.name}] Perceive: processing input`);

    const memSummary = summarizeWorkingMemory(state.workingMemory);
    const updatedMemory = addMemoryEntry(state.workingMemory, {
      type: "observation",
      content: `Perceiving new input. Working memory items: ${state.workingMemory.shortTermLog.length}`,
    });

    return { workingMemory: updatedMemory };
  };
}

function bindToolsSafe(model: BaseChatModel, tools: StructuredToolInterface[]): BaseChatModel {
  if (tools.length === 0) return model;

  if (typeof model.bindTools === "function") {
    return model.bindTools(tools) as unknown as BaseChatModel;
  }

  // RunnableWithFallbacks loses bindTools — bind on each underlying model
  const wrapped = model as any;
  const inner = wrapped.runnable ?? wrapped.first;
  if (inner && typeof inner.bindTools === "function") {
    const boundPrimary = inner.bindTools(tools);
    const boundFallbacks = (wrapped.fallbacks ?? []).map((fb: any) => {
      const fbInner = fb.runnable ?? fb;
      return typeof fbInner.bindTools === "function" ? fbInner.bindTools(tools) : fb;
    });
    return boundPrimary.withFallbacks({ fallbacks: boundFallbacks }) as unknown as BaseChatModel;
  }

  logger.warn("Model does not support bindTools — tools will not be available to LLM");
  return model;
}

function ensureMessageInstances(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((msg) => {
    const isHuman = msg instanceof HumanMessage;
    const isAI = msg instanceof AIMessage || msg instanceof AIMessageChunk;
    const isSys = msg instanceof SystemMessage;
    const isTool = msg instanceof ToolMessage;

    if (isHuman || isAI || isSys || isTool) {
      return msg;
    }

    let type: string | undefined;
    try {
      if (typeof (msg as BaseMessage)._getType === "function") {
        type = (msg as BaseMessage)._getType();
      }
    } catch {
      // Fall through to serialized LangChain metadata.
    }

    if (!type) {
      const raw = msg as unknown as Record<string, unknown>;
      const lcId = (raw.lc_id ?? raw.id) as string[] | undefined;
      if (Array.isArray(lcId) && lcId.length > 0) {
        const cls = lcId[lcId.length - 1]!;
        if (cls.includes("Human")) type = "human";
        else if (cls.includes("AI")) type = "ai";
        else if (cls.includes("System")) type = "system";
        else if (cls.includes("Tool")) type = "tool";
      }
    }

    const base = {
      content: msg.content ?? "",
      additional_kwargs: msg.additional_kwargs ?? {},
      response_metadata: msg.response_metadata ?? {},
      id: msg.id,
      name: msg.name,
    };

    switch (type) {
      case "human":
        return new HumanMessage(base);
      case "ai": {
        const src = msg as AIMessage;
        return new AIMessage({
          ...base,
          tool_calls: src.tool_calls,
          usage_metadata: src.usage_metadata,
        });
      }
      case "system":
        return new SystemMessage(base);
      case "tool":
        return new ToolMessage({
          ...base,
          tool_call_id: (msg as ToolMessage).tool_call_id ?? "",
        });
      default:
        logger.warn(`[ensureMessageInstances] Unknown message type "${type}", wrapping as HumanMessage`);
        return new HumanMessage({
          content: typeof base.content === "string" ? base.content : JSON.stringify(base.content),
        });
    }
  });
}

export function createThinkNode(model: BaseChatModel, tools: StructuredToolInterface[]) {
  const modelWithTools = bindToolsSafe(model, tools);

  return async (state: AgentGraphState): Promise<Partial<AgentGraphState>> => {
    logger.info(`[${state.agentName}] Think: iteration ${state.iteration}`);

    const memSummary = summarizeWorkingMemory(state.workingMemory);
    const fullSystemPrompt = memSummary
      ? `${state.systemPrompt}\n\n## Working Memory\n${memSummary}`
      : state.systemPrompt;

    const messagesToSend: BaseMessage[] = [
      new SystemMessage(fullSystemPrompt),
      ...ensureMessageInstances(state.messages),
    ];

    const response = await modelWithTools.invoke(messagesToSend);
    return {
      messages: [response],
      iteration: state.iteration + 1,
    };
  };
}

export interface ToolEventCallback {
  onToolStarted?: (toolCallId: string, toolName: string, args: Record<string, unknown>) => void;
  onToolFinished?: (toolCallId: string, toolName: string, status: "succeeded" | "failed", output: unknown, error: string | undefined, elapsedTime: number) => void;
  /** Generic push for any StreamEvent (used by sub-agent forwarding) */
  onEvent?: (event: import("./types.js").StreamEvent<import("./types.js").StreamEventTypeName>) => void;
}

export type SubAgentEventCallback = (event: import("./types.js").StreamEvent<import("./types.js").StreamEventTypeName>) => void;

const WORKSPACE_PREFIXES = ["assets/", "artifacts/", "logs/"];

function normalizeWorkspacePath(name: unknown): string | undefined {
  if (typeof name !== "string" || name.trim().length === 0) return undefined;
  const trimmed = name.trim();
  return WORKSPACE_PREFIXES.some((p) => trimmed.startsWith(p)) ? trimmed : `assets/${trimmed}`;
}

function getGuardError(
  state: AgentGraphState,
  toolName: string,
  args: Record<string, unknown>,
  limits: ToolLimitsConfig | undefined,
  scheduledToolCounts: Map<string, number>,
  scheduledWriteCounts: Map<string, number>,
): string | undefined {
  if (!limits) return undefined;

  const scheduledTotal = Array.from(scheduledToolCounts.values()).reduce((sum, count) => sum + count, 0);
  if (limits.maxCalls !== undefined && state.toolCalls.length + scheduledTotal + 1 > limits.maxCalls) {
    return `Tool call budget exceeded: maxCalls=${limits.maxCalls}`;
  }

  const maxForTool = limits.maxCallsByName?.[toolName];
  if (maxForTool !== undefined) {
    const previousForTool = state.toolCalls.filter((tc) => tc.toolName === toolName).length;
    const scheduledForTool = scheduledToolCounts.get(toolName) ?? 0;
    if (previousForTool + scheduledForTool + 1 > maxForTool) {
      return `Tool call budget exceeded for ${toolName}: maxCallsByName=${maxForTool}`;
    }
  }

  const maxWritesPerPath = limits.workspaceWrite?.maxWritesPerPath;
  if (toolName === "workspace_write" && maxWritesPerPath !== undefined) {
    const targetPath = normalizeWorkspacePath(args.name);
    if (!targetPath) return "workspace_write requires a valid file name";

    const previousWrites = state.toolCalls.filter((tc) => {
      if (tc.toolName !== "workspace_write" || !tc.success) return false;
      const input = tc.input as Record<string, unknown> | undefined;
      return normalizeWorkspacePath(input?.name) === targetPath;
    }).length;
    const scheduledWrites = scheduledWriteCounts.get(targetPath) ?? 0;

    if (previousWrites + scheduledWrites + 1 > maxWritesPerPath) {
      return `Duplicate workspace_write blocked for ${targetPath}: maxWritesPerPath=${maxWritesPerPath}`;
    }
  }

  return undefined;
}

export function createActNode(tools: StructuredToolInterface[], toolEventCb?: ToolEventCallback, limits?: ToolLimitsConfig) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  async function executeWithRetry(
    t: StructuredToolInterface,
    args: Record<string, unknown>,
    maxRetries = 1,
  ): Promise<{ output: unknown; error?: string }> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const output = await t.invoke(args);
        return { output };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries) {
          const backoffMs = 1000 * Math.pow(2, attempt);
          logger.warn(`Tool "${t.name}" failed (attempt ${attempt + 1}), retrying in ${backoffMs}ms: ${errorMsg}`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        return { output: null, error: errorMsg };
      }
    }
    return { output: null, error: "Max retries exhausted" };
  }

  return async (state: AgentGraphState): Promise<Partial<AgentGraphState>> => {
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage || !("tool_calls" in lastMessage)) {
      return {};
    }

    const aiMsg = lastMessage as AIMessage;
    const toolCallEntries = aiMsg.tool_calls;
    if (!toolCallEntries || toolCallEntries.length === 0) return {};

    logger.info(`[${state.agentName}] Act: executing ${toolCallEntries.length} tool call(s) in parallel`);

    const scheduledToolCounts = new Map<string, number>();
    const scheduledWriteCounts = new Map<string, number>();
    const guardErrors = toolCallEntries.map((tc) => {
      const args = tc.args as Record<string, unknown>;
      const guardError = getGuardError(state, tc.name, args, limits, scheduledToolCounts, scheduledWriteCounts);
      if (guardError) return guardError;

      scheduledToolCounts.set(tc.name, (scheduledToolCounts.get(tc.name) ?? 0) + 1);
      if (tc.name === "workspace_write") {
        const targetPath = normalizeWorkspacePath(args.name);
        if (targetPath) scheduledWriteCounts.set(targetPath, (scheduledWriteCounts.get(targetPath) ?? 0) + 1);
      }
      return undefined;
    });

    const execResults = await Promise.all(
      toolCallEntries.map(async (tc, index) => {
        const toolCallId = tc.id ?? tc.name;
        const t = toolMap.get(tc.name);
        const start = Date.now();
        const guardError = guardErrors[index];

        if (guardError) {
          const record: ToolCallRecord = {
            toolName: tc.name, input: tc.args, output: null,
            duration: 0, success: false, error: guardError,
          };
          toolEventCb?.onToolFinished?.(toolCallId, tc.name, "failed", null, guardError, 0);
          const msg = new ToolMessage({
            tool_call_id: toolCallId,
            content: JSON.stringify({ success: false, blocked: true, error: guardError }),
          });
          logger.warn(`[${state.agentName}] Blocked tool call ${tc.name}: ${guardError}`);
          return { record, msg };
        }

        if (!t) {
          const record: ToolCallRecord = {
            toolName: tc.name, input: tc.args, output: null,
            duration: 0, success: false, error: `Tool not found: ${tc.name}`,
          };
          toolEventCb?.onToolFinished?.(toolCallId, tc.name, "failed", null, record.error, 0);
          const msg = new ToolMessage({
            tool_call_id: toolCallId,
            content: JSON.stringify({ error: record.error }),
          });
          return { record, msg };
        }

        toolEventCb?.onToolStarted?.(toolCallId, tc.name, tc.args as Record<string, unknown>);

        const { output, error } = await executeWithRetry(t, tc.args);

        if (error) {
          const elapsed = (Date.now() - start) / 1000;
          const record: ToolCallRecord = {
            toolName: tc.name, input: tc.args, output: null,
            duration: Date.now() - start, success: false, error,
          };
          toolEventCb?.onToolFinished?.(toolCallId, tc.name, "failed", null, error, elapsed);
          const msg = new ToolMessage({
            tool_call_id: toolCallId,
            content: JSON.stringify({ error }),
          });
          return { record, msg };
        }

        const elapsed = (Date.now() - start) / 1000;
        const record: ToolCallRecord = {
          toolName: tc.name, input: tc.args, output,
          duration: Date.now() - start, success: true,
        };
        toolEventCb?.onToolFinished?.(toolCallId, tc.name, "succeeded", output, undefined, elapsed);
        const msg = new ToolMessage({
          tool_call_id: toolCallId,
          content: typeof output === "string" ? output : JSON.stringify(output),
        });
        return { record, msg };
      }),
    );

    const results = execResults.map((r) => r.record);
    const responseMessages = execResults.map((r) => r.msg);

    const SPAWN_TOOL_NAMES = new Set(["spawn_sub_agent", "spawn_parallel_agents"]);
    const spawnResults: SubAgentResult[] = results
      .filter((r) => SPAWN_TOOL_NAMES.has(r.toolName))
      .map((r) => {
        const input = r.input as Record<string, unknown> | undefined;
        return {
          agentName: (input?.agentName as string) ?? r.toolName,
          taskId: (input?.taskId as string) ?? "",
          instruction: (input?.instruction as string) ?? "",
          result: r.output,
          success: r.success,
          duration: r.duration,
        };
      });

    const updatedMemory = addMemoryEntry(state.workingMemory, {
      type: "action",
      content: `Executed ${results.length} tool(s) in parallel: ${results.map((r) => `${r.toolName}(${r.success ? "ok" : "fail"})`).join(", ")}`,
    });

    const partial: Partial<AgentGraphState> = {
      messages: responseMessages,
      toolCalls: results,
      workingMemory: updatedMemory,
    };
    if (spawnResults.length > 0) {
      partial.subAgentResults = spawnResults;
    }
    return partial;
  };
}

/**
 * Nudge node: injected when the LLM returns an empty response (no tool calls).
 * For cold-start (no prior work): generic "use your tools" reminder.
 * For partial-work (some tools already called): summarises what was done and
 * reminds the agent to finish the remaining work.
 */
export function createNudgeNode() {
  return async (state: AgentGraphState): Promise<Partial<AgentGraphState>> => {
    const hasWorkDone = state.toolCalls.length > 0 || state.subAgentResults.length > 0;
    logger.info(
      `[${state.agentName}] Nudge: ${hasWorkDone ? "partial-work" : "cold-start"} ` +
      `(retry ${state.emptyResponseRetries + 1})`,
    );

    let nudgeText: string;
    if (hasWorkDone) {
      const writeCalls = state.toolCalls.filter(
        (tc) => tc.toolName === "workspace_write" && tc.success,
      );
      const fileList = writeCalls
        .map((tc) => {
          const input = tc.input as Record<string, unknown> | undefined;
          return (input?.name as string) ?? (input?.path as string) ?? "unknown";
        })
        .join(", ");

      nudgeText =
        `[System Reminder] You stopped producing tool calls but your task is NOT finished. ` +
        `So far you have made ${state.toolCalls.length} tool call(s)` +
        (writeCalls.length > 0 ? ` and written ${writeCalls.length} file(s): ${fileList}` : "") +
        `. Review your original instructions — are ALL required files written? ` +
        `If any files are still missing, continue calling the required tools NOW. ` +
        `If all required files have already been written, output your final JSON now without calling more tools.`;
    } else {
      nudgeText =
        `[System Reminder] Your previous response was empty or did not include any tool calls. ` +
        `You have NOT completed your task yet — no files have been written. ` +
        `You MUST use the tools available to you (e.g. workspace_write) to complete your assigned task. ` +
        `Re-read your instructions and produce the required output NOW.`;
    }

    return {
      messages: [new HumanMessage(nudgeText)],
      emptyResponseRetries: state.emptyResponseRetries + 1,
    };
  };
}

export function createObserveNode() {
  return async (state: AgentGraphState): Promise<Partial<AgentGraphState>> => {
    const updatedMemory = addMemoryEntry(state.workingMemory, {
      type: "observation",
      content: `Observation after iteration ${state.iteration}. Tool calls so far: ${state.toolCalls.length}`,
    });
    return { workingMemory: updatedMemory };
  };
}

export function createReflectNode(model: BaseChatModel) {
  return async (state: AgentGraphState): Promise<Partial<AgentGraphState>> => {
    logger.info(`[${state.agentName}] Reflect: analyzing execution`);

    const toolSummary = state.toolCalls
      .map((tc) => `- ${tc.toolName}: ${tc.success ? "success" : `FAILED: ${tc.error}`} (${tc.duration}ms)`)
      .join("\n");

    const reflectionPrompt = `You are reflecting on a completed task. Analyze the execution and provide structured feedback.

## Execution Summary
- Iterations: ${state.iteration}
- Tool calls: ${state.toolCalls.length}
- Sub-agent results: ${state.subAgentResults.length}

## Tool Call Details
${toolSummary || "No tool calls made."}

## Task Messages
${state.messages.slice(-5).map((m) => `[${m._getType()}] ${typeof m.content === "string" ? m.content.slice(0, 200) : "..."}`).join("\n")}

Provide a JSON reflection with: summary, lessonsLearned (array), suggestedImprovements (array), confidence (0-1).`;

    const response = await model.invoke([
      new SystemMessage("You are a self-reflection system. Output valid JSON only."),
      new HumanMessage(reflectionPrompt),
    ]);

    const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);

    let reflection: Reflection;
    try {
      const parsed = JSON.parse(content.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
      reflection = {
        timestamp: new Date().toISOString(),
        summary: parsed.summary ?? "Reflection completed",
        lessonsLearned: parsed.lessonsLearned ?? [],
        suggestedImprovements: parsed.suggestedImprovements ?? [],
        confidence: parsed.confidence ?? 0.5,
      };
    } catch {
      reflection = {
        timestamp: new Date().toISOString(),
        summary: content.slice(0, 500),
        lessonsLearned: [],
        suggestedImprovements: [],
        confidence: 0.3,
      };
    }

    logger.info(`[${state.agentName}] Reflection: confidence=${reflection.confidence}, lessons=${reflection.lessonsLearned.length}`);

    return {
      reflections: [reflection],
      done: true,
    };
  };
}

// ---------------------------------------------------------------------------
// Routing Functions
// ---------------------------------------------------------------------------

/**
 * Max consecutive times we will nudge the LLM to use tools before giving up.
 * Keeps the loop bounded if the model genuinely cannot produce tool calls.
 */
const MAX_EMPTY_RESPONSE_NUDGES = 2;

/**
 * Max consecutive nudges when the agent has done *some* work but stopped
 * producing tool calls mid-task. More generous than the cold-start nudge
 * because the model already demonstrated willingness to use tools.
 */
const MAX_PARTIAL_WORK_NUDGES = 3;

function hasMeaningfulMessageContent(message: BaseMessage | undefined): boolean {
  if (!message) return false;

  const { content } = message;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  if (Array.isArray(content)) {
    return content.some((item) => {
      if (!item || typeof item !== "object") return false;
      const maybeText = (item as { text?: unknown }).text;
      return typeof maybeText === "string" && maybeText.trim().length > 0;
    });
  }

  return false;
}

export function routeAfterThink(state: AgentGraphState): "act" | "nudge" | "reflect" {
  const lastMessage = state.messages[state.messages.length - 1];

  if (lastMessage && "tool_calls" in lastMessage) {
    const aiMsg = lastMessage as AIMessage;
    if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
      return "act";
    }
  }

  if (hasMeaningfulMessageContent(lastMessage)) {
    return "reflect";
  }

  if (state.disableNudge || state.iteration >= state.maxIterations) {
    return "reflect";
  }

  const hasNoWorkDone = state.toolCalls.length === 0 && state.subAgentResults.length === 0;

  if (hasNoWorkDone && state.emptyResponseRetries < MAX_EMPTY_RESPONSE_NUDGES) {
    logger.warn(
      `[${state.agentName}] Empty response with no prior tool calls ` +
      `(nudge ${state.emptyResponseRetries + 1}/${MAX_EMPTY_RESPONSE_NUDGES}), retrying`,
    );
    return "nudge";
  }

  if (!hasNoWorkDone && state.emptyResponseRetries < MAX_PARTIAL_WORK_NUDGES) {
    logger.warn(
      `[${state.agentName}] Stopped producing tool calls after ${state.toolCalls.length} call(s) ` +
      `(partial-work nudge ${state.emptyResponseRetries + 1}/${MAX_PARTIAL_WORK_NUDGES}), retrying`,
    );
    return "nudge";
  }

  return "reflect";
}

export function routeAfterObserve(state: AgentGraphState): "think" | "reflect" {
  if (state.iteration >= state.maxIterations) {
    logger.warn(`[${state.agentName}] Max iterations (${state.maxIterations}) reached`);
    return "reflect";
  }

  const recentCalls = state.toolCalls.slice(-3);
  if (recentCalls.length >= 3 && recentCalls.every((tc) => !tc.success)) {
    logger.warn(`[${state.agentName}] 3 consecutive tool failures detected, entering reflect`);
    return "reflect";
  }

  return "think";
}

// ---------------------------------------------------------------------------
// Graph Builder
// ---------------------------------------------------------------------------

export function buildAgentGraph(
  agentDef: AgentDefinition,
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  toolEventCb?: ToolEventCallback,
) {
  const graph = new StateGraph(AgentState)
    .addNode("perceive", createPerceiveNode(agentDef))
    .addNode("think", createThinkNode(model, tools))
    .addNode("act", createActNode(tools, toolEventCb, agentDef.config.toolLimits))
    .addNode("observe", createObserveNode())
    .addNode("nudge", createNudgeNode())
    .addNode("reflect", createReflectNode(model))
    .addEdge(START, "perceive")
    .addEdge("perceive", "think")
    .addConditionalEdges("think", routeAfterThink)
    .addEdge("act", "observe")
    .addEdge("nudge", "think")
    .addConditionalEdges("observe", routeAfterObserve)
    .addEdge("reflect", END);

  return graph;
}
