import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { Runnable } from "@langchain/core/runnables";
import type { KnowledgeConfig } from "../tools/knowledge/types.js";

// ---------------------------------------------------------------------------
// Agent Definition (loaded from agent folder)
// ---------------------------------------------------------------------------

export interface AgentPromptFiles {
  identity?: string;
  soul?: string;
  mission?: string;
  tools?: string;
  bootstrap?: string;
  heartbeat?: string;
  [key: string]: string | undefined;
}

export interface OutputFormatConfig {
  type: "text" | "json" | "code";
  schema?: Record<string, unknown>;
  codeLanguage?: string;
}

export interface RetryConfig {
  maxAttempts: number;
  backoffMs: number;
}

export interface PipelineStep {
  name: string;
  agent?: string;
  handler?: string;
  parallel?: boolean;
  fanOutFrom?: string;
  dependsOn?: string[];
  inputMapping?: Record<string, string>;
  optional?: boolean;
  retry?: RetryConfig;
}

export type PipelineHandlerContext = {
  stepName: string;
  initialInput: string;
  previousResults: Map<string, unknown>;
  tenantId: string;
  userId: string;
  sessionId?: string;
  conversationId?: string;
  context?: Record<string, unknown>;
};

export type PipelineHandler = (ctx: PipelineHandlerContext) => Promise<unknown>;

export interface PipelineConfig {
  steps: PipelineStep[];
}

/**
 * Fallback 模型条目。
 * - 字符串形态：模型名经 `resolveProvider` 自动识别 provider（向后兼容）。
 * - 对象形态：可显式指定 `provider`（与 `AgentConfig.provider` 同义），
 *   适用于裸名模型（如 Vertex 上的 `gemini-2.5-flash`）等无法被自动识别的场景。
 *   `maxTokens` 可单独覆写，未指定时继承所属 agent 的 `maxTokens`。
 */
export interface FallbackModelEntry {
  model: string;
  provider?: string;
  maxTokens?: number;
}

export interface AgentConfig {
  model: string;
  /** 可选的显式 provider 名（如 "vertex" / "openai" / "anthropic"）。
   *  未指定时由 `resolveProvider(model)` 按模型名前缀/斜杠自动识别。 */
  provider?: string;
  workerModel?: string;
  /** 字符串与对象形态可任意混用，运行时会被归一化处理。 */
  fallbackModels?: Array<string | FallbackModelEntry>;
  maxTokens?: number;
  maxIterations?: number;
  maxConcurrency: number;
  allowedTools: string[];
  heartbeat: {
    enabled: boolean;
    intervalMs: number;
  };
  evolution: {
    enabled: boolean;
    requireApproval: boolean;
  };
  timeout: number;
  streamMode?: "stream" | "block";
  /** When true (default), the Dify adapter hides think-step output from agent_log events. */
  hideThinkOutput?: boolean;
  metadata?: Record<string, unknown>;
  outputFormat?: OutputFormatConfig;
  retry?: RetryConfig;
  pipeline?: PipelineConfig;
}

export interface AgentDefinition {
  name: string;
  folderPath: string;
  prompts: AgentPromptFiles;
  config: AgentConfig;
  skills: SkillDefinition[];
  memoryPath: string;
  workflow?: WorkflowDefinition;
}

// ---------------------------------------------------------------------------
// Workflow Definition (loaded from workflow.yaml)
// ---------------------------------------------------------------------------

export type WorkflowStrategy = "react" | "pipeline" | "dual" | "custom";

export type WorkflowNodeType =
  | "start"
  | "end"
  | "phase"
  | "agent_call"
  | "handler"
  | "llm"
  | "tool"
  | "iteration"
  | "condition"
  | "parallel_gateway";

export type WorkflowEdgeType = "sequential" | "conditional" | "cycle";

export type WorkflowPhaseStep = "perceive" | "think" | "act" | "observe" | "reflect";

export interface WorkflowNodeSpawnRef {
  ref: string;
  workflow_ref?: string;
  cardinality?: string;
}

