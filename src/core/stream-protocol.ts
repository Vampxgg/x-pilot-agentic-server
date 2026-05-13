import { randomUUID } from "node:crypto";
import {
  StreamEventType,
  type StreamEvent,
  type StreamEventTypeName,
  type TaskStartedData,
  type TaskFinishedData,
  type NodeStartedData,
  type NodeFinishedData,
  type MessageData,
  type MessageEndData,
  type ToolStartedData,
  type ToolFinishedData,
  type AgentStartedData,
  type AgentMessageData,
  type AgentToolStartedData,
  type AgentToolFinishedData,
  type AgentFinishedData,
  type ThinkingData,
  type ProgressData,
  type ErrorData,
  type TokenUsage,
  type NodeType,
  type TaskFinishStatus,
} from "./types.js";

export interface StreamContext {
  taskId: string;
  sessionId: string;
}

export function createStreamContext(sessionId?: string, taskId?: string): StreamContext {
  return {
    taskId: taskId ?? `task_${randomUUID().slice(0, 8)}`,
    sessionId: sessionId ?? "",
  };
}

function now(): number {
  return Date.now() / 1000;
}

// ---------------------------------------------------------------------------
// Generic event builder (id is assigned by SSEWriter, set to 0 here)
// ---------------------------------------------------------------------------

