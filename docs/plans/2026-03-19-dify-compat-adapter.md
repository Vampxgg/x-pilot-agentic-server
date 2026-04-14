# Dify 兼容适配层 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不修改原生 v2 流式事件的前提下，增加 Dify 兼容适配层，使第三方后端可无感切换到本项目。

**Architecture:** 纯适配器模式。`streamAgentV2` 产出的原生 `StreamEvent` 经过 `DifyStreamAdapter` 转换为 Dify 格式事件，再由 `DifySSEWriter` 输出。通过 `.env` 中 `STREAM_PROTOCOL=dify` 全局开关控制。同时新增 Dify 兼容 REST API（会话列表/消息历史/删除会话/停止响应）。

**Tech Stack:** TypeScript, Fastify, Node.js fs (文件存储), SSE

---

## 设计决策摘要

### ID 映射

| Dify 字段 | 来源 |
|---|---|
| `conversation_id` | 原生 `session_id` |
| `message_id` | 原生 `task_id` |
| `task_id`（停止用） | 每次流新生成的独立 UUID |

### 事件映射

| 原生 v2 事件 | Dify 事件 | 说明 |
|---|---|---|
| `task_started` | `workflow_started` | — |
| `node_started(perceive/think/act/observe/reflect)` | `agent_log(label: *_started)` | 收纳进 agent_log |
| `node_finished(perceive/think/act/observe/reflect)` | `agent_log(label: *_finished)` | 收纳进 agent_log |
| `message` | `message` | `thought: false` |
| `message_end` | `message_end` | — |
| `thinking` | `message` | `thought: true` |
| `tool_started` | `agent_log(label: tool_call)` | — |
| `tool_finished` | `agent_log(label: tool_result)` | — |
| `agent_started` | `agent_log(label: sub_agent_started)` | — |
| `agent_message` | `agent_log(label: message)` + `message(from_agent)` | — |
| `agent_tool_started` | `agent_log(label: tool_call)` | — |
| `agent_tool_finished` | `agent_log(label: tool_result)` | — |
| `agent_finished` | `agent_log(label: sub_agent_finished)` | — |
| `progress` | `progress` | 自定义扩展 |
| `error` | `error` | — |
| `ping` | `ping` | — |
| `task_finished` | `workflow_finished` | — |
| `done` | 丢弃 | — |

### 事件流结构

```
workflow_started
├── node_started(type: "agent", node_id, node_execution_id)
│   ├── agent_log(perceive_started)
│   ├── agent_log(perceive_finished)
│   ├── agent_log(think_started)
│   ├── message(delta: "...")
│   ├── agent_log(think_finished)
│   ├── agent_log(act_started)
│   ├── agent_log(tool_call, tool_name: "xxx")
│   ├── agent_log(tool_result, tool_name: "xxx")
│   ├── agent_log(act_finished)
│   ├── agent_log(observe_started)
│   ├── agent_log(observe_finished)
│   ├── agent_log(sub_agent_started, child_execution_id)
│   │   ├── agent_log(perceive_started)  ← node_execution_id = child
│   │   ├── ...
│   │   └── agent_log(reflect_finished)
│   ├── agent_log(sub_agent_finished)
│   ├── agent_log(reflect_started)
│   ├── agent_log(reflect_finished)
│   └──
├── node_finished(type: "agent", node_id, node_execution_id)
workflow_finished
```

### 节点 ID 设计

| 字段 | 含义 | 示例 |
|---|---|---|
| `node_id` | 节点定义标识 | `"agent_document-generator"` |
| `node_execution_id` | 执行实例 ID | `"exec_a1b2c3d4"` |

---

## Task 1: Dify 类型定义

**Files:**
- Create: `src/core/dify/types.ts`

**Step 1: 创建 Dify 事件类型文件**