export interface WorkflowNodeToolEntry {
  name: string;
  spawns?: WorkflowNodeSpawnRef[];
}

export interface WorkflowNodeData {
  title?: string;
  description?: string;
  step?: WorkflowPhaseStep;
  stream_mode?: "stream" | "block";
  tools?: WorkflowNodeToolEntry[];
  agent?: string;
  handler?: string;
  retry?: RetryConfig;
  model_ref?: string;
  prompt_ref?: string;
  items_from?: string;
  parallel?: boolean;
  children?: WorkflowNode[];
  variables?: Array<{ name: string; type: string; required?: boolean; description?: string }>;
  outputs?: Array<{ name: string; type: string; description?: string }>;
  [key: string]: unknown;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  data: WorkflowNodeData;
}

export interface WorkflowEdgeData {
  type: WorkflowEdgeType;
  condition?: string;
  description?: string;
}

export interface WorkflowEdge {
  id?: string;
  source: string;
  target: string;
  data: WorkflowEdgeData;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowMode {
  strategy: WorkflowStrategy;
  graph: WorkflowGraph;
}

export interface WorkflowAgent {
  id: string;
  label: string;
  description?: string;
  strategy: WorkflowStrategy;
}

export interface WorkflowPromptRefs {
  identity?: string;
  mission?: string;
  soul?: string;
  tools?: string;
  [key: string]: string | undefined;
}

export interface WorkflowDefinition {
  version: string;
  kind: "agent-workflow";
  agent: WorkflowAgent;
  config?: Partial<AgentConfig>;
  prompts?: WorkflowPromptRefs;
  graph?: WorkflowGraph;
  modes?: Record<string, WorkflowMode | string>;
  /** Precomputed lookup: phase step name → stable node id */
  nodeIdMap?: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Agent Runtime State (flows through LangGraph)
// ---------------------------------------------------------------------------

export interface WorkingMemory {
  facts: string[];
  context: string;
  shortTermLog: MemoryEntry[];
}

export interface MemoryEntry {
  timestamp: string;
  type: "observation" | "action" | "reflection" | "tool_result" | "error";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface Reflection {
  timestamp: string;
  summary: string;
  lessonsLearned: string[];
  suggestedImprovements: string[];
  confidence: number;
}

export interface TaskResult {
  success: boolean;
  output: unknown;
  error?: string;
  duration: number;
  toolCalls: ToolCallRecord[];
  subAgentResults: SubAgentResult[];
}

export interface ToolCallRecord {
  toolName: string;
  input: unknown;
  output: unknown;
  duration: number;
  success: boolean;
  error?: string;
}

export interface SubAgentResult {
  agentName: string;
  taskId: string;
  instruction: string;
  result: unknown;
  success: boolean;
  duration: number;
}

// ---------------------------------------------------------------------------
// Sub-Agent Spawning
// ---------------------------------------------------------------------------

export interface SpawnSubAgentOptions {
  parentId: string;
  agentName: string;
  instruction: string;
  model?: string;
  timeout?: number;
  onComplete?: "notify" | "aggregate" | "silent";
  metadata?: Record<string, unknown>;
  context?: Record<string, unknown>;
  sessionId?: string;
  tenantId?: string;
  userId?: string;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface TaskRecord {
  id: string;
  agentName: string;
  parentTaskId?: string;
  tenantId?: string;
  instruction: string;
  status: TaskStatus;
  result?: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Tool System
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  tool: StructuredToolInterface;
}

// ---------------------------------------------------------------------------
// Skill System
// ---------------------------------------------------------------------------

export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  filePath: string;
}

// ---------------------------------------------------------------------------
// Memory Store Interface
// ---------------------------------------------------------------------------

export interface MemoryStore {
  read(tenantId: string, agentName: string, key: string): Promise<string | null>;
  write(tenantId: string, agentName: string, key: string, content: string): Promise<void>;
  append(tenantId: string, agentName: string, key: string, content: string): Promise<void>;
  list(tenantId: string, agentName: string): Promise<string[]>;
  search(tenantId: string, agentName: string, query: string): Promise<MemorySearchResult[]>;
}

export interface MemorySearchResult {
  key: string;
  content: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Evolution System
// ---------------------------------------------------------------------------

export interface EvolutionProposal {
  id: string;
  tenantId: string;
  agentName: string;
  timestamp: string;
  type: "soul_update" | "new_skill" | "config_change" | "workflow_adjustment";
  description: string;
  diff: string;
  status: "pending" | "approved" | "rejected" | "applied";
  confidence: number;
}

// ---------------------------------------------------------------------------
// LLM Provider
// ---------------------------------------------------------------------------

export interface LLMProviderConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelRouterConfig {
  providers: Record<string, {
    apiKey?: string;
    baseUrl?: string;
    /** Vertex AI 专用：GCP project id，未指定时由 service account JSON 自动推导 */
    project?: string;
    /** Vertex AI 专用：region，默认 us-central1 */
    location?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Server Config
// ---------------------------------------------------------------------------

export interface AppConfig {
  server: {
    port: number;
    host: string;
  };
  agents: {
    baseDir: string;
    defaults: Omit<AgentConfig, "allowedTools"> & { allowedTools?: string[], maxTokens?: number, maxIterations?: number };
  };
  memory: {
    store: "file" | "postgres";
    consolidation: {
      enabled: boolean;
      intervalMs: number;
    };
    checkpoint: {
      store: "memory" | "postgres";
      postgresUrl?: string;
      maxMessages?: number;
    };
  };
  llm: {
    retry: {
      maxRetries: number;
    };
    providers: ModelRouterConfig["providers"];
  };
  knowledge?: KnowledgeConfig;
}

// ---------------------------------------------------------------------------
// API Types
// ---------------------------------------------------------------------------

export interface AgentInvokeRequest {
  input: string;
  threadId?: string;
  sessionId?: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tenantId?: string;
}

export interface AgentInvokeAsyncRequest extends AgentInvokeRequest {
  webhookUrl?: string;
}

export interface AgentInvokeResponse {
  threadId: string;
  output: string;
  taskResult: TaskResult;
}

export interface AgentCreateRequest {
  name: string;
  /** Application group (e.g. "video-course"). Agent is created under apps/<group>/<name>/. Defaults to root of apps/. */
  group?: string;
  identity?: string;
  soul?: string;
  mission?: string;
  config?: Partial<AgentConfig>;
}

/** @deprecated Use StreamEvent instead — will be removed after refactor is complete */
export interface AgentStreamEvent {
  type: "token" | "tool_call" | "tool_result" | "sub_agent_spawn" | "sub_agent_complete" | "reflection" | "status" | "done" | "error";
  data: unknown;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Stream Event Protocol v2
// ---------------------------------------------------------------------------

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  model?: string;
}

export const StreamEventType = {
  TASK_STARTED: "task_started",
  TASK_FINISHED: "task_finished",
  DONE: "done",
  PING: "ping",
  NODE_STARTED: "node_started",
  NODE_FINISHED: "node_finished",
  MESSAGE: "message",
  MESSAGE_END: "message_end",
  TOOL_STARTED: "tool_started",
  TOOL_FINISHED: "tool_finished",
  AGENT_STARTED: "agent_started",
  AGENT_MESSAGE: "agent_message",
  AGENT_TOOL_STARTED: "agent_tool_started",
  AGENT_TOOL_FINISHED: "agent_tool_finished",
  AGENT_FINISHED: "agent_finished",
  THINKING: "thinking",
  PROGRESS: "progress",
  ERROR: "error",
} as const;

export type StreamEventTypeName = (typeof StreamEventType)[keyof typeof StreamEventType];

export type NodeType = "perceive" | "think" | "act" | "reflect" | "observe";

export type TaskFinishStatus = "succeeded" | "failed" | "cancelled" | "paused" | "stopped";

// --- Event data subtypes ---

export interface TaskStartedData {
  agent_name: string;
  thread_id?: string;
}

export interface TaskFinishedData {
  status: TaskFinishStatus;
  output?: string;
  outputs?: Record<string, unknown>;
  error?: string;
  elapsed_time: number;
  usage?: TokenUsage;
  metadata?: Record<string, unknown>;
}

export interface NodeStartedData {
  node_type: NodeType;
  iteration: number;
  node_id?: string;
  title?: string;
}

export interface NodeFinishedData {
  node_type: NodeType;
  status: "succeeded" | "failed";
  elapsed_time: number;
  iteration: number;
  usage?: TokenUsage;
  output?: unknown;
  node_id?: string;
  title?: string;
}

export interface MessageData {
  role: "assistant";
  delta: string;
}

export interface MessageEndData {
  role: "assistant";
  content: string;
  usage?: TokenUsage;
}

export interface ToolStartedData {
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ToolFinishedData {
  tool_call_id: string;
  tool_name: string;
  status: "succeeded" | "failed";
  output?: unknown;
  error?: string;
  elapsed_time: number;
  metadata?: Record<string, unknown>;
}

export interface AgentStartedData {
  child_task_id: string;
  parent_task_id: string;
  agent_name: string;
  instruction: string;
  metadata?: Record<string, unknown>;
}

export interface AgentMessageData {
  child_task_id: string;
  agent_name: string;
  delta: string;
}

export interface AgentToolStartedData {
  child_task_id: string;
  agent_name: string;
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AgentToolFinishedData {
  child_task_id: string;
  agent_name: string;
  tool_call_id: string;
  tool_name: string;
  status: "succeeded" | "failed";
  output?: unknown;
  error?: string;
  elapsed_time: number;
  metadata?: Record<string, unknown>;
}

export interface AgentFinishedData {
  child_task_id: string;
  parent_task_id: string;
  agent_name: string;
  status: "succeeded" | "failed";
  output?: unknown;
  error?: string;
  elapsed_time: number;
  usage?: TokenUsage;
  metadata?: Record<string, unknown>;
}

export interface ThinkingData {
  content: string;
}

export interface ProgressData {
  message: string;
  percentage?: number;
  phase?: string;
  metadata?: Record<string, unknown>;
}

export interface ErrorData {
  code: string;
  message: string;
  recoverable: boolean;
}

export type StreamEventDataMap = {
  [StreamEventType.TASK_STARTED]: TaskStartedData;
  [StreamEventType.TASK_FINISHED]: TaskFinishedData;
  [StreamEventType.DONE]: Record<string, never>;
  [StreamEventType.PING]: Record<string, never>;
  [StreamEventType.NODE_STARTED]: NodeStartedData;
  [StreamEventType.NODE_FINISHED]: NodeFinishedData;
  [StreamEventType.MESSAGE]: MessageData;
  [StreamEventType.MESSAGE_END]: MessageEndData;
  [StreamEventType.TOOL_STARTED]: ToolStartedData;
  [StreamEventType.TOOL_FINISHED]: ToolFinishedData;
  [StreamEventType.AGENT_STARTED]: AgentStartedData;
  [StreamEventType.AGENT_MESSAGE]: AgentMessageData;
  [StreamEventType.AGENT_TOOL_STARTED]: AgentToolStartedData;
  [StreamEventType.AGENT_TOOL_FINISHED]: AgentToolFinishedData;
  [StreamEventType.AGENT_FINISHED]: AgentFinishedData;
  [StreamEventType.THINKING]: ThinkingData;
  [StreamEventType.PROGRESS]: ProgressData;
  [StreamEventType.ERROR]: ErrorData;
};

export interface StreamEvent<T extends StreamEventTypeName = StreamEventTypeName> {
  event: T;
  id: number;
  task_id: string;
  session_id: string;
  created_at: number;
  data: T extends keyof StreamEventDataMap ? StreamEventDataMap[T] : Record<string, unknown>;
}
