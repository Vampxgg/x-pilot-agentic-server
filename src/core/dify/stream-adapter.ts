import { randomUUID } from "node:crypto";
import type {
  StreamEvent,
  StreamEventTypeName,
  TaskStartedData,
  TaskFinishedData,
  NodeStartedData,
  NodeFinishedData,
  MessageData,
  MessageEndData,
  ThinkingData,
  ToolStartedData,
  ToolFinishedData,
  AgentStartedData,
  AgentMessageData,
  AgentToolStartedData,
  AgentToolFinishedData,
  AgentFinishedData,
  ProgressData,
  ErrorData,
  WorkflowDefinition,
  WorkflowStrategy,
} from "../types.js";
import type { DifyEvent, AgentLogStatus, AgentLogStep } from "./types.js";
import { DifyEventType } from "./types.js";

// ---------------------------------------------------------------------------
// Public context exposed for serialisation / logging
// ---------------------------------------------------------------------------

export interface DifyAdapterContext {
  difyTaskId: string;
  conversationId: string;
  messageId: string;
  workflowRunId: string;
}

// ---------------------------------------------------------------------------
// Internal execution frame
// ---------------------------------------------------------------------------

interface ExecutionFrame {
  nodeId: string;
  nodeExecutionId: string;
  parentExecutionId: string;
  agentName: string;
  startTime: number;
  currentRoundId: string;
  currentRound: number;
  isSubAgent: boolean;
  /** Event id of the agent_log(started) that created this frame */
  agentStartedEventId: string;
  /** Event id of the last tool_call agent_log (for linking agent_started → spawning tool) */
  lastToolEventId: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class DifyStreamAdapter {
  private ctx: DifyAdapterContext;
  private nodeIndex = 0;
  private nodeIdCounter = BigInt(Date.now());

  /** Frame for the top-level (main) agent */
  private mainFrame: ExecutionFrame | undefined;
  /** Frames for concurrent sub-agents, keyed by child_task_id */
  private childFrames = new Map<string, ExecutionFrame>();

  /** Workflow definition for strategy-aware transformation */
  private workflow: WorkflowDefinition | undefined;
  private strategy: WorkflowStrategy;

  private hideThinkOutput: boolean;

  private inputContext: {
    inputs: Record<string, unknown>;
    query: string;
    userId: string;
    tenantId: string;
    modelName: string;
  } = { inputs: {}, query: "", userId: "", tenantId: "", modelName: "LLM" };

  constructor(
    sessionId: string,
    taskId: string,
    context?: {
      inputs?: Record<string, unknown>;
      query?: string;
      userId?: string;
      tenantId?: string;
      modelName?: string;
      hideThinkOutput?: boolean;
    },
    workflow?: WorkflowDefinition,
  ) {
    this.ctx = {
      difyTaskId: randomUUID(),
      conversationId: sessionId,
      messageId: taskId,
      workflowRunId: `workflow_run_${randomUUID().slice(0, 8)}`,
    };
    this.workflow = workflow;
    this.strategy = workflow?.agent?.strategy ?? "react";
    this.hideThinkOutput = context?.hideThinkOutput ?? true;
    if (context) {
      this.inputContext = {
        inputs: context.inputs ?? {},
        query: context.query ?? "",
        userId: context.userId ?? "",
        tenantId: context.tenantId ?? "",
        modelName: context.modelName ?? "LLM",
      };
    }
  }

  /**
   * Resolve a stable node_id from the workflow definition.
   * Falls back to auto-generated counter ID if no workflow is loaded.
   */
  private resolveNodeId(stepOrName: string): string {
    if (this.workflow?.nodeIdMap) {
      const mapped = this.workflow.nodeIdMap.get(stepOrName);
      if (mapped) return mapped;
    }
    return this.makeNodeId(stepOrName);
  }

  get workflowStrategy(): WorkflowStrategy {
    return this.strategy;
  }

  get difyTaskId(): string {
    return this.ctx.difyTaskId;
  }
  get conversationId(): string {
    return this.ctx.conversationId;
  }

  /**
   * Convert a single native v2 StreamEvent into 0-N Dify-compatible events.
   */
  transform(event: StreamEvent<StreamEventTypeName>): DifyEvent[] {
    switch (event.event) {
      case "task_started":
        return this.onTaskStarted(event.data as TaskStartedData, event.created_at);
      case "task_finished":
        return this.onTaskFinished(event.data as TaskFinishedData, event.created_at);
      case "node_started":
        return this.onNodeStarted(event.data as NodeStartedData, event.created_at);
      case "node_finished":
        return this.onNodeFinished(event.data as NodeFinishedData, event.created_at);
      case "message":
        return this.onMessage(event.data as MessageData, event.created_at);
      case "message_end":
        return this.onMessageEnd(event.data as MessageEndData, event.created_at);
      case "thinking":
        return this.onThinking(event.data as ThinkingData, event.created_at);
      case "tool_started":
        return this.onToolStarted(event.data as ToolStartedData, event.created_at);
      case "tool_finished":
        return this.onToolFinished(event.data as ToolFinishedData, event.created_at);
      case "agent_started":
        return this.onAgentStarted(event.data as AgentStartedData, event.created_at);
      case "agent_message":
        return this.onAgentMessage(event.data as AgentMessageData, event.created_at);
      case "agent_tool_started":
        return this.onAgentToolStarted(event.data as AgentToolStartedData, event.created_at);
      case "agent_tool_finished":
        return this.onAgentToolFinished(event.data as AgentToolFinishedData, event.created_at);
      case "agent_finished":
        return this.onAgentFinished(event.data as AgentFinishedData, event.created_at);
      case "progress":
        return this.onProgress(event.data as ProgressData, event.created_at);
      case "error":
        return this.onError(event.data as ErrorData, event.created_at);
      case "ping":
        return this.onPing(event.created_at);
      case "done":
        return [];
      default:
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // Frame lookup helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the correct frame for a native event that may have been forwarded
   * from a child agent. If the event data contains `_childTaskId`, look up
   * the child frame; otherwise fall back to mainFrame.
   */
  private resolveFrame(data: Record<string, unknown>): ExecutionFrame | undefined {
    const childTaskId = data._childTaskId as string | undefined;
    if (childTaskId) {
      return this.childFrames.get(childTaskId);
    }
    return this.mainFrame;
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private onTaskStarted(data: TaskStartedData, ts: number): DifyEvent[] {
    const agentId = this.workflow?.agent?.id;
    const nodeId = agentId
      ? (this.workflow?.nodeIdMap?.get(agentId) ?? this.resolveNodeId(data.agent_name))
      : this.resolveNodeId(data.agent_name);

    this.mainFrame = {
      nodeId,
      nodeExecutionId: nodeId,
      parentExecutionId: "",
      agentName: data.agent_name,
      startTime: ts,
      currentRoundId: "",
      currentRound: 0,
      isSubAgent: false,
      agentStartedEventId: "",
      lastToolEventId: "",
    };

    const idx = this.nextIndex();

    return [
      {
        ...this.envelope(ts),
        event: DifyEventType.WORKFLOW_STARTED,
        data: {
          id: this.ctx.workflowRunId,
          workflow_run_id: this.ctx.workflowRunId,
          agent_name: data.agent_name,
          inputs: {
            ...this.inputContext.inputs,
            "sys.query": this.inputContext.query,
            "sys.user_id": this.inputContext.userId,
            "sys.tenant_id": this.inputContext.tenantId,
          },
          thread_id: data.thread_id,
          created_at: ts,
        },
      } as DifyEvent,
      {
        ...this.envelope(ts),
        event: DifyEventType.NODE_STARTED,
        data: {
          id: nodeId,
          node_id: nodeId,
          node_execution_id: nodeId,
          node_type: "agent" as const,
          title: data.agent_name,
          parent_id: "",
          index: idx,
          inputs: null,
          created_at: ts,
        },
      } as DifyEvent,
    ];
  }

  private onTaskFinished(data: TaskFinishedData, ts: number): DifyEvent[] {
    const frame = this.mainFrame;
    this.mainFrame = undefined;
    const nodeId = frame?.nodeId ?? "";
    const execId = frame?.nodeExecutionId ?? "";
    const idx = this.nextIndex();
    const now = Math.floor(Date.now() / 1000);

    return [
      {
        ...this.envelope(ts),
        event: DifyEventType.NODE_FINISHED,
        data: {
          id: execId,
          node_id: nodeId,
          node_execution_id: execId,
          node_type: "agent" as const,
          title: frame?.agentName ?? "",
          parent_id: frame?.parentExecutionId ?? "",
          index: idx,
          inputs: null,
          status: data.status === "succeeded" ? "succeeded" : "failed",
          outputs: data.outputs ?? {},
          error: data.error,
          elapsed_time: data.elapsed_time,
          usage: data.usage,
          created_at: ts,
        },
      } as DifyEvent,
      {
        ...this.envelope(ts),
        event: DifyEventType.WORKFLOW_FINISHED,
        data: {
          id: this.ctx.workflowRunId,
          workflow_run_id: this.ctx.workflowRunId,
          status: data.status as any,
          outputs: data.outputs ?? {},
          error: data.error ?? null,
          elapsed_time: data.elapsed_time,
          total_tokens: data.usage?.total_tokens ?? 0,
          total_steps: frame?.currentRound ?? 0,
          created_at: ts,
          finished_at: now,
          exceptions_count: 0,
          files: [],
        },
      } as DifyEvent,
    ];
  }

  private onNodeStarted(data: NodeStartedData, ts: number): DifyEvent[] {
    const frame = this.resolveFrame(data as unknown as Record<string, unknown>);
    const events: DifyEvent[] = [];
    const step = data.node_type as AgentLogStep;

    if (step === "perceive" && frame) {
      frame.currentRound++;
      const roundId = randomUUID();
      frame.currentRoundId = roundId;

      events.push(
        this.buildAgentLog(frame, {
          id: roundId,
          label: `ROUND ${frame.currentRound}`,
          step: "round",
          status: "started",
          parentId: frame.isSubAgent ? frame.agentStartedEventId : null,
        }, ts),
      );
    }

    events.push(
      this.buildAgentLog(frame, {
        id: randomUUID(),
        label: step,
        step,
        status: "started",
        parentId: frame?.currentRoundId || null,
      }, ts),
    );

    if (step === "think") {
      events.push(
        this.buildAgentLog(frame, {
          id: randomUUID(),
          label: `${this.getModelName()} Thought`,
          step: "think",
          status: "started",
          parentId: frame?.currentRoundId || null,
        }, ts),
      );
    }

    return events;
  }

  private onNodeFinished(data: NodeFinishedData, ts: number): DifyEvent[] {
    const frame = this.resolveFrame(data as unknown as Record<string, unknown>);
    const step = data.node_type as AgentLogStep;
    const label = step === "think" ? `${this.getModelName()} Thought` : step;

    const output = (step === "think" && this.hideThinkOutput) ? "" : (data.output ?? "");

    return [
      this.buildAgentLog(frame, {
        id: randomUUID(),
        label,
        step,
        status: (data.status as AgentLogStatus) || "succeeded",
        parentId: frame?.currentRoundId || null,
        output,
        elapsed_time: data.elapsed_time,
      }, ts),
    ];
  }

  private onMessage(data: MessageData, ts: number): DifyEvent[] {
    const frame = this.mainFrame;
    return [
      {
        ...this.envelope(ts),
        event: DifyEventType.MESSAGE,
        id: this.ctx.messageId,
        answer: data.delta,
        parent_id: frame?.agentStartedEventId || null,
      } as DifyEvent,
    ];
  }

  private onMessageEnd(data: MessageEndData, ts: number): DifyEvent[] {
    return [
      {
        ...this.envelope(ts),
        event: DifyEventType.MESSAGE_END,
        id: this.ctx.messageId,
        metadata: {
          annotation_reply: null,
          retriever_resources: [],
          usage: data.usage
            ? {
                prompt_tokens: data.usage.prompt_tokens,
                completion_tokens: data.usage.completion_tokens,
                total_tokens: data.usage.total_tokens,
              }
            : undefined,
        },
        files: [],
      } as DifyEvent,
    ];
  }

  private onThinking(_data: ThinkingData, _ts: number): DifyEvent[] {
    // Do not mirror reasoning into Dify `message` events — clients treat them as answer text.
    return [];
  }

  private onToolStarted(data: ToolStartedData, ts: number): DifyEvent[] {
    const frame = this.mainFrame;
    const eventId = randomUUID();

    if (frame) {
      frame.lastToolEventId = eventId;
    }

    return [
      this.buildAgentLog(frame, {
        id: eventId,
        label: `CALL ${data.tool_name}`,
        step: "act",
        status: "started",
        parentId: frame?.currentRoundId || null,
        nodeType: "tool",
        data: {
          tool_name: data.tool_name,
          tool_call_id: data.tool_call_id,
          tool_input: data.arguments,
        },
      }, ts),
    ];
  }

  private onToolFinished(data: ToolFinishedData, ts: number): DifyEvent[] {
    const frame = this.mainFrame;
    return [
      this.buildAgentLog(frame, {
        id: randomUUID(),
        label: `CALL ${data.tool_name}`,
        step: "act",
        status: data.status as AgentLogStatus,
        parentId: frame?.currentRoundId || null,
        nodeType: "tool",
        data: {
          output: {
            tool_call_id: data.tool_call_id,
            tool_call_name: data.tool_name,
            tool_response: data.output,
          },
        },
        error: data.error || null,
        elapsed_time: data.elapsed_time,
      }, ts),
    ];
  }

  private onAgentStarted(data: AgentStartedData, ts: number): DifyEvent[] {
    const parentFrame = this.mainFrame;
    const childNodeId = this.makeNodeId(data.agent_name);
    const childExecId = `exec_${randomUUID().slice(0, 8)}`;
    const agentStartedEventId = randomUUID();

    const logEvent = this.buildAgentLog(parentFrame, {
      id: agentStartedEventId,
      label: data.agent_name,
      step: "act",
      status: "started",
      parentId: parentFrame?.lastToolEventId || parentFrame?.currentRoundId || null,
      nodeType: "agent",
      data: {
        agent_name: data.agent_name,
        child_task_id: data.child_task_id,
        instruction: data.instruction,
      },
    }, ts);

    this.childFrames.set(data.child_task_id, {
      nodeId: childNodeId,
      nodeExecutionId: childExecId,
      parentExecutionId: parentFrame?.nodeExecutionId ?? "",
      agentName: data.agent_name,
      startTime: ts,
      currentRoundId: "",
      currentRound: 0,
      isSubAgent: true,
      agentStartedEventId,
      lastToolEventId: "",
    });

    return [logEvent];
  }

  private onAgentMessage(data: AgentMessageData, ts: number): DifyEvent[] {
    const childFrame = this.childFrames.get(data.child_task_id);
    return [
      {
        ...this.envelope(ts),
        event: DifyEventType.MESSAGE,
        id: this.ctx.messageId,
        answer: data.delta,
        parent_id: childFrame?.agentStartedEventId ?? null,
      } as DifyEvent,
    ];
  }

  private onAgentToolStarted(data: AgentToolStartedData, ts: number): DifyEvent[] {
    const childFrame = this.childFrames.get(data.child_task_id);
    const eventId = randomUUID();
    if (childFrame) {
      childFrame.lastToolEventId = eventId;
    }
    return [
      this.buildAgentLog(childFrame, {
        id: eventId,
        label: `CALL ${data.tool_name}`,
        step: "act",
        status: "started",
        parentId: childFrame?.currentRoundId || null,
        nodeType: "tool",
        data: {
          tool_name: data.tool_name,
          tool_call_id: data.tool_call_id,
          tool_input: data.arguments,
        },
      }, ts),
    ];
  }

  private onAgentToolFinished(data: AgentToolFinishedData, ts: number): DifyEvent[] {
    const childFrame = this.childFrames.get(data.child_task_id);
    return [
      this.buildAgentLog(childFrame, {
        id: randomUUID(),
        label: `CALL ${data.tool_name}`,
        step: "act",
        status: data.status as AgentLogStatus,
        parentId: childFrame?.currentRoundId || null,
        nodeType: "tool",
        data: {
          output: {
            tool_call_id: data.tool_call_id,
            tool_call_name: data.tool_name,
            tool_response: data.output,
          },
        },
        error: data.error || null,
        elapsed_time: data.elapsed_time,
      }, ts),
    ];
  }

  private onAgentFinished(data: AgentFinishedData, ts: number): DifyEvent[] {
    const childFrame = this.childFrames.get(data.child_task_id);
    this.childFrames.delete(data.child_task_id);
    const parentFrame = this.mainFrame;

    return [
      this.buildAgentLog(parentFrame, {
        id: randomUUID(),
        label: data.agent_name,
        step: "act",
        status: (data.status as AgentLogStatus) || "succeeded",
        parentId: parentFrame?.lastToolEventId || parentFrame?.currentRoundId || null,
        nodeType: "agent",
        data: {
          agent_name: data.agent_name,
          child_task_id: data.child_task_id,
          child_execution_id: childFrame?.nodeExecutionId,
        },
        output: data.output,
        error: data.error || null,
        elapsed_time: data.elapsed_time,
      }, ts),
    ];
  }

  private onProgress(data: ProgressData, ts: number): DifyEvent[] {
    return [
      {
        ...this.envelope(ts),
        event: DifyEventType.PROGRESS,
        data: {
          message: data.message,
          percentage: data.percentage,
          phase: data.phase,
          metadata: data.metadata,
        },
      } as DifyEvent,
    ];
  }

  private onError(data: ErrorData, ts: number): DifyEvent[] {
    return [
      {
        ...this.envelope(ts),
        event: DifyEventType.ERROR,
        data: {
          code: data.code,
          message: data.message,
          status: 500,
          recoverable: data.recoverable,
        },
      } as DifyEvent,
    ];
  }

  private onPing(ts: number): DifyEvent[] {
    return [
      {
        ...this.envelope(ts),
        event: DifyEventType.PING,
      } as DifyEvent,
    ];
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private envelope(createdAt: number) {
    return {
      task_id: this.ctx.difyTaskId,
      conversation_id: this.ctx.conversationId,
      message_id: this.ctx.messageId,
      created_at: createdAt,
    };
  }

  private makeNodeId(_name: string): string {
    return String(this.nodeIdCounter++);
  }

  private nextIndex(): number {
    return this.nodeIndex++;
  }

  private getModelName(): string {
    return this.inputContext.modelName || "LLM";
  }

  private buildAgentLog(
    frame: ExecutionFrame | undefined,
    opts: {
      id: string;
      label: string;
      step: AgentLogStep | "round";
      status: AgentLogStatus;
      parentId: string | null;
      nodeType?: string;
      data?: Record<string, unknown>;
      error?: string | null;
      output?: unknown;
      elapsed_time?: number;
    },
    ts: number,
  ): DifyEvent {
    const innerData: Record<string, unknown> = { ...(opts.data ?? {}) };
    if (opts.output !== undefined) {
      innerData.output = opts.output;
    }

    return {
      ...this.envelope(ts),
      event: DifyEventType.AGENT_LOG,
      data: {
        id: opts.id,
        node_id: frame?.nodeId ?? "",
        node_execution_id: frame?.nodeExecutionId ?? "",
        parent_id: opts.parentId,
        label: opts.label,
        step: opts.step as any,
        status: opts.status,
        node_type: opts.nodeType,
        data: innerData,
        error: opts.error ?? null,
        ...(opts.elapsed_time !== undefined ? { elapsed_time: opts.elapsed_time } : {}),
      },
    } as DifyEvent;
  }
}