```typescript
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

// --- 公共信封 ---
export interface DifyEventEnvelope {
  event: DifyEventTypeName;
  task_id: string;          // Dify stop 用，新生成 UUID
  conversation_id: string;  // = 原生 session_id
  message_id: string;       // = 原生 task_id
  created_at: number;       // Unix 秒
}

// --- 各事件 data ---

export interface DifyWorkflowStartedData {
  id: string;
  workflow_run_id: string;
  agent_name: string;
  thread_id?: string;
  created_at: number;
}

export interface DifyWorkflowFinishedData {
  id: string;
  workflow_run_id: string;
  status: "succeeded" | "failed" | "cancelled" | "paused";
  output?: string;
  error?: string;
  elapsed_time: number;
  usage?: TokenUsageCompat;
  metadata?: Record<string, unknown>;
  created_at: number;
}

export type DifyNodeType = "perceive" | "think" | "act" | "reflect" | "observe" | "tool" | "agent";

export interface DifyNodeStartedData {
  id: string;
  node_id: string;
  node_execution_id: string;
  node_type: DifyNodeType;
  title: string;
  parent_id: string;   // 父级 node_execution_id，顶层为 ""
  index: number;
  inputs?: Record<string, unknown>;
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
  status: "succeeded" | "failed";
  outputs?: Record<string, unknown>;
  error?: string;
  elapsed_time: number;
  usage?: TokenUsageCompat;
  created_at: number;
}

export interface DifyMessageData {
  role: "assistant";
  delta: string;
  thought: boolean;
  from_agent?: string;
  parent_id: string;
}

export interface DifyMessageEndData {
  role: "assistant";
  content: string;
  usage?: TokenUsageCompat;
  retriever_resources: unknown[];
  metadata?: Record<string, unknown>;
}

export type AgentLogLabel =
  | "perceive_started" | "perceive_finished"
  | "think_started"    | "think_finished"
  | "act_started"      | "act_finished"
  | "observe_started"  | "observe_finished"
  | "reflect_started"  | "reflect_finished"
  | "tool_call"        | "tool_result"
  | "sub_agent_started" | "sub_agent_finished"
  | "message";

export interface DifyAgentLogData {
  node_id: string;
  node_execution_id: string;
  label: AgentLogLabel;
  agent_name?: string;
  child_execution_id?: string;
  instruction?: string;
  tool_name?: string;
  tool_call_id?: string;
  arguments?: Record<string, unknown>;
  status?: "succeeded" | "failed";
  output?: unknown;
  error?: string;
  delta?: string;
  elapsed_time?: number;
  metadata?: Record<string, unknown>;
}

export interface DifyErrorData {
  code: string;
  message: string;
  status: number;
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

// --- 联合事件类型 ---
export type DifyEvent =
  | (DifyEventEnvelope & { event: "workflow_started";  data: DifyWorkflowStartedData })
  | (DifyEventEnvelope & { event: "workflow_finished"; data: DifyWorkflowFinishedData })
  | (DifyEventEnvelope & { event: "node_started";      data: DifyNodeStartedData })
  | (DifyEventEnvelope & { event: "node_finished";     data: DifyNodeFinishedData })
  | (DifyEventEnvelope & { event: "message";           data: DifyMessageData })
  | (DifyEventEnvelope & { event: "message_end";       data: DifyMessageEndData })
  | (DifyEventEnvelope & { event: "agent_log";         data: DifyAgentLogData })
  | (DifyEventEnvelope & { event: "error";             data: DifyErrorData })
  | (DifyEventEnvelope & { event: "ping" })
  | (DifyEventEnvelope & { event: "progress";          data: DifyProgressData });
```

**Step 2: 确认文件无语法错误**

Run: `npx tsc --noEmit src/core/dify/types.ts`（或整体编译检查）

**Step 3: Commit**

```bash
git add src/core/dify/types.ts
git commit -m "feat(dify): add Dify-compatible event type definitions"
```

---

## Task 2: Dify 流式适配器

**Files:**
- Create: `src/core/dify/stream-adapter.ts`
- Read: `src/core/types.ts` (原生 StreamEvent 定义)
- Read: `src/core/stream-protocol.ts` (StreamContext)

**Step 1: 创建适配器**

核心逻辑：有状态转换器，接收原生 `StreamEvent`，输出 `DifyEvent[]`（一对多映射）。

