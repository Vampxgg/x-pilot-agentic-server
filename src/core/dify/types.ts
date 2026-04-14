// src/core/dify/types.ts

export const DifyEventType = {
  WORKFLOW_STARTED: "workflow_started",
  WORKFLOW_FINISHED: "workflow_finished",
  NODE_STARTED: "node_started",
  NODE_FINISHED: "node_finished",
  MESSAGE: "message",
  MESSAGE_END: "message_end",
  AGENT_LOG: "agent_log",
  ERROR: "error",
  PING: "ping",
  PROGRESS: "progress",
} as const;

export type DifyEventTypeName = (typeof DifyEventType)[keyof typeof DifyEventType];

// --- Common envelope for every SSE event ---
export interface DifyEventEnvelope {
  event: DifyEventTypeName;
  task_id: string;          // Dify stop task ID, new UUID per stream
  conversation_id: string;  // mapped from native session_id
  message_id: string;       // mapped from native task_id
  created_at: number;       // Unix seconds
}

// --- Event data types ---

export interface DifyWorkflowStartedData {
  id: string;
  workflow_run_id: string;
  agent_name: string;
  inputs: Record<string, unknown>;
  thread_id?: string;
  created_at: number;
}

export interface DifyWorkflowFinishedData {
  id: string;                // = workflow_run_id
  workflow_run_id: string;
  status: "succeeded" | "failed" | "cancelled" | "paused" | "stopped";
  outputs: Record<string, unknown>;
  error: string | null;
  elapsed_time: number;
  total_tokens?: number;
  total_steps?: number;
  created_by?: { id: string; user: string };
  created_at: number;
  finished_at: number;
  exceptions_count?: number;
  files?: unknown[];
}

export type DifyNodeType = "perceive" | "think" | "act" | "reflect" | "observe" | "tool" | "agent";

export interface DifyNodeStartedData {
  id: string;
  node_id: string;
  node_execution_id: string;
  node_type: DifyNodeType;
  title: string;
  parent_id: string;
  index: number;
  inputs: Record<string, unknown> | null;
  created_at: number;
}

export interface DifyNodeFinishedData {
  id: string;
  node_id: string;
  node_execution_id: string;
  node_type: DifyNodeType;
  title: string;
  parent_id: string;
  index: number;
  inputs: Record<string, unknown> | null;
  status: "succeeded" | "failed";
  outputs?: Record<string, unknown>;
  error?: string;
  elapsed_time: number;
  usage?: TokenUsageCompat;
  created_at: number;
}

export interface DifyMessageEndMetadata {
  annotation_reply: unknown;
  retriever_resources: unknown[];
  usage?: TokenUsageCompat;
}

// --- Agent log ---

export type AgentLogLabel = string;
export type AgentLogStep = "perceive" | "think" | "act" | "observe" | "reflect" | "round";
export type AgentLogStatus = "started" | "succeeded" | "failed" | "stopped";

export interface DifyAgentLogData {
  id: string;
  node_id: string;
  node_execution_id: string;
  parent_id: string | null;
  label: string;
  step: AgentLogStep;
  status: AgentLogStatus;
  node_type?: string;
  data: Record<string, unknown>;
  error: string | null;
  output?: unknown;
  elapsed_time?: number;
}

export interface DifyErrorData {
  code: string;
  message: string;
  status: number;            // HTTP-style status code
  recoverable: boolean;
}

export interface DifyProgressData {
  message: string;
  percentage?: number;
  phase?: string;
  metadata?: Record<string, unknown>;
}

export interface TokenUsageCompat {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  model?: string;
}

// --- Union event type ---
// NOTE: message and message_end are FLAT (no nested data wrapper),
//       matching Dify's real SSE protocol.
export type DifyEvent =
  | (DifyEventEnvelope & { event: "workflow_started";  data: DifyWorkflowStartedData })
  | (DifyEventEnvelope & { event: "workflow_finished"; data: DifyWorkflowFinishedData })
  | (DifyEventEnvelope & { event: "node_started";      data: DifyNodeStartedData })
  | (DifyEventEnvelope & { event: "node_finished";     data: DifyNodeFinishedData })
  | (DifyEventEnvelope & { event: "message";           id: string; answer: string; parent_id: string | null })
  | (DifyEventEnvelope & { event: "message_end";       id: string; metadata: DifyMessageEndMetadata; files: unknown[] })
  | (DifyEventEnvelope & { event: "agent_log";         data: DifyAgentLogData })
  | (DifyEventEnvelope & { event: "error";             data: DifyErrorData })
  | (DifyEventEnvelope & { event: "ping" })
  | (DifyEventEnvelope & { event: "progress";          data: DifyProgressData });