function buildEvent<T extends StreamEventTypeName>(
  ctx: StreamContext,
  event: T,
  data: StreamEvent<T>["data"],
): StreamEvent<T> {
  return {
    event,
    id: 0,
    task_id: ctx.taskId,
    session_id: ctx.sessionId,
    created_at: now(),
    data,
  } as StreamEvent<T>;
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export function createTaskStarted(
  ctx: StreamContext,
  agentName: string,
  threadId?: string,
): StreamEvent<"task_started"> {
  return buildEvent(ctx, StreamEventType.TASK_STARTED, {
    agent_name: agentName,
    ...(threadId ? { thread_id: threadId } : {}),
  } as TaskStartedData);
}

export function createTaskFinished(
  ctx: StreamContext,
  opts: {
    status: TaskFinishStatus;
    output?: string;
    outputs?: Record<string, unknown>;
    error?: string;
    elapsedTime: number;
    usage?: TokenUsage;
    metadata?: Record<string, unknown>;
  },
): StreamEvent<"task_finished"> {
  return buildEvent(ctx, StreamEventType.TASK_FINISHED, {
    status: opts.status,
    output: opts.output,
    outputs: opts.outputs,
    error: opts.error,
    elapsed_time: opts.elapsedTime,
    usage: opts.usage,
    metadata: opts.metadata,
  } as TaskFinishedData);
}

export function createDone(ctx: StreamContext): StreamEvent<"done"> {
  return buildEvent(ctx, StreamEventType.DONE, {} as Record<string, never>);
}

export function createPing(ctx: StreamContext): StreamEvent<"ping"> {
  return buildEvent(ctx, StreamEventType.PING, {} as Record<string, never>);
}

// ---------------------------------------------------------------------------
// Node events
// ---------------------------------------------------------------------------

export function createNodeStarted(
  ctx: StreamContext,
  nodeType: NodeType,
  iteration: number,
  nodeId?: string,
  title?: string,
): StreamEvent<"node_started"> {
  return buildEvent(ctx, StreamEventType.NODE_STARTED, {
    node_type: nodeType,
    iteration,
    ...(nodeId ? { node_id: nodeId } : {}),
    ...(title ? { title } : {}),
  } as NodeStartedData);
}

export function createNodeFinished(
  ctx: StreamContext,
  opts: {
    nodeType: NodeType;
    status: "succeeded" | "failed";
    elapsedTime: number;
    iteration: number;
    usage?: TokenUsage;
    output?: unknown;
    nodeId?: string;
    title?: string;
  },
): StreamEvent<"node_finished"> {
  return buildEvent(ctx, StreamEventType.NODE_FINISHED, {
    node_type: opts.nodeType,
    status: opts.status,
    elapsed_time: opts.elapsedTime,
    iteration: opts.iteration,
    usage: opts.usage,
    output: opts.output,
    ...(opts.nodeId ? { node_id: opts.nodeId } : {}),
    ...(opts.title ? { title: opts.title } : {}),
  } as NodeFinishedData);
}

// ---------------------------------------------------------------------------
// Content stream events
// ---------------------------------------------------------------------------

export function createMessage(ctx: StreamContext, delta: string): StreamEvent<"message"> {
  return buildEvent(ctx, StreamEventType.MESSAGE, {
    role: "assistant",
    delta,
  } as MessageData);
}

export function createMessageEnd(
  ctx: StreamContext,
  content: string,
  usage?: TokenUsage,
): StreamEvent<"message_end"> {
  return buildEvent(ctx, StreamEventType.MESSAGE_END, {
    role: "assistant",
    content,
    usage,
  } as MessageEndData);
}

// ---------------------------------------------------------------------------
// Tool events
// ---------------------------------------------------------------------------

export function createToolStarted(
  ctx: StreamContext,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): StreamEvent<"tool_started"> {
  return buildEvent(ctx, StreamEventType.TOOL_STARTED, {
    tool_call_id: toolCallId,
    tool_name: toolName,
    arguments: args,
    metadata,
  } as ToolStartedData);
}

export function createToolFinished(
  ctx: StreamContext,
  opts: {
    toolCallId: string;
    toolName: string;
    status: "succeeded" | "failed";
    output?: unknown;
    error?: string;
    elapsedTime: number;
    metadata?: Record<string, unknown>;
  },
): StreamEvent<"tool_finished"> {
  return buildEvent(ctx, StreamEventType.TOOL_FINISHED, {
    tool_call_id: opts.toolCallId,
    tool_name: opts.toolName,
    status: opts.status,
    output: opts.output,
    error: opts.error,
    elapsed_time: opts.elapsedTime,
    metadata: opts.metadata,
  } as ToolFinishedData);
}

// ---------------------------------------------------------------------------
// Sub-agent events
// ---------------------------------------------------------------------------

export function createAgentStarted(
  ctx: StreamContext,
  opts: {
    childTaskId: string;
    agentName: string;
    instruction: string;
    metadata?: Record<string, unknown>;
  },
): StreamEvent<"agent_started"> {
  return buildEvent(ctx, StreamEventType.AGENT_STARTED, {
    child_task_id: opts.childTaskId,
    parent_task_id: ctx.taskId,
    agent_name: opts.agentName,
    instruction: opts.instruction,
    metadata: opts.metadata,
  } as AgentStartedData);
}

export function createAgentMessage(
  ctx: StreamContext,
  childTaskId: string,
  agentName: string,
  delta: string,
): StreamEvent<"agent_message"> {
  return buildEvent(ctx, StreamEventType.AGENT_MESSAGE, {
    child_task_id: childTaskId,
    agent_name: agentName,
    delta,
  } as AgentMessageData);
}

export function createAgentToolStarted(
  ctx: StreamContext,
  opts: {
    childTaskId: string;
    agentName: string;
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): StreamEvent<"agent_tool_started"> {
  return buildEvent(ctx, StreamEventType.AGENT_TOOL_STARTED, {
    child_task_id: opts.childTaskId,
    agent_name: opts.agentName,
    tool_call_id: opts.toolCallId,
    tool_name: opts.toolName,
    arguments: opts.arguments,
    metadata: opts.metadata,
  } as AgentToolStartedData);
}

export function createAgentToolFinished(
  ctx: StreamContext,
  opts: {
    childTaskId: string;
    agentName: string;
    toolCallId: string;
    toolName: string;
    status: "succeeded" | "failed";
    output?: unknown;
    error?: string;
    elapsedTime: number;
    metadata?: Record<string, unknown>;
  },
): StreamEvent<"agent_tool_finished"> {
  return buildEvent(ctx, StreamEventType.AGENT_TOOL_FINISHED, {
    child_task_id: opts.childTaskId,
    agent_name: opts.agentName,
    tool_call_id: opts.toolCallId,
    tool_name: opts.toolName,
    status: opts.status,
    output: opts.output,
    error: opts.error,
    elapsed_time: opts.elapsedTime,
    metadata: opts.metadata,
  } as AgentToolFinishedData);
}

export function createAgentFinished(
  ctx: StreamContext,
  opts: {
    childTaskId: string;
    agentName: string;
    status: "succeeded" | "failed";
    output?: unknown;
    error?: string;
    elapsedTime: number;
    usage?: TokenUsage;
    metadata?: Record<string, unknown>;
  },
): StreamEvent<"agent_finished"> {
  return buildEvent(ctx, StreamEventType.AGENT_FINISHED, {
    child_task_id: opts.childTaskId,
    parent_task_id: ctx.taskId,
    agent_name: opts.agentName,
    status: opts.status,
    output: opts.output,
    error: opts.error,
    elapsed_time: opts.elapsedTime,
    usage: opts.usage,
    metadata: opts.metadata,
  } as AgentFinishedData);
}

// ---------------------------------------------------------------------------
// Auxiliary events
// ---------------------------------------------------------------------------

export function createThinking(ctx: StreamContext, content: string): StreamEvent<"thinking"> {
  return buildEvent(ctx, StreamEventType.THINKING, { content } as ThinkingData);
}

export function createProgress(
  ctx: StreamContext,
  message: string,
  opts?: { percentage?: number; phase?: string; metadata?: Record<string, unknown> },
): StreamEvent<"progress"> {
  return buildEvent(ctx, StreamEventType.PROGRESS, {
    message,
    percentage: opts?.percentage,
    phase: opts?.phase,
    metadata: opts?.metadata,
  } as ProgressData);
}

export function createError(
  ctx: StreamContext,
  code: string,
  message: string,
  recoverable: boolean,
): StreamEvent<"error"> {
  return buildEvent(ctx, StreamEventType.ERROR, {
    code,
    message,
    recoverable,
  } as ErrorData);
}