```typescript
// src/core/dify/stream-adapter.ts
import { randomUUID } from "node:crypto";
import type { StreamEvent, StreamEventTypeName, NodeType } from "../types.js";
import type { DifyEvent, DifyNodeType, AgentLogLabel } from "./types.js";
import { DifyEventType } from "./types.js";

export interface DifyAdapterContext {
  difyTaskId: string;         // 停止用，新生成
  conversationId: string;     // = session_id
  messageId: string;          // = task_id
  workflowRunId: string;      // 新生成
}

interface ExecutionFrame {
  nodeId: string;              // e.g. "agent_document-generator"
  nodeExecutionId: string;     // e.g. "exec_xxxxxxxx"
  parentExecutionId: string;   // 父级的 nodeExecutionId，顶层为 ""
  agentName: string;
}

export class DifyStreamAdapter {
  private ctx: DifyAdapterContext;
  private nodeIndex = 0;
  private executionStack: ExecutionFrame[] = [];
  private rootNodeEmitted = false;

  constructor(sessionId: string, taskId: string) {
    this.ctx = {
      difyTaskId: randomUUID(),
      conversationId: sessionId,
      messageId: taskId,
      workflowRunId: `workflow_run_${randomUUID().slice(0, 8)}`,
    };
  }

  get difyTaskId(): string {
    return this.ctx.difyTaskId;
  }

  get conversationId(): string {
    return this.ctx.conversationId;
  }

  /** 将一个原生 StreamEvent 转换为 0~N 个 DifyEvent */
  transform(event: StreamEvent<StreamEventTypeName>): DifyEvent[] {
    switch (event.event) {
      case "task_started":    return this.onTaskStarted(event);
      case "task_finished":   return this.onTaskFinished(event);
      case "node_started":    return this.onNodeStarted(event);
      case "node_finished":   return this.onNodeFinished(event);
      case "message":         return this.onMessage(event);
      case "message_end":     return this.onMessageEnd(event);
      case "thinking":        return this.onThinking(event);
      case "tool_started":    return this.onToolStarted(event);
      case "tool_finished":   return this.onToolFinished(event);
      case "agent_started":   return this.onAgentStarted(event);
      case "agent_message":   return this.onAgentMessage(event);
      case "agent_tool_started":  return this.onAgentToolStarted(event);
      case "agent_tool_finished": return this.onAgentToolFinished(event);
      case "agent_finished":  return this.onAgentFinished(event);
      case "progress":        return this.onProgress(event);
      case "error":           return this.onError(event);
      case "ping":            return [this.envelope("ping")];
      case "done":            return []; // 丢弃，由 workflow_finished 替代
      default:                return [];
    }
  }

  // --- 私有转换方法 ---
  // 每个方法负责一种原生事件到 Dify 事件的映射。
  // 具体实现要点：
  //
  // onTaskStarted:
  //   1. 发出 workflow_started
  //   2. 发出 node_started(type: "agent")，创建根 ExecutionFrame 压栈
  //
  // onTaskFinished:
  //   1. 发出 node_finished(type: "agent")，弹出根 ExecutionFrame
  //   2. 发出 workflow_finished
  //
  // onNodeStarted(perceive/think/act/observe/reflect):
  //   发出 agent_log(label: "{nodeType}_started")
  //
  // onNodeFinished:
  //   发出 agent_log(label: "{nodeType}_finished")
  //
  // onMessage:
  //   发出 message(thought: false, from_agent: null)
  //
  // onMessageEnd:
  //   发出 message_end
  //
  // onThinking:
  //   发出 message(thought: true)
  //
  // onToolStarted:
  //   发出 agent_log(label: "tool_call")
  //
  // onToolFinished:
  //   发出 agent_log(label: "tool_result")
  //
  // onAgentStarted:
  //   1. 发出 agent_log(label: "sub_agent_started") 归属于父级
  //   2. 创建子 ExecutionFrame 压栈
  //
  // onAgentMessage:
  //   发出 agent_log(label: "message") + message(from_agent: agentName)
  //
  // onAgentToolStarted / onAgentToolFinished:
  //   发出 agent_log(label: "tool_call" / "tool_result") 归属于子 agent
  //
  // onAgentFinished:
  //   1. 弹出子 ExecutionFrame
  //   2. 发出 agent_log(label: "sub_agent_finished") 归属于父级
  //
  // onProgress:
  //   发出 progress（自定义扩展）
  //
  // onError:
  //   发出 error

  // --- 辅助方法 ---
  private envelope(eventType: string, data?: unknown): DifyEvent {
    // 构建公共信封 + data
  }

  private currentFrame(): ExecutionFrame | undefined {
    return this.executionStack[this.executionStack.length - 1];
  }

  private makeAgentLog(label: AgentLogLabel, extra?: Partial<...>): DifyEvent {
    const frame = this.currentFrame();
    // 使用 frame 的 nodeId / nodeExecutionId 填充
  }

  private nextNodeIndex(): number {
    return ++this.nodeIndex;
  }

  private newExecutionId(): string {
    return `exec_${randomUUID().slice(0, 8)}`;
  }
}
```

**关键实现要点：**

1. `executionStack` 维护 agent 嵌套层级，栈顶总是"当前活跃 agent"
2. `task_started` 时自动压入根 agent frame + 发出 `node_started`
3. `agent_started` 时压入子 agent frame，`agent_finished` 弹出
4. 所有 `agent_log` 使用 `currentFrame()` 获取归属的 `node_execution_id`
5. 子 agent 的 `agent_log` 自动使用子 frame 的 ID（因为栈顶已切换）

**Step 2: 编写单元测试**

Run: `npx vitest run src/core/dify/__tests__/stream-adapter.test.ts`

测试用例：
- `task_started` → 产出 `[workflow_started, node_started]`
- `node_started(think)` → 产出 `[agent_log(think_started)]`
- `message` → 产出 `[message(thought: false)]`
- `thinking` → 产出 `[message(thought: true)]`
- `agent_started` → 产出 `[agent_log(sub_agent_started)]`，子 agent 后续事件归属到子 frame
- `agent_finished` → 弹栈 + 产出 `[agent_log(sub_agent_finished)]`
- `task_finished` → 产出 `[node_finished, workflow_finished]`
- `done` → 产出 `[]`

**Step 3: Commit**

```bash
git add src/core/dify/stream-adapter.ts src/core/dify/__tests__/stream-adapter.test.ts
git commit -m "feat(dify): implement DifyStreamAdapter with native-to-dify event transformation"
```

---

## Task 3: Dify SSE Writer

**Files:**
- Create: `src/core/dify/sse-writer.ts`
- Read: `src/core/sse-writer.ts` (原生 SSEWriter 参考)

**Step 1: 创建 DifySSEWriter**

与原生 `SSEWriter` 结构类似，但：
- 接收原生 `StreamEvent`，内部使用 `DifyStreamAdapter` 转换
- 输出 Dify 格式 SSE（`event: xxx\ndata: {...}\n\n`）
- HTTP headers 包含 Dify 兼容的 `X-Task-Id`（Dify task_id）

```typescript
// src/core/dify/sse-writer.ts
import type { ServerResponse } from "node:http";
import type { StreamEvent, StreamEventTypeName } from "../types.js";
import { DifyStreamAdapter } from "./stream-adapter.js";
import { logger } from "../../utils/logger.js";

export interface DifySSEWriterOptions {
  taskId: string;      // 原生 task_id
  sessionId: string;   // 原生 session_id
  heartbeatMs?: number;
}

export class DifySSEWriter {
  private seq = 0;
  private closed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly adapter: DifyStreamAdapter;
  private readonly raw: ServerResponse;

  private constructor(raw: ServerResponse, opts: DifySSEWriterOptions) {
    this.raw = raw;
    this.adapter = new DifyStreamAdapter(opts.sessionId, opts.taskId);

    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Stream-Protocol": "dify",
      "X-Task-Id": this.adapter.difyTaskId,
      "X-Conversation-Id": this.adapter.conversationId,
    });

    raw.on("close", () => {
      this.closed = true;
      this.stopHeartbeat();
    });

    this.startHeartbeat(opts.heartbeatMs ?? 15_000);
  }

  static create(raw: ServerResponse, opts: DifySSEWriterOptions): DifySSEWriter {
    return new DifySSEWriter(raw, opts);
  }

  get isOpen(): boolean { return !this.closed; }
  get difyTaskId(): string { return this.adapter.difyTaskId; }

  /** 接收原生 StreamEvent，转换为 Dify 事件后写出 */
  write<T extends StreamEventTypeName>(event: StreamEvent<T>): boolean {
    if (this.closed) return false;
    const difyEvents = this.adapter.transform(event);
    for (const de of difyEvents) {
      try {
        const id = ++this.seq;
        this.raw.write(`event: ${de.event}\nid: ${id}\ndata: ${JSON.stringify(de)}\n\n`);
      } catch (err) {
        logger.warn(`[DifySSEWriter] Write failed: ${err}`);
        this.closed = true;
        this.stopHeartbeat();
        return false;
      }
    }
    return true;
  }

  end(): void {
    this.stopHeartbeat();
    if (!this.closed) {
      this.closed = true;
      try { this.raw.end(); } catch { /* already closed */ }
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) { this.stopHeartbeat(); return; }
      try {
        this.raw.write(`event: ping\ndata: {}\n\n`);
      } catch { this.closed = true; this.stopHeartbeat(); }
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
```

**Step 2: Commit**

```bash
git add src/core/dify/sse-writer.ts
git commit -m "feat(dify): add DifySSEWriter with automatic event transformation"
```

---

## Task 4: 运行中流注册表（停止响应用）

**Files:**
- Create: `src/core/dify/stream-registry.ts`

**Step 1: 创建 StreamRegistry**

用于停止响应：将 Dify `task_id` 映射到 `AbortController`，stop 接口调用时 abort。

```typescript
// src/core/dify/stream-registry.ts

class RunningStreamRegistry {
  private streams = new Map<string, {
    abort: AbortController;
    conversationId: string;
    messageId: string;
    userId: string;
    startedAt: number;
  }>();

  register(difyTaskId: string, info: {
    abort: AbortController;
    conversationId: string;
    messageId: string;
    userId: string;
  }): void { /* ... */ }

  stop(difyTaskId: string, userId: string): boolean {
    const entry = this.streams.get(difyTaskId);
    if (!entry || entry.userId !== userId) return false;
    entry.abort.abort();
    this.streams.delete(difyTaskId);
    return true;
  }

  unregister(difyTaskId: string): void {
    this.streams.delete(difyTaskId);
  }

  // 定期清理超时条目（10 分钟无活动）
  cleanup(): void { /* ... */ }
}

export const runningStreamRegistry = new RunningStreamRegistry();
```

**Step 2: Commit**

```bash
git add src/core/dify/stream-registry.ts
git commit -m "feat(dify): add RunningStreamRegistry for stop-response support"
```

---

## Task 5: 会话/消息持久化存储

**Files:**
- Create: `src/core/dify/conversation-store.ts`
- Read: `src/core/workspace.ts` (参考文件存储模式)

**Step 1: 创建 ConversationStore**

基于文件系统，存储在 `data/tenants/{tenantId}/users/{userId}/conversations/` 目录下。

```typescript
// src/core/dify/conversation-store.ts

export interface ConversationRecord {
  id: string;           // = session_id
  name: string;         // 由请求中 topic/prompt 生成
  inputs: Record<string, unknown>;
  status: "normal" | "archived";
  introduction: string;
  created_at: number;   // Unix 秒
  updated_at: number;
}

export interface MessageRecord {
  id: string;            // = task_id
  conversation_id: string;
  parent_message_id: string;
  inputs: Record<string, unknown>;
  query: string;
  answer: string;
  feedback: null;
  retriever_resources: unknown[];
  created_at: number;
  agent_thoughts: unknown[];
  message_files: unknown[];
  status: "normal" | "error";
  error: string | null;
}

export class ConversationStore {
  // 数据结构：
  //   data/tenants/{tenantId}/users/{userId}/conversations/index.json
  //     → ConversationRecord[]
  //   data/tenants/{tenantId}/users/{userId}/conversations/{conversationId}/messages.json
  //     → MessageRecord[]

  async listConversations(tenantId: string, userId: string, opts?: {
    limit?: number; firstId?: string;
  }): Promise<{ data: ConversationRecord[]; has_more: boolean; limit: number }> { /* ... */ }

  async getOrCreateConversation(tenantId: string, userId: string, sessionId: string, meta: {
    name: string; inputs: Record<string, unknown>;
  }): Promise<ConversationRecord> { /* ... */ }

  async deleteConversation(tenantId: string, userId: string, conversationId: string): Promise<boolean> { /* ... */ }

  async listMessages(tenantId: string, userId: string, conversationId: string, opts?: {
    limit?: number; firstId?: string;
  }): Promise<{ data: MessageRecord[]; has_more: boolean; limit: number }> { /* ... */ }

  async appendMessage(tenantId: string, userId: string, msg: MessageRecord): Promise<void> { /* ... */ }

  async updateMessageAnswer(tenantId: string, userId: string,
    conversationId: string, messageId: string, answer: string): Promise<void> { /* ... */ }
}

export const conversationStore = new ConversationStore();
```

**Step 2: Commit**

```bash
git add src/core/dify/conversation-store.ts
git commit -m "feat(dify): add file-based ConversationStore for Dify-compat REST APIs"
```

---

## Task 6: 环境配置集成

**Files:**
- Modify: `.env` — 添加 `STREAM_PROTOCOL` 变量
- Modify: `src/utils/config.ts` — 读取并暴露配置
- Create: `src/core/dify/index.ts` — 统一导出

**Step 1: 在 `.env` 添加配置**

在 `.env` 文件末尾追加：

```
# Stream Protocol: "native" (default) or "dify" (Dify-compatible adapter)
STREAM_PROTOCOL=dify
```

**Step 2: 在 config 中读取**

在 `src/utils/config.ts` 中增加：

```typescript
streamProtocol: (process.env.STREAM_PROTOCOL ?? "native") as "native" | "dify",
```

**Step 3: 创建 `src/core/dify/index.ts` 统一导出**

```typescript
export { DifyStreamAdapter } from "./stream-adapter.js";
export { DifySSEWriter } from "./sse-writer.js";
export { runningStreamRegistry } from "./stream-registry.js";
export { conversationStore } from "./conversation-store.js";
export * from "./types.js";
```

**Step 4: Commit**

```bash
git add .env src/utils/config.ts src/core/dify/index.ts
git commit -m "feat(dify): add STREAM_PROTOCOL env config and dify module barrel export"
```

---

## Task 7: 创建 Stream Writer 工厂函数

**Files:**
- Create: `src/core/stream-writer-factory.ts`

**Step 1: 创建工厂函数**

统一入口，根据 `STREAM_PROTOCOL` 配置返回不同的 writer。两个 writer 都实现相同的接口：`write(event)` 和 `end()`。

```typescript
// src/core/stream-writer-factory.ts
import type { ServerResponse } from "node:http";
import type { StreamEvent, StreamEventTypeName } from "./types.js";
import { SSEWriter } from "./sse-writer.js";
import { DifySSEWriter } from "./dify/sse-writer.js";
import { runningStreamRegistry } from "./dify/stream-registry.js";

export interface UnifiedStreamWriter {
  readonly isOpen: boolean;
  readonly streamContext: { taskId: string; sessionId: string };
  write<T extends StreamEventTypeName>(event: StreamEvent<T>): boolean;
  end(): void;
}

export function createStreamWriter(
  raw: ServerResponse,
  opts: { taskId: string; sessionId: string; userId?: string },
): UnifiedStreamWriter {
  const protocol = process.env.STREAM_PROTOCOL ?? "native";

  if (protocol === "dify") {
    const writer = DifySSEWriter.create(raw, {
      taskId: opts.taskId,
      sessionId: opts.sessionId,
    });

    // 注册到 stream registry 以支持 stop
    if (opts.userId) {
      const abort = new AbortController();
      runningStreamRegistry.register(writer.difyTaskId, {
        abort,
        conversationId: opts.sessionId,
        messageId: opts.taskId,
        userId: opts.userId,
      });
    }

    return {
      get isOpen() { return writer.isOpen; },
      get streamContext() { return { taskId: opts.taskId, sessionId: opts.sessionId }; },
      write: (event) => writer.write(event),
      end: () => {
        runningStreamRegistry.unregister(writer.difyTaskId);
        writer.end();
      },
    };
  }

  // 原生模式
  const writer = SSEWriter.create(raw, opts);
  return {
    get isOpen() { return writer.isOpen; },
    get streamContext() { return writer.streamContext; },
    write: (event) => writer.write(event),
    end: () => writer.end(),
  };
}
```

**Step 2: Commit**

```bash
git add src/core/stream-writer-factory.ts
git commit -m "feat(dify): add createStreamWriter factory for native/dify protocol switching"
```

---

## Task 8: 集成到现有路由

**Files:**
- Modify: `apps/document-generation/code/routes.ts:268-329` — 替换 SSEWriter 为工厂函数
- Modify: `apps/video-course/code/routes.ts` — 同理
- Modify: `apps/sim-training/code/routes.ts` — 同理

**Step 1: 修改 document-generation 路由**

将 `routes.ts` 中的：

```typescript
import { SSEWriter } from "../../../src/core/sse-writer.js";
```

替换为：

```typescript
import { createStreamWriter, type UnifiedStreamWriter } from "../../../src/core/stream-writer-factory.js";
```

将创建 writer 的代码：

```typescript
writer = SSEWriter.create(reply.raw, {
  taskId: event.task_id,
  sessionId: event.session_id,
});
```

替换为：

```typescript
writer = createStreamWriter(reply.raw, {
  taskId: event.task_id,
  sessionId: event.session_id,
  userId,
});
```

同时在 Dify 模式下，在流开始前调用 `conversationStore.getOrCreateConversation()`，
在流结束后调用 `conversationStore.appendMessage()` 保存消息记录。

**Step 2: 对 video-course 和 sim-training 做同样修改**

**Step 3: 运行测试确认不影响现有功能**

**Step 4: Commit**

```bash
git add apps/document-generation/code/routes.ts apps/video-course/code/routes.ts apps/sim-training/code/routes.ts
git commit -m "feat(dify): integrate stream writer factory into all business routes"
```

---

## Task 9: Dify 兼容 REST API 路由

**Files:**
- Create: `src/api/routes/dify-compat.routes.ts`
- Modify: `src/api/server.ts` — 注册新路由

**Step 1: 创建 Dify REST 路由**

```typescript
// src/api/routes/dify-compat.routes.ts
import type { FastifyInstance } from "fastify";
import { getTenantId, getUserId } from "../middleware/auth.js";
import { conversationStore } from "../../core/dify/conversation-store.js";
import { runningStreamRegistry } from "../../core/dify/stream-registry.js";

export function registerDifyCompatRoutes(app: FastifyInstance): void {

  // GET /v1/conversations
  app.get("/v1/conversations", async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const { limit, first_id } = request.query as { limit?: string; first_id?: string };
    return conversationStore.listConversations(tenantId, userId, {
      limit: Number(limit) || 20,
      firstId: first_id,
    });
  });

  // GET /v1/messages
  app.get("/v1/messages", async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const { conversation_id, limit, first_id } = request.query as {
      conversation_id: string; limit?: string; first_id?: string;
    };
    if (!conversation_id) return reply.code(400).send({ error: "conversation_id is required" });
    return conversationStore.listMessages(tenantId, userId, conversation_id, {
      limit: Number(limit) || 20,
      firstId: first_id,
    });
  });

  // DELETE /v1/conversations/:id
  app.delete("/v1/conversations/:id", async (request, reply) => {
    const tenantId = getTenantId(request);
    const userId = getUserId(request);
    const { id } = request.params as { id: string };
    const ok = await conversationStore.deleteConversation(tenantId, userId, id);
    if (!ok) return reply.code(404).send({ error: "Conversation not found" });
    return { result: "success" };
  });

  // POST /v1/chat-messages/:task_id/stop
  app.post("/v1/chat-messages/:task_id/stop", async (request, reply) => {
    const userId = getUserId(request);
    const { task_id } = request.params as { task_id: string };
    const ok = runningStreamRegistry.stop(task_id, userId);
    if (!ok) return reply.code(404).send({ error: "Task not found or already stopped" });
    return { result: "success" };
  });
}
```

**Step 2: 在 server.ts 中注册**

在 `src/api/server.ts` 中添加：

```typescript
import { registerDifyCompatRoutes } from "./routes/dify-compat.routes.js";

// 在 routeRegistry.applyAll(app) 之后
const streamProtocol = process.env.STREAM_PROTOCOL ?? "native";
if (streamProtocol === "dify") {
  registerDifyCompatRoutes(app);
}
```

**Step 3: Commit**

```bash
git add src/api/routes/dify-compat.routes.ts src/api/server.ts
git commit -m "feat(dify): add Dify-compat REST routes (conversations, messages, stop)"
```

---

## Task 10: AbortController 集成到流式消费循环

**Files:**
- Modify: `apps/document-generation/code/routes.ts` — 在流消费循环中检查 abort 信号
- Modify: `apps/video-course/code/routes.ts` — 同理
- Modify: `apps/sim-training/code/routes.ts` — 同理

**Step 1: 修改流消费循环**

在 `for await (const event of stream)` 循环中增加 abort 检查：

```typescript
const abortCtrl = new AbortController();
// 注册 abortCtrl 到 runningStreamRegistry（在 createStreamWriter 内部完成）

for await (const event of stream) {
  if (abortCtrl.signal.aborted) {
    // 发送 workflow_finished(status: "cancelled") 后退出
    break;
  }
  if (!writer) { /* 创建 writer */ }
  if (!writer.isOpen) break;
  // ... 写事件 ...
}
```

注意：`AbortController` 需要从 `createStreamWriter` 的返回值中暴露出来，
或者 `createStreamWriter` 返回一个 `abortSignal` 属性。

**Step 2: Commit**

```bash
git add apps/document-generation/code/routes.ts apps/video-course/code/routes.ts apps/sim-training/code/routes.ts
git commit -m "feat(dify): integrate abort signal for stop-response support in stream loops"
```

---

## Task 11: 会话记录写入集成

**Files:**
- Modify: `apps/document-generation/code/routes.ts` — 在流开始/结束时写入会话和消息记录

**Step 1: 集成 conversationStore**

在流式路由中：

```typescript
import { conversationStore } from "../../../src/core/dify/conversation-store.js";

// 流开始前
if (process.env.STREAM_PROTOCOL === "dify") {
  await conversationStore.getOrCreateConversation(tenantId, userId, sessionId, {
    name: body.select_knowledge_unit ?? "未命名会话",
    inputs: body as unknown as Record<string, unknown>,
  });
}

// 流结束后，在 writer.end() 之前
if (process.env.STREAM_PROTOCOL === "dify") {
  await conversationStore.appendMessage(tenantId, userId, {
    id: taskId,
    conversation_id: sessionId,
    parent_message_id: "00000000-0000-0000-0000-000000000000",
    inputs: body as unknown as Record<string, unknown>,
    query: body.prompt ?? "",
    answer: accumulatedAnswer,  // 流中累积的完整回复
    feedback: null,
    retriever_resources: [],
    created_at: Math.floor(Date.now() / 1000),
    agent_thoughts: [],
    message_files: [],
    status: "normal",
    error: null,
  });
}
```

**Step 2: 对 video-course 和 sim-training 做同样集成**

**Step 3: Commit**

```bash
git add apps/document-generation/code/routes.ts apps/video-course/code/routes.ts apps/sim-training/code/routes.ts
git commit -m "feat(dify): persist conversation and message records on stream completion"
```

---

## Task 12: 更新 OpenAPI 文档

**Files:**
- Modify: `docs/apifox-openapi.yaml` — 添加 Dify 兼容 REST API 定义

**Step 1: 添加 4 个 Dify REST 接口到 OpenAPI 文档**

- `GET /v1/conversations`
- `GET /v1/messages`
- `DELETE /v1/conversations/{id}`
- `POST /v1/chat-messages/{task_id}/stop`

每个接口包含完整的请求参数和响应示例。

**Step 2: Commit**

```bash
git add docs/apifox-openapi.yaml
git commit -m "docs: add Dify-compat REST API definitions to OpenAPI spec"
```

---

## Task 13: 端到端测试

**Step 1: 启动服务**

确认 `.env` 中 `STREAM_PROTOCOL=dify`，运行 `npm run dev`。

**Step 2: 测试 SSE 流式输出**

```bash
curl -N -X POST http://192.168.50.54:7800/api/business/document-generation/generate-stream \
  -H "Authorization: Bearer x-pilot-default-key" \
  -H "Content-Type: application/json" \
  -d '{"select_knowledge_unit":"测试主题","prompt":"简短测试","sessionId":"e2e-test-001"}'
```

验证：
- 第一个事件是 `workflow_started`（不是 `task_started`）
- 包含 `task_id`、`conversation_id`、`message_id` 字段
- agent 内部步骤以 `agent_log` 形式出现
- 文本以 `message` 事件输出
- 最后一个有效事件是 `workflow_finished`

**Step 3: 测试 REST API**

```bash
# 获取会话列表
curl http://192.168.50.54:7800/v1/conversations?user=default \
  -H "Authorization: Bearer x-pilot-default-key"

# 获取消息历史
curl "http://192.168.50.54:7800/v1/messages?conversation_id=e2e-test-001&user=default" \
  -H "Authorization: Bearer x-pilot-default-key"

# 删除会话
curl -X DELETE http://192.168.50.54:7800/v1/conversations/e2e-test-001 \
  -H "Authorization: Bearer x-pilot-default-key" \
  -H "Content-Type: application/json" \
  -d '{"user":"default"}'
```

**Step 4: 测试 native 模式回退**

将 `.env` 中 `STREAM_PROTOCOL=native`，重启，确认原有行为不变。

**Step 5: Commit**

```bash
git commit -m "test: verify Dify-compat adapter end-to-end"
```

---

## 文件清单

| 操作 | 文件路径 |
|---|---|
| **Create** | `src/core/dify/types.ts` |
| **Create** | `src/core/dify/stream-adapter.ts` |
| **Create** | `src/core/dify/sse-writer.ts` |
| **Create** | `src/core/dify/stream-registry.ts` |
| **Create** | `src/core/dify/conversation-store.ts` |
| **Create** | `src/core/dify/index.ts` |
| **Create** | `src/core/stream-writer-factory.ts` |
| **Create** | `src/api/routes/dify-compat.routes.ts` |
| **Modify** | `.env` |
| **Modify** | `src/utils/config.ts` |
| **Modify** | `src/api/server.ts` |
| **Modify** | `apps/document-generation/code/routes.ts` |
| **Modify** | `apps/video-course/code/routes.ts` |
| **Modify** | `apps/sim-training/code/routes.ts` |
| **Modify** | `docs/apifox-openapi.yaml` |
