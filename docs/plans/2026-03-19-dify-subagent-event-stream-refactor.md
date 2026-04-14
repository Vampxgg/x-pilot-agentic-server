# Dify 兼容事件流完整改造 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 SSE 事件流改造为完全符合用户设计文档 `sse事件流式.txt` 的 Dify 兼容格式，支持 ROUND 分组、step/label 分离、sub-agent 透明嵌套、固定 `node_id` 和统一的 `data`/`error` 字段。

**Architecture:** DifyStreamAdapter 作为唯一的原生→Dify 事件转换层，在收到原生 `StreamEvent` 后映射为精确到字段的 Dify 事件。SubAgentManager 的 `forwardChildEvent` 扩展为转发子 agent 全部内部事件（node_started/node_finished 等），DifyStreamAdapter 通过 ExecutionFrame 栈维护父子关系和 `parent_id` 链路。Routes 层只负责 message 累积和 outputs 注入，不做事件结构变换。

**Tech Stack:** TypeScript, LangGraph (messages+updates stream mode), Fastify SSE, Dify SSE protocol

---

## 现状分析

### 当前实现的核心问题

1. **`node_id` 使用 `agent_` 前缀拼接**：如 `agent_document-generator`，应改为硬编码的纯数字字符串（如 `"11179223255"`），模拟 Dify 的节点数据库 ID
2. **缺少 ROUND 分组事件**：当前无 `ROUND N` agent_log 事件来分组每轮 ReAct 迭代
3. **`node_execution_id` 不等于 `node_id`**：用户设计要求主 agent 的 `node_execution_id` 与 `node_id` 一致（因为主 agent 只有一个实例）
4. **缺少统一的 `data` 和 `error` 字段**：agent_log 事件的外层 `data` 是 SSE 事件体，内层 `data` 是事件载荷（`data.data` 双层是正确设计）。`output` 应在外层 `data.output`，而非 `data.data.output`。`error` 统一存在（默认 `null`）
5. **缺少 `step` 字段**：agent_log 只有 `label`，缺少独立的 `step` 字段
6. **`label` 语义不统一**：think_finished 的 label 应为 `"模型名称 Thought"`，tool_call 的 label 应为 `"CALL <tool_name>"`
7. **Sub-agent 事件未完整转发**：`forwardChildEvent` 只转发 message/tool_started/tool_finished，丢失了子 agent 的 node_started/node_finished（即子 agent 的 perceive/think/act/observe/reflect）
8. **Sub-agent 没有独立的 `node_id`**：子 agent 应有自己的固定 `node_id`（如 `"22280334411"`），和自己的 `node_execution_id`
9. **message 事件缺少 `parent_id`**：message 需要 `parent_id` 字段标识输出来源
10. **workflow_started 缺少 `inputs`、`sys.query`、`sys.user_id`、`sys.tenant_id`** 字段（且 sys 字段应在 inputs 内部）

### 嵌套结构澄清（关键）

- **`data.data` 双层嵌套是正确的**：外层 `data` 是 SSE 事件的数据体，内层 `data` 是 agent_log 事件自身的载荷字段。
- **`data.data.output` 三层嵌套也是正确的**：工具调用结果放在内层 data 的 output 子对象中。
- **`data.output`（外层）**：阶段级输出（think/reflect 的完整文本），与 `data.data.output`（工具结果）是不同层级。
- 具体结构：

  **工具调用结果 — `data.data.output`**：
  ```
  {
    "event": "agent_log",
    "data": {                          ← 外层 data (SSE 事件体)
      "id": "...",
      "label": "CALL emit_event",
      "step": "act",
      "status": "succeeded",
      "node_type": "tool",
      "data": {                        ← 内层 data (事件载荷)
        "output": {                    ← data.data.output (工具结果)
          "tool_call_id": "...",
          "tool_call_name": "emit_event",
          "tool_call_input": {...},
          "tool_response": "{...}"
        }
      },
      "error": null,
      "elapsed_time": 0.001
    }
  }
  ```

  **阶段输出 — `data.output`**：
  ```
  {
    "event": "agent_log",
    "data": {                          ← 外层 data
      "id": "...",
      "label": "deepseek-v3 Thought",
      "step": "think",
      "status": "succeeded",
      "data": {},                      ← 内层 data (think 无特殊载荷)
      "error": null,
      "output": "我需要搜索知识库...",  ← data.output (LLM 完整 blocking 结果)
      "elapsed_time": 12.375
    }
  }
  ```

### 流式输出 vs 非流式输出（关键规则）

| 场景 | message 事件 | think succeeded 的 output |
|------|-------------|--------------------------|
| 流式（streamMode: messages+updates） | **有**：think 阶段实时产出 message 事件（打字机效果） | **必须有**：完整 blocking 结果 |
| 非流式（streamMode: updates only） | **无**：不产出 message 事件 | **必须有**：完整 blocking 结果 |

- 即：**无论是否流式，think succeeded 的 `data.output` 都必须包含 LLM 的完整输出文本**。
- 流式模式下，message 事件是实时逐 token 推送，think succeeded 的 output 是最终汇总。
- sub-agent 同理：如果 sub-agent 流式输出，产出 message 事件（parent_id 指向子 agent）；如果非流式，无 message 但 think succeeded 仍有完整 output。

### 涉及文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/core/dify/types.ts` | **修改** | 新增/调整字段定义 |
| `src/core/dify/stream-adapter.ts` | **重写** | 核心改造：ROUND、step/label 分离、sub-agent 嵌套 |
| `src/core/dify/sse-writer.ts` | **修改** | 传递额外上下文 (inputs, query, user_id) |
| `src/core/sub-agent-manager.ts` | **修改** | 扩展 forwardChildEvent 转发全部子事件 |
| `src/core/types.ts` | **修改** | NodeStartedData / NodeFinishedData 补充 iteration |
| `src/core/stream-protocol.ts` | **微调** | 确保 node 事件携带 iteration |
| `src/core/agent-runtime.ts` | **微调** | 确保 node 事件携带正确的 iteration |
| `apps/document-generation/code/routes.ts` | **修改** | message 的 parent_id、inputs 传递 |
| `apps/video-course/code/routes.ts` | **待办** | 迁移 streamAgent→streamAgentV2 |
| `apps/sim-training/code/routes.ts` | **待办** | 迁移 streamAgent→streamAgentV2 |
| `docs/dify-event-stream-spec.md` | **更新** | 同步文档 |

---

## Task 1: 类型系统改造 — `src/core/dify/types.ts`

**Files:**
- Modify: `src/core/dify/types.ts`

**Step 1: 添加新字段和调整 agent_log 结构**

将 `DifyAgentLogData` 完全重构为符合用户设计的字段集：

```typescript
export type AgentLogLabel = string;
// label 是动态的：
// - "ROUND 1", "ROUND 2" — 轮次标记
// - "perceive", "think", "observe", "reflect" — 阶段 started/finished
// - "模型名称 Thought" — think finished 特殊 label
// - "CALL <tool_name>" — 工具调用
// - "<agent_name>" — sub-agent 调用
// step 是固定阶段名："perceive"|"think"|"act"|"observe"|"reflect"|"round"

export type AgentLogStep = "perceive" | "think" | "act" | "observe" | "reflect" | "round";
export type AgentLogStatus = "started" | "succeeded" | "failed" | "stopped";

export interface DifyAgentLogData {
  id: string;                    // 每个 agent_log 独立 UUID
  node_id: string;               // 固定节点 ID (数字字符串)
  node_execution_id: string;     // 执行实例 ID
  parent_id: string | null;      // ROUND 事件的 id，或父 agent 的 act 事件 id
  label: string;                 // 人类可读标签
  step: AgentLogStep;            // 固定阶段名
  status: AgentLogStatus;        // 状态
  node_type?: string;            // "tool" | "agent" (仅 act 阶段)
  data: Record<string, unknown>; // 统一扩展数据，默认 {}
  error: string | null;          // 统一错误字段，默认 null
  output?: unknown;              // finished 时的输出
  elapsed_time?: number;         // finished 时的耗时
}
```

**Step 2: 调整 workflow_started 数据**

> **重要**：`sys.query`、`sys.user_id`、`sys.tenant_id` 全部在 `inputs` 对象内部，而非顶层字段。

```typescript
export interface DifyWorkflowStartedData {
  id: string;
  workflow_run_id: string;
  agent_name: string;
  inputs: Record<string, unknown>;  // 包含业务参数 + sys.query + sys.user_id + sys.tenant_id
  thread_id?: string;
  created_at: number;
}
// inputs 示例:
// {
//   "select_knowledge_unit": "电子电工原理...",
//   "prompt": "图片不少于10张",
//   "database_id": "53bc2550-...",
//   "sys.query": "图片不少于10张",
//   "sys.user_id": "20201011",
//   "sys.tenant_id": "default"
// }
```

**Step 3: 调整 node_started/node_finished 添加 `inputs` 字段**

```typescript
export interface DifyNodeStartedData {
  id: string;
  node_id: string;
  node_execution_id: string;
  node_type: DifyNodeType;
  title: string;
  inputs: Record<string, unknown> | null;  // 新增
  parent_id: string;
  index: number;
  created_at: number;
}

export interface DifyNodeFinishedData {
  // ... 同上 + inputs 字段
  inputs: Record<string, unknown> | null;  // 新增
}
```

**Step 4: message 事件添加 `parent_id`**

```typescript
// DifyEvent union 中 message 分支:
| (DifyEventEnvelope & { event: "message"; id: string; answer: string; parent_id: string | null })
```

**Step 5: 编译检查**

Run: `npx tsc --noEmit --pretty 2>&1 | head -50`
Expected: 只有 stream-adapter.ts 等依赖方报错（字段缺失），types 本身无错误

**Step 6: Commit**

```bash
git add src/core/dify/types.ts
git commit -m "refactor(dify/types): align DifyAgentLogData with sse事件流式 spec — add id, step, parent_id, data, error fields"
```

---

## Task 2: DifyStreamAdapter 核心重写 — `src/core/dify/stream-adapter.ts`

**Files:**
- Modify: `src/core/dify/stream-adapter.ts`

这是本次改造最大的 Task。需要改造 adapter 以支持：
- ROUND 分组
- 固定 `node_id`（数字字符串而非 `agent_` 前缀）
- `step` 与 `label` 分离
- sub-agent 嵌套上下文
- 每个 agent_log 独立 `id`
- 统一 `data: {}` 和 `error: null`

### Step 1: 重构 ExecutionFrame 和内部状态

```typescript
interface ExecutionFrame {
  nodeId: string;              // 固定节点 ID (数字字符串)
  nodeExecutionId: string;     // 执行实例 ID
  parentExecutionId: string;   // 父执行 ID
  agentName: string;
  startTime: number;
  currentRoundId: string;      // 当前 ROUND 的 agent_log id
  currentRound: number;        // 当前轮次
  isSubAgent: boolean;         // 是否为子 agent
}

// Adapter 内部新增：
private nodeIdCounter = BigInt(Date.now());  // 生成固定 node_id
private inputContext: {                      // 存储 workflow 上下文
  inputs: Record<string, unknown>;
  query: string;
  userId: string;
  tenantId: string;
} = { inputs: {}, query: "", userId: "", tenantId: "" };
```

### Step 2: 修改 constructor，接收上下文信息

```typescript
constructor(
  sessionId: string,
  taskId: string,
  context?: {
    inputs?: Record<string, unknown>;
    query?: string;
    userId?: string;
    tenantId?: string;
  }
)
```

### Step 3: 修改 `makeNodeId` — 生成数字字符串

```typescript
private makeNodeId(_agentName: string): string {
  return String(this.nodeIdCounter++);
}
```

### Step 4: 重写 `onTaskStarted` — inputs 包含 sys 字段

> **重要**：`sys.query`、`sys.user_id`、`sys.tenant_id` 全部合并到 `inputs` 对象内部。

```typescript
private onTaskStarted(data: TaskStartedData, ts: number): DifyEvent[] {
  const nodeId = this.makeNodeId(data.agent_name);

  this.executionStack.push({
    nodeId,
    nodeExecutionId: nodeId, // 主 agent: exec_id == node_id
    parentExecutionId: "",
    agentName: data.agent_name,
    startTime: ts,
    currentRoundId: "",
    currentRound: 0,
    isSubAgent: false,
  });

  // sys 字段合并入 inputs
  const inputs = {
    ...this.inputContext.inputs,
    "sys.query": this.inputContext.query,
    "sys.user_id": this.inputContext.userId,
    "sys.tenant_id": this.inputContext.tenantId,
  };

  return [
    // workflow_started
    {
      ...this.envelope(ts),
      event: DifyEventType.WORKFLOW_STARTED,
      data: {
        id: this.ctx.workflowRunId,
        workflow_run_id: this.ctx.workflowRunId,
        agent_name: data.agent_name,
        inputs,
        thread_id: data.thread_id,
        created_at: ts,
      },
    },
    // node_started (root agent)
    {
      ...this.envelope(ts),
      event: DifyEventType.NODE_STARTED,
      data: {
        id: nodeId,
        node_id: nodeId,
        node_execution_id: nodeId,
        node_type: "agent",
        title: data.agent_name,
        inputs: null,
        parent_id: "",
        index: this.nextIndex(),
        created_at: ts,
      },
    },
  ];
}
```

### Step 5: 重写 `onNodeStarted` — ROUND 管理 + step/label 分离

核心逻辑：
- 当收到 `perceive` 的 node_started 且当前无 ROUND 或本轮已完成 → 发射新的 `ROUND N` agent_log(started)
- 每个阶段事件的 `parent_id` 指向当前 ROUND 的 `id`

```typescript
private onNodeStarted(data: NodeStartedData, ts: number): DifyEvent[] {
  const frame = this.currentFrame();
  if (!frame) return [];
  const events: DifyEvent[] = [];

  const step = data.node_type as AgentLogStep;

  // 新 ROUND 检测：perceive 开始意味着新迭代
  if (step === "perceive") {
    frame.currentRound++;
    const roundId = randomUUID();
    frame.currentRoundId = roundId;

    events.push(this.buildAgentLog(frame, {
      id: roundId,
      label: `ROUND ${frame.currentRound}`,
      step: "round",
      status: "started",
      parentId: null,
    }, ts));
  }

  // 阶段 started 事件
  events.push(this.buildAgentLog(frame, {
    id: randomUUID(),
    label: step,
    step,
    status: "started",
    parentId: frame.currentRoundId || null,
  }, ts));

  return events;
}
```

### Step 6: 重写 `onNodeFinished` — 分阶段处理 label

```typescript
private onNodeFinished(data: NodeFinishedData, ts: number): DifyEvent[] {
  const frame = this.currentFrame();
  if (!frame) return [];

  const step = data.node_type as AgentLogStep;
  let label: string = step;

  // think finished 使用特殊 label "模型名称 Thought"
  if (step === "think") {
    label = `${this.getModelName()} Thought`;
  }

  return [
    this.buildAgentLog(frame, {
      id: randomUUID(),
      label,
      step,
      status: (data.status as AgentLogStatus) || "succeeded",
      parentId: frame.currentRoundId || null,
      output: data.output ?? "",
      elapsed_time: data.elapsed_time,
    }, ts),
  ];
}
```

### Step 7: 重写 `onToolStarted` / `onToolFinished` — CALL label

```typescript
private onToolStarted(data: ToolStartedData, ts: number): DifyEvent[] {
  const frame = this.currentFrame();
  return [
    this.buildAgentLog(frame, {
      id: randomUUID(),
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

// > **重要**：工具结果放在 data.data.output（三层嵌套是正确的）。
// > data.data.output 包含 tool_call_id, tool_call_name, tool_call_input, tool_response。
private onToolFinished(data: ToolFinishedData, ts: number): DifyEvent[] {
  const frame = this.currentFrame();
  return [
    this.buildAgentLog(frame, {
      id: randomUUID(),
      label: `CALL ${data.tool_name}`,
      step: "act",
      status: data.status as AgentLogStatus,
      parentId: frame?.currentRoundId || null,
      nodeType: "tool",
      data: {
        output: {  // ← data.data.output (工具结果)
          tool_call_id: data.tool_call_id,
          tool_call_name: data.tool_name,
          tool_call_input: data.arguments,
          tool_response: typeof data.output === "string" ? data.output : JSON.stringify(data.output),
        },
      },
      error: data.error || null,
      elapsed_time: data.elapsed_time,
    }, ts),
  ];
}
```

### Step 8: 重写 sub-agent 处理 — `onAgentStarted` / `onAgentFinished`

```typescript
private onAgentStarted(data: AgentStartedData, ts: number): DifyEvent[] {
  const parentFrame = this.currentFrame();
  const childNodeId = this.makeNodeId(data.agent_name);
  const childExecId = `${data.agent_name}_${randomUUID().slice(0, 17)}`;

  const actEventId = randomUUID();

  // 发射 act/started [agent] 事件
  const events: DifyEvent[] = [
    this.buildAgentLog(parentFrame, {
      id: actEventId,
      label: data.agent_name,
      step: "act",
      status: "started",
      parentId: parentFrame?.currentRoundId || null,
      nodeType: "agent",
      data: {
        agent_name: data.agent_name,
        agent_name_id: childExecId,
        agent_input: { instruction: data.instruction },
      },
    }, ts),
  ];

  // 子 agent 压栈
  this.executionStack.push({
    nodeId: childNodeId,
    nodeExecutionId: childExecId,
    parentExecutionId: parentFrame?.nodeExecutionId ?? "",
    agentName: data.agent_name,
    startTime: ts,
    currentRoundId: "",
    currentRound: 0,
    isSubAgent: true,
  });

  return events;
}
```

### Step 9: 重写 `onAgentMessage` — message 携带 parent_id

```typescript
private onAgentMessage(data: AgentMessageData, ts: number): DifyEvent[] {
  const childFrame = this.currentFrame();
  return [
    {
      ...this.envelope(ts),
      event: DifyEventType.MESSAGE,
      id: this.ctx.messageId,
      answer: data.delta,
      parent_id: childFrame?.nodeExecutionId || null,
    },
  ];
}
```

### Step 10: 重写 `onMessage` — message 携带 parent_id (主 agent)

```typescript
private onMessage(data: MessageData, ts: number): DifyEvent[] {
  const frame = this.currentFrame();
  return [
    {
      ...this.envelope(ts),
      event: DifyEventType.MESSAGE,
      id: this.ctx.messageId,
      answer: data.delta,
      parent_id: frame?.isSubAgent ? frame.nodeExecutionId : null,
    },
  ];
}
```

### Step 11: 新增 `buildAgentLog` 统一构建方法

替换原来的 `makeAgentLog`。

> **字段层级说明**：
> - `data.data` = 内层载荷（工具参数/响应等），工具结果在 `data.data.output`
> - `data.output` = 外层阶段输出（think/reflect 的完整文本），是 blocking 结果
> - `data.error` = 外层错误字段

```typescript
private buildAgentLog(
  frame: ExecutionFrame | undefined,
  opts: {
    id: string;
    label: string;
    step: AgentLogStep | "round";
    status: AgentLogStatus;
    parentId: string | null;
    nodeType?: string;
    data?: Record<string, unknown>;  // 内层 data 载荷（默认 {}）
    error?: string | null;           // 外层 error（默认 null）
    output?: unknown;                // 外层 output（think/reflect 阶段结果）
    elapsed_time?: number;
  },
  ts: number,
): DifyEvent {
  return {
    ...this.envelope(ts),
    event: DifyEventType.AGENT_LOG,
    data: {
      id: opts.id,
      node_id: frame?.nodeId ?? "",
      node_execution_id: frame?.nodeExecutionId ?? "",
      parent_id: opts.parentId,
      label: opts.label,
      step: opts.step,
      status: opts.status,
      node_type: opts.nodeType,
      data: opts.data ?? {},                                              // 内层 data
      error: opts.error ?? null,                                          // 外层 error
      ...(opts.output !== undefined ? { output: opts.output } : {}),      // 外层 output
      ...(opts.elapsed_time !== undefined ? { elapsed_time: opts.elapsed_time } : {}),
    },
  } as DifyEvent;
}
```

**调用示例对比**：

```typescript
// think succeeded → output 在外层 data.output
this.buildAgentLog(frame, {
  ..., step: "think", status: "succeeded",
  data: {},              // 内层 data 为空
  output: "LLM完整文本", // 外层 data.output = blocking 结果
}, ts);

// tool succeeded → 工具结果在 data.data.output
this.buildAgentLog(frame, {
  ..., step: "act", status: "succeeded", nodeType: "tool",
  data: {                // 内层 data 包含 output 子对象
    output: {
      tool_call_id: "...",
      tool_call_name: "...",
      tool_call_input: {...},
      tool_response: "...",
    },
  },
  // 外层无 output 字段
}, ts);
```

### Step 12: 添加模型名称获取辅助方法

```typescript
private getModelName(): string {
  // 从上下文获取或返回默认值
  return this.inputContext.modelName ?? "LLM";
}
```

### Step 13: 编译检查

Run: `npx tsc --noEmit --pretty 2>&1 | head -80`
Expected: PASS（或仅 routes.ts 中 parent_id 缺失的错误）

### Step 14: Commit

```bash
git add src/core/dify/types.ts src/core/dify/stream-adapter.ts
git commit -m "refactor(dify/stream-adapter): ROUND grouping, step/label split, sub-agent nesting, fixed node_id, unified data/error"
```

---

## Task 3: SubAgentManager — 转发完整子事件 — `src/core/sub-agent-manager.ts`

**Files:**
- Modify: `src/core/sub-agent-manager.ts`

### Step 1: 扩展 `forwardChildEvent` 转发子 agent 的全部内部事件

当前 `forwardChildEvent` 只转发 `message`, `tool_started`, `tool_finished`。
需要新增转发：`node_started`, `node_finished`, `thinking`, `progress`。

```typescript
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
      const data = event.data as ToolFinishedData;
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
    // 新增：转发子 agent 的内部节点事件
    case "node_started":
    case "node_finished":
    case "thinking":
    case "progress": {
      // 直接以 tool_event 方式推送，DifyStreamAdapter 会根据
      // executionStack 上下文（当前处于子 agent frame）正确处理
      cb(event);
      break;
    }
    // task_started, task_finished, done → 不转发
    // (agent_started / agent_finished 由 spawnStreaming 手动发射)
  }
}
```

### Step 2: 编译检查

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: PASS

### Step 3: Commit

```bash
git add src/core/sub-agent-manager.ts
git commit -m "feat(sub-agent-manager): forward child node_started/node_finished/thinking/progress events to parent stream"
```

---

## Task 4: DifySSEWriter — 传递上下文 — `src/core/dify/sse-writer.ts`

**Files:**
- Modify: `src/core/dify/sse-writer.ts`

### Step 1: 扩展 options 以传递 inputs/query/userId/tenantId

```typescript
export interface DifySSEWriterOptions {
  taskId: string;
  sessionId: string;
  heartbeatMs?: number;
  // 新增上下文
  inputs?: Record<string, unknown>;
  query?: string;
  userId?: string;
  tenantId?: string;
}
```

### Step 2: 在 constructor 中传递给 DifyStreamAdapter

```typescript
private constructor(raw: ServerResponse, opts: DifySSEWriterOptions) {
  this.raw = raw;
  this.adapter = new DifyStreamAdapter(opts.sessionId, opts.taskId, {
    inputs: opts.inputs,
    query: opts.query,
    userId: opts.userId,
    tenantId: opts.tenantId,
  });
  // ... rest unchanged
}
```

### Step 3: 编译检查

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`

### Step 4: Commit

```bash
git add src/core/dify/sse-writer.ts
git commit -m "feat(dify/sse-writer): pass inputs/query/userId/tenantId context to DifyStreamAdapter"
```

---

## Task 5: stream-writer-factory — 传递上下文 — `src/core/stream-writer-factory.ts`

**Files:**
- Modify: `src/core/stream-writer-factory.ts`

### Step 1: 扩展 StreamWriterOptions

```typescript
export interface StreamWriterOptions {
  taskId: string;
  sessionId: string;
  userId?: string;
  // 新增
  inputs?: Record<string, unknown>;
  query?: string;
  tenantId?: string;
}
```

### Step 2: 在 dify 模式下传递给 DifySSEWriter

```typescript
const writer = DifySSEWriter.create(raw, {
  taskId: opts.taskId,
  sessionId: opts.sessionId,
  inputs: opts.inputs,
  query: opts.query,
  userId: opts.userId,
  tenantId: opts.tenantId,
});
```

### Step 3: Commit

```bash
git add src/core/stream-writer-factory.ts
git commit -m "feat(stream-writer-factory): pass inputs context through to DifySSEWriter"
```

---

## Task 6: Routes 层改造 — `apps/document-generation/code/routes.ts`

**Files:**
- Modify: `apps/document-generation/code/routes.ts`

### Step 1: 在 createStreamWriter 时传递上下文

```typescript
writer = createStreamWriter(reply.raw, {
  taskId: event.task_id,
  sessionId: event.session_id,
  userId,
  tenantId,
  inputs: body as unknown as Record<string, unknown>,
  query: body.prompt ?? "开始工作",
});
```

### Step 2: message 事件中 parent_id 从 routes 层不额外处理

message 事件的 `parent_id` 已由 DifyStreamAdapter 在转换时自动注入，routes 层使用 `createMessage` 生成的原生 message 事件会经过 adapter 转换时自动获得 `parent_id: null`（主 agent 输出）。

但 routes 层直接写 `createMessage(writer.streamContext, chunk)` 时，adapter 的 `onMessage` 会读取当前 frame 来决定 `parent_id`。这已在 Task 2 Step 10 中处理。

### Step 3: 编译检查

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: PASS

### Step 4: Commit

```bash
git add apps/document-generation/code/routes.ts
git commit -m "feat(document-generation): pass inputs/query/tenantId context to stream writer"
```

---

## Task 7: agent-runtime 微调 — `src/core/agent-runtime.ts`

**Files:**
- Modify: `src/core/agent-runtime.ts`

### Step 1: 确保 node_started/node_finished 携带 iteration

当前 `createNodeStarted(ctx, nodeType, currentIteration)` 已经传递 iteration。
确认 `NodeStartedData` 的 `iteration` 字段被 DifyStreamAdapter 用于 ROUND 检测。

检查：adapter 的 `onNodeStarted` 从 `data.iteration` 读取轮次 → 需要确认 `NodeStartedData` 有 `iteration` 字段 ✓ (已有)

### Step 2: 确认子 agent 的事件链路

`streamInvoker` → `streamAgentV2(childAgent)` → 产出子 agent 的原生事件 →
`forwardChildEvent` (Task 3 已扩展) → 推送到父 agent 的 event channel →
DifyStreamAdapter 收到时 executionStack 顶部是子 agent frame → 正确生成 parent_id

无需改动 agent-runtime，逻辑自洽。

### Step 3: Commit (如有改动)

```bash
git add src/core/agent-runtime.ts
git commit -m "chore(agent-runtime): verify iteration propagation for ROUND detection"
```

---

## Task 8: 完整端到端测试

### Step 1: 编译检查

Run: `npx tsc --noEmit --pretty`
Expected: 0 errors

### Step 2: 启动服务器

Run: `npm run dev`
Expected: Server listening on port 7800

### Step 3: 发送测试请求

```bash
curl -N -X POST http://localhost:7800/api/business/document-generation/generate-stream \
  -H "Authorization: Bearer x-pilot-default-key" \
  -H "Content-Type: application/json" \
  -d '{
    "select_knowledge_unit": "测试主题",
    "prompt": "简短测试",
    "sessionId": "test-subagent-001"
  }'
```

### Step 4: 验证事件流

检查输出中是否包含：
- [x] `workflow_started` 包含 `inputs`, `sys.query`, `sys.user_id`, `sys.tenant_id`
- [x] `node_started` 的 `node_id` 为纯数字字符串
- [x] `agent_log` 包含 `ROUND 1` 事件（`step: "round"`, `status: "started"`）
- [x] `agent_log` 的 perceive/think/act/observe 有 `step` 和 `label` 分离
- [x] think_finished 的 `label` 为 `"LLM Thought"` 或模型名称
- [x] tool_call 的 `label` 为 `"CALL <tool_name>"`
- [x] 所有 agent_log 有 `data: {}` 和 `error: null`（默认值）
- [x] message 事件有 `parent_id` 字段
- [x] sub-agent 事件的 `parent_id` 链路正确
- [x] `workflow_finished` 包含 `outputs.answer` 和 `outputs.url`
- [x] `message_end` 在 `workflow_finished` 之后

---

## Task 9: 业务线迁移 — video-course / sim-training

**Files:**
- Modify: `apps/video-course/code/routes.ts`
- Modify: `apps/sim-training/code/routes.ts`

### Step 1: video-course 迁移 streamAgent → streamAgentV2

将 `agentRuntime.streamAgent(...)` 替换为 `agentRuntime.streamAgentV2(...)`，
并参照 document-generation 的 routes.ts 模式：
- 使用 `createStreamWriter`
- 遍历 `StreamEvent` 而非 `AgentStreamEvent`
- 添加 `message` 累积和 `task_finished` outputs 注入

### Step 2: sim-training 同理

### Step 3: 编译检查

Run: `npx tsc --noEmit --pretty`
Expected: PASS

### Step 4: Commit

```bash
git add apps/video-course/code/routes.ts apps/sim-training/code/routes.ts
git commit -m "feat(video-course,sim-training): migrate to streamAgentV2 + Dify SSE protocol"
```

---

## Task 10: 文档更新 — `docs/dify-event-stream-spec.md`

**Files:**
- Modify: `docs/dify-event-stream-spec.md`

### Step 1: 同步所有字段变更

更新文档中：
- agent_log 事件的 `id`, `step`, `parent_id`, `data`, `error` 字段说明
- ROUND 事件的使用说明
- node_id 生成规则（数字字符串而非 agent_ 前缀）
- workflow_started 的 inputs/sys.* 字段
- message 的 parent_id 字段
- sub-agent 事件流嵌套树形结构示例

### Step 2: Commit

```bash
git add docs/dify-event-stream-spec.md
git commit -m "docs: update dify-event-stream-spec with ROUND grouping, step/label split, sub-agent nesting"
```

---

## 完整事件流示例 — document-generation（精确到字段）

以下为改造后一次完整的 document-generation 事件流。
假设场景：用户请求生成一份关于「电子电工原理」的教学文稿，主 agent 先搜索知识库，再并发调用 2 个 section-writer 子 agent 撰写章节。

**约定常量**（便于跟踪 parent_id 关系）：

| 符号 | 说明 | 示例值 |
|------|------|--------|
| `TASK_ID` | Dify task_id (用于 stop) | `"955b5f5d-2849-44ee-b3ab-cf5d43239748"` |
| `CONV_ID` | conversation_id (= sessionId) | `"b201d445-0d39-4d6b-9144-3bcc8ced8926"` |
| `MSG_ID` | message_id (= native task_id) | `"task_8eb2978a"` |
| `WF_RUN_ID` | workflow_run_id | `"workflow_run_cd5fb921"` |
| `ROOT_NODE_ID` | 主 agent 固定 node_id | `"11179223255"` |
| `R1_ID` | ROUND 1 的 agent_log id | `"r1-uuid-0001"` |
| `R2_ID` | ROUND 2 的 agent_log id | `"r2-uuid-0002"` |
| `CHILD_NODE_ID_1` | section-writer-1 的 node_id | `"22280334411"` |
| `CHILD_EXEC_ID_1` | section-writer-1 的执行 ID | `"section-writer_abc123def456"` |
| `CHILD_NODE_ID_2` | section-writer-2 的 node_id | `"22280334412"` |
| `CHILD_EXEC_ID_2` | section-writer-2 的执行 ID | `"section-writer_xyz789ghi012"` |
| `SA1_ACT_ID` | 主 agent act 中 section-writer-1 的事件 id | `"sa1-act-uuid"` |
| `SA2_ACT_ID` | 主 agent act 中 section-writer-2 的事件 id | `"sa2-act-uuid"` |
| `SUB1_R1_ID` | 子 agent 1 的 ROUND 1 id | `"sub1-r1-uuid"` |
| `SUB2_R1_ID` | 子 agent 2 的 ROUND 1 id | `"sub2-r1-uuid"` |

---

### 事件 #1: workflow_started

```json
{
    "event": "workflow_started",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922730.617,
    "data": {
        "id": "workflow_run_cd5fb921",
        "workflow_run_id": "workflow_run_cd5fb921",
        "agent_name": "document-generator",
        "inputs": {
            "select_knowledge_unit": "电子电工原理及故障诊断实训指导书",
            "prompt": "图片不少于10张，加入3个案例，字数1万字左右。",
            "database_id": "53bc2550-f35b-4a6f-831f-57fb333d601f",
            "docCategory": "studentHandbook",
            "sys.query": "图片不少于10张，加入3个案例，字数1万字左右。",
            "sys.user_id": "20201011",
            "sys.tenant_id": "default"
        },
        "thread_id": "8fb25005-be7a-4314-8e97-44ae4bc7713d",
        "created_at": 1773922730.617
    }
}
```

### 事件 #2: node_started（主 agent 根节点）

```json
{
    "event": "node_started",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922730.617,
    "data": {
        "id": "11179223255",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "node_type": "agent",
        "title": "document-generator",
        "inputs": null,
        "parent_id": "",
        "index": 0,
        "created_at": 1773922730.617
    }
}
```

### 事件 #3: agent_log — ROUND 1 started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922730.620,
    "data": {
        "id": "r1-uuid-0001",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": null,
        "label": "ROUND 1",
        "step": "round",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #4: agent_log — perceive started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922730.625,
    "data": {
        "id": "a4-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "perceive",
        "step": "perceive",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #5: agent_log — perceive succeeded

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922730.640,
    "data": {
        "id": "a5-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "perceive",
        "step": "perceive",
        "status": "succeeded",
        "data": {},
        "error": null,
        "elapsed_time": 0.015
    }
}
```

### 事件 #6: agent_log — think started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922730.645,
    "data": {
        "id": "a6-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "think",
        "step": "think",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #7: message（流式模式下，think 阶段的实时 token 输出）

> **流式模式**下，think 阶段 LLM 逐 token 推送 message 事件。
> **非流式模式**下，此事件不存在，直接跳到 think succeeded。
> 注意：主 agent 的 think 输出是协调指令（"我需要搜索知识库..."），**不是正文内容**。

```json
{
    "event": "message",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922735.000,
    "id": "task_8eb2978a",
    "answer": "我需要先搜索",
    "parent_id": null
}
```

```json
{
    "event": "message",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922735.100,
    "id": "task_8eb2978a",
    "answer": "知识库获取相关资料，",
    "parent_id": null
}
```

```json
{
    "event": "message",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922735.200,
    "id": "task_8eb2978a",
    "answer": "然后制定文稿大纲，最后并发调用section-writer撰写各章节。",
    "parent_id": null
}
```

### 事件 #8: agent_log — think succeeded（LLM 第一轮推理结束）

> **无论流式还是非流式，output 都必须包含完整的 blocking 结果。**

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922743.020,
    "data": {
        "id": "a7-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "deepseek-v3 Thought",
        "step": "think",
        "status": "succeeded",
        "data": {},
        "error": null,
        "output": "我需要先搜索知识库获取相关资料，然后制定文稿大纲，最后并发调用section-writer撰写各章节。",
        "elapsed_time": 12.375
    }
}
```

### 事件 #9: agent_log — act started（第一轮 act 开始）

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922743.025,
    "data": {
        "id": "a8-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "act",
        "step": "act",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #10: agent_log — CALL knowledge_search started（工具调用）

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922743.030,
    "data": {
        "id": "a9-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "CALL knowledge_search",
        "step": "act",
        "node_type": "tool",
        "status": "started",
        "data": {
            "tool_name": "knowledge_search",
            "tool_call_id": "call_ks_abc123",
            "tool_input": {
                "query": "电子电工原理 故障诊断 实训",
                "database_id": "53bc2550-f35b-4a6f-831f-57fb333d601f"
            }
        },
        "error": null
    }
}
```

### 事件 #11: agent_log — CALL knowledge_search succeeded

> 工具结果在 `data.data.output`（三层嵌套是正确的）。

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922748.200,
    "data": {
        "id": "a10-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "CALL knowledge_search",
        "step": "act",
        "node_type": "tool",
        "status": "succeeded",
        "data": {
            "output": {
                "tool_call_id": "call_ks_abc123",
                "tool_call_name": "knowledge_search",
                "tool_call_input": {
                    "query": "电子电工原理 故障诊断 实训",
                    "database_id": "53bc2550-f35b-4a6f-831f-57fb333d601f"
                },
                "tool_response": "{\"results\":[{\"ref\":\"ref-001\",\"content\":\"三相交流发电机...\"},...],\"total\":45}"
            }
        },
        "error": null,
        "elapsed_time": 5.170
    }
}
```

### 事件 #12: agent_log — CALL emit_event started（进度通知）

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922748.300,
    "data": {
        "id": "a11-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "CALL emit_event",
        "step": "act",
        "node_type": "tool",
        "status": "started",
        "data": {
            "tool_name": "emit_event",
            "tool_call_id": "call_emit_abc456",
            "tool_input": {
                "eventType": "progress",
                "message": "资料检索完成！共获取了 45 条专业资料，现在启动所有章节的同步撰写……"
            }
        },
        "error": null
    }
}
```

### 事件 #13: agent_log — CALL emit_event succeeded

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922748.301,
    "data": {
        "id": "a12-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "CALL emit_event",
        "step": "act",
        "node_type": "tool",
        "status": "succeeded",
        "data": {
            "output": {
                "tool_call_id": "call_emit_abc456",
                "tool_call_name": "emit_event",
                "tool_call_input": { "eventType": "progress", "message": "资料检索完成！..." },
                "tool_response": "{\"success\":true,\"eventType\":\"progress\",\"sessionId\":\"b201d445-0d39-4d6b-9144-3bcc8ced8926\"}"
            }
        },
        "error": null,
        "elapsed_time": 0.001
    }
}
```

### 事件 #14: agent_log — act succeeded（第一轮 act 结束）

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922748.400,
    "data": {
        "id": "a13-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "act",
        "step": "act",
        "status": "succeeded",
        "data": {},
        "error": null,
        "elapsed_time": 5.375
    }
}
```

### 事件 #15: agent_log — observe started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922748.410,
    "data": {
        "id": "a14-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "observe",
        "step": "observe",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #16: agent_log — observe succeeded

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922748.420,
    "data": {
        "id": "a15-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r1-uuid-0001",
        "label": "observe",
        "step": "observe",
        "status": "succeeded",
        "data": {},
        "error": null,
        "elapsed_time": 0.010
    }
}
```

---

### ══════ 第二轮 ROUND 2（调用 sub-agent 撰写章节）══════

### 事件 #17: agent_log — ROUND 2 started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922748.500,
    "data": {
        "id": "r2-uuid-0002",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": null,
        "label": "ROUND 2",
        "step": "round",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #18: agent_log — perceive started (R2)

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922748.510,
    "data": {
        "id": "a17-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "perceive",
        "step": "perceive",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #19: agent_log — perceive succeeded (R2)

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922748.520,
    "data": {
        "id": "a18-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "perceive",
        "step": "perceive",
        "status": "succeeded",
        "data": {},
        "error": null,
        "elapsed_time": 0.010
    }
}
```

### 事件 #20: agent_log — think started (R2)

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922748.530,
    "data": {
        "id": "a19-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "think",
        "step": "think",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #21: agent_log — think succeeded (R2, 决定并发调用 sub-agent)

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.000,
    "data": {
        "id": "a20-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "deepseek-v3 Thought",
        "step": "think",
        "status": "succeeded",
        "data": {},
        "error": null,
        "output": "资料已就绪。我将按大纲并发调用 section-writer 撰写「任务一：电路基础认知」和「任务二：整流滤波模块原理与应用」两个章节。",
        "elapsed_time": 11.470
    }
}
```

### 事件 #22: agent_log — act started (R2, 即将调用 sub-agent)

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.010,
    "data": {
        "id": "a21-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "act",
        "step": "act",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #23: agent_log — section-writer-1 started（sub-agent 启动）

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.100,
    "data": {
        "id": "sa1-act-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "section-writer",
        "step": "act",
        "node_type": "agent",
        "status": "started",
        "data": {
            "agent_name": "section-writer",
            "agent_name_id": "section-writer_abc123def456",
            "agent_input": {
                "instruction": "请为「任务一：汽车基础电路认知与应用」撰写完整章节内容..."
            }
        },
        "error": null
    }
}
```

### 事件 #24: agent_log — section-writer-2 started（第二个 sub-agent 并发启动）

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.110,
    "data": {
        "id": "sa2-act-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "section-writer",
        "step": "act",
        "node_type": "agent",
        "status": "started",
        "data": {
            "agent_name": "section-writer",
            "agent_name_id": "section-writer_xyz789ghi012",
            "agent_input": {
                "instruction": "请为「任务二：整流滤波模块原理与应用」撰写完整章节内容..."
            }
        },
        "error": null
    }
}
```

---

### ══════ 子 agent 1 (section-writer-1) 内部事件 ══════

### 事件 #25: agent_log — 子 agent 1 ROUND 1 started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.200,
    "data": {
        "id": "sub1-r1-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sa1-act-uuid",
        "label": "ROUND 1",
        "step": "round",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #26: agent_log — 子 agent 1 perceive started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.210,
    "data": {
        "id": "s25-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "perceive",
        "step": "perceive",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #27: agent_log — 子 agent 1 perceive succeeded

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.220,
    "data": {
        "id": "s26-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "perceive",
        "step": "perceive",
        "status": "succeeded",
        "data": {},
        "error": null,
        "elapsed_time": 0.010
    }
}
```

### 事件 #28: agent_log — 子 agent 1 think started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.230,
    "data": {
        "id": "s27-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "think",
        "step": "think",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #29: agent_log — 子 agent 1 think succeeded

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922780.000,
    "data": {
        "id": "s28-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "deepseek-v3 Thought",
        "step": "think",
        "status": "succeeded",
        "data": {},
        "error": null,
        "output": "我将为「汽车基础电路认知与应用」撰写完整内容，包含任务引入、教学目标、背景知识和考核部分。",
        "elapsed_time": 19.770
    }
}
```

### 事件 #30: agent_log — 子 agent 1 act started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922780.010,
    "data": {
        "id": "s29-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "act",
        "step": "act",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #31: agent_log — 子 agent 1 CALL workspace_write started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922780.020,
    "data": {
        "id": "s30-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "CALL workspace_write",
        "step": "act",
        "node_type": "tool",
        "status": "started",
        "data": {
            "tool_name": "workspace_write",
            "tool_call_id": "call_ws_write_001",
            "tool_input": {
                "name": "sections/01-电路基础认知.md",
                "content": "# 任务一：汽车基础电路认知与应用\n\n## 一、任务引入\n\n在现代汽车中..."
            }
        },
        "error": null
    }
}
```

### 事件 #32 ~ #34: message 事件（routes 层拦截 workspace_write，逐段流式输出正文）

```json
{
    "event": "message",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922780.025,
    "id": "task_8eb2978a",
    "answer": "# 任务一：汽车基础电路认知与应用\n\n",
    "parent_id": "section-writer_abc123def456"
}
```

```json
{
    "event": "message",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922780.030,
    "id": "task_8eb2978a",
    "answer": "## 一、任务引入\n\n在现代汽车中，电气系统犹如人体的神经系统...\n\n",
    "parent_id": "section-writer_abc123def456"
}
```

```json
{
    "event": "message",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922780.035,
    "id": "task_8eb2978a",
    "answer": "## 二、教学目标\n\n### 2.1 能力目标\n\n2.1.1 能正确识别汽车基础电路的各种元器件...\n\n",
    "parent_id": "section-writer_abc123def456"
}
```

### 事件 #35: agent_log — 子 agent 1 CALL workspace_write succeeded

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922780.100,
    "data": {
        "id": "s34-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "CALL workspace_write",
        "step": "act",
        "node_type": "tool",
        "status": "succeeded",
        "data": {
            "output": {
                "tool_call_id": "call_ws_write_001",
                "tool_call_name": "workspace_write",
                "tool_call_input": { "name": "sections/01-电路基础认知.md", "content": "..." },
                "tool_response": "{\"success\":true,\"path\":\"sections/01-电路基础认知.md\",\"size\":8192}"
            }
        },
        "error": null,
        "elapsed_time": 0.080
    }
}
```

### 事件 #36: agent_log — 子 agent 1 act succeeded

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922780.110,
    "data": {
        "id": "s35-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "act",
        "step": "act",
        "status": "succeeded",
        "data": {},
        "error": null,
        "elapsed_time": 0.100
    }
}
```

### 事件 #37: agent_log — 子 agent 1 observe started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922780.120,
    "data": {
        "id": "s36-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "observe",
        "step": "observe",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #38: agent_log — 子 agent 1 observe succeeded

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922780.130,
    "data": {
        "id": "s37-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "observe",
        "step": "observe",
        "status": "succeeded",
        "data": {},
        "error": null,
        "elapsed_time": 0.010
    }
}
```

### 事件 #39: agent_log — 子 agent 1 reflect started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922780.140,
    "data": {
        "id": "s38-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "reflect",
        "step": "reflect",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #40: agent_log — 子 agent 1 reflect succeeded

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922790.000,
    "data": {
        "id": "s39-uuid",
        "node_id": "22280334411",
        "node_execution_id": "section-writer_abc123def456",
        "parent_id": "sub1-r1-uuid",
        "label": "reflect",
        "step": "reflect",
        "status": "succeeded",
        "data": {},
        "error": null,
        "output": "{\"summary\":\"章节已完成\",\"lessonsLearned\":[],\"confidence\":0.9}",
        "elapsed_time": 9.860
    }
}
```

### 事件 #41: agent_log — section-writer-1 succeeded（子 agent 1 完成）

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922790.100,
    "data": {
        "id": "s40-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "section-writer",
        "step": "act",
        "node_type": "agent",
        "status": "succeeded",
        "data": {
            "agent_name": "section-writer",
            "agent_name_id": "section-writer_abc123def456"
        },
        "error": null,
        "elapsed_time": 30.000
    }
}
```

---

### ══════ 子 agent 2 (section-writer-2) 内部事件（与子 agent 1 并发，可能交叉）══════

> 注意：以下事件的 `created_at` 与子 agent 1 的事件交叉，因为是并发执行。
> 前端通过 `parent_id` 链路可重建树形结构。

### 事件 #42: agent_log — 子 agent 2 ROUND 1 started

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.250,
    "data": {
        "id": "sub2-r1-uuid",
        "node_id": "22280334412",
        "node_execution_id": "section-writer_xyz789ghi012",
        "parent_id": "sa2-act-uuid",
        "label": "ROUND 1",
        "step": "round",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #43: agent_log — 子 agent 2 perceive started/succeeded

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.260,
    "data": {
        "id": "s42a-uuid",
        "node_id": "22280334412",
        "node_execution_id": "section-writer_xyz789ghi012",
        "parent_id": "sub2-r1-uuid",
        "label": "perceive",
        "step": "perceive",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.270,
    "data": {
        "id": "s42b-uuid",
        "node_id": "22280334412",
        "node_execution_id": "section-writer_xyz789ghi012",
        "parent_id": "sub2-r1-uuid",
        "label": "perceive",
        "step": "perceive",
        "status": "succeeded",
        "data": {},
        "error": null,
        "elapsed_time": 0.010
    }
}
```

### 事件 #44: agent_log — 子 agent 2 think started/succeeded

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922760.280,
    "data": {
        "id": "s43a-uuid",
        "node_id": "22280334412",
        "node_execution_id": "section-writer_xyz789ghi012",
        "parent_id": "sub2-r1-uuid",
        "label": "think",
        "step": "think",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922785.000,
    "data": {
        "id": "s43b-uuid",
        "node_id": "22280334412",
        "node_execution_id": "section-writer_xyz789ghi012",
        "parent_id": "sub2-r1-uuid",
        "label": "deepseek-v3 Thought",
        "step": "think",
        "status": "succeeded",
        "data": {},
        "error": null,
        "output": "我将撰写整流滤波模块的原理剖析、实训步骤和注意事项。",
        "elapsed_time": 24.720
    }
}
```

### 事件 #45: agent_log — 子 agent 2 act started + CALL workspace_write

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922785.010,
    "data": {
        "id": "s44a-uuid",
        "node_id": "22280334412",
        "node_execution_id": "section-writer_xyz789ghi012",
        "parent_id": "sub2-r1-uuid",
        "label": "act",
        "step": "act",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922785.020,
    "data": {
        "id": "s44b-uuid",
        "node_id": "22280334412",
        "node_execution_id": "section-writer_xyz789ghi012",
        "parent_id": "sub2-r1-uuid",
        "label": "CALL workspace_write",
        "step": "act",
        "node_type": "tool",
        "status": "started",
        "data": {
            "tool_name": "workspace_write",
            "tool_call_id": "call_ws_write_002",
            "tool_input": {
                "name": "sections/02-整流滤波模块.md",
                "content": "# 任务二：整流滤波模块原理与应用\n\n在汽车电气系统中..."
            }
        },
        "error": null
    }
}
```

### 事件 #46 ~ #48: message 事件（子 agent 2 的正文流式输出）

```json
{
    "event": "message",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922785.025,
    "id": "task_8eb2978a",
    "answer": "# 任务二：整流滤波模块原理与应用\n\n",
    "parent_id": "section-writer_xyz789ghi012"
}
```

```json
{
    "event": "message",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922785.030,
    "id": "task_8eb2978a",
    "answer": "在汽车电气系统中，将交流电转换为直流电是至关重要的一环...\n\n",
    "parent_id": "section-writer_xyz789ghi012"
}
```

```json
{
    "event": "message",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922785.035,
    "id": "task_8eb2978a",
    "answer": "## 原理剖析\n\n### 三相交流发电机的发电原理\n\n想象一下，你手中拿着一块磁铁...\n\n",
    "parent_id": "section-writer_xyz789ghi012"
}
```

### 事件 #49 ~ #54: 子 agent 2 完成剩余阶段（workspace_write succeeded → act succeeded → observe → reflect）

> 格式与子 agent 1 完全相同，仅 `node_id`=`"22280334412"`, `node_execution_id`=`"section-writer_xyz789ghi012"`, `parent_id` 指向 `"sub2-r1-uuid"`。此处省略重复 JSON。

### 事件 #55: agent_log — section-writer-2 succeeded（子 agent 2 完成）

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922820.000,
    "data": {
        "id": "s54-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "section-writer",
        "step": "act",
        "node_type": "agent",
        "status": "succeeded",
        "data": {
            "agent_name": "section-writer",
            "agent_name_id": "section-writer_xyz789ghi012"
        },
        "error": null,
        "elapsed_time": 59.890
    }
}
```

---

### ══════ 主 agent 继续（ROUND 2 收尾）══════

### 事件 #56: agent_log — act succeeded (R2, 全部子 agent 已完成)

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922820.100,
    "data": {
        "id": "a55-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "act",
        "step": "act",
        "status": "succeeded",
        "data": {},
        "error": null,
        "elapsed_time": 60.090
    }
}
```

### 事件 #57: agent_log — observe started (R2)

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922820.110,
    "data": {
        "id": "a56-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "observe",
        "step": "observe",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #58: agent_log — observe succeeded (R2)

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922820.120,
    "data": {
        "id": "a57-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "observe",
        "step": "observe",
        "status": "succeeded",
        "data": {},
        "error": null,
        "elapsed_time": 0.010
    }
}
```

### 事件 #59: agent_log — reflect started (R2)

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922820.130,
    "data": {
        "id": "a58-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "reflect",
        "step": "reflect",
        "status": "started",
        "data": {},
        "error": null
    }
}
```

### 事件 #60: agent_log — reflect succeeded (R2)

```json
{
    "event": "agent_log",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922840.000,
    "data": {
        "id": "a59-uuid",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "parent_id": "r2-uuid-0002",
        "label": "reflect",
        "step": "reflect",
        "status": "succeeded",
        "data": {},
        "error": null,
        "output": "{\"summary\":\"已完成2个章节的撰写与组装\",\"lessonsLearned\":[\"并发调用section-writer可显著缩短总时长\"],\"confidence\":0.92}",
        "elapsed_time": 19.870
    }
}
```

---

### ══════ 全局收尾事件 ══════

### 事件 #61: node_finished（主 agent 根节点完成）

```json
{
    "event": "node_finished",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922845.000,
    "data": {
        "id": "11179223255",
        "node_id": "11179223255",
        "node_execution_id": "11179223255",
        "node_type": "agent",
        "title": "document-generator",
        "inputs": null,
        "parent_id": "",
        "index": 1,
        "status": "succeeded",
        "outputs": {
            "answer": "# 任务一：汽车基础电路认知与应用\n\n## 一、任务引入\n\n在现代汽车中...\n\n# 任务二：整流滤波模块原理与应用\n\n在汽车电气系统中...",
            "url": "http://192.168.50.54:7800/api/files/tenants/default/users/default/workspaces/b201d445-0d39-4d6b-9144-3bcc8ced8926/artifacts/document.md"
        },
        "elapsed_time": 114.383,
        "created_at": 1773922845.000
    }
}
```

### 事件 #62: workflow_finished

```json
{
    "event": "workflow_finished",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922845.100,
    "data": {
        "id": "workflow_run_cd5fb921",
        "workflow_run_id": "workflow_run_cd5fb921",
        "status": "succeeded",
        "outputs": {
            "answer": "# 任务一：汽车基础电路认知与应用\n\n## 一、任务引入\n\n在现代汽车中...\n\n# 任务二：整流滤波模块原理与应用\n\n在汽车电气系统中...",
            "url": "http://192.168.50.54:7800/api/files/tenants/default/users/default/workspaces/b201d445-0d39-4d6b-9144-3bcc8ced8926/artifacts/document.md"
        },
        "error": null,
        "elapsed_time": 114.483,
        "total_tokens": 45230,
        "total_steps": 59,
        "created_at": 1773922845.100,
        "finished_at": 1773922845,
        "exceptions_count": 0,
        "files": []
    }
}
```

### 事件 #63: message_end（在 workflow_finished 之后）

```json
{
    "event": "message_end",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922845.200,
    "id": "task_8eb2978a",
    "metadata": {
        "annotation_reply": null,
        "retriever_resources": [],
        "usage": {
            "prompt_tokens": 38500,
            "completion_tokens": 6730,
            "total_tokens": 45230
        }
    },
    "files": []
}
```

---

### ══════ 异常终止场景 ══════

#### 场景 A: 错误中断

workflow_finished 的 `status`=`"failed"`, `outputs`=`{}`, `error`=错误字符串, **不发送** `message_end`。

```json
{
    "event": "workflow_finished",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922900.000,
    "data": {
        "id": "workflow_run_cd5fb921",
        "workflow_run_id": "workflow_run_cd5fb921",
        "status": "failed",
        "outputs": {},
        "error": "LLM API 请求超时: Connection timed out after 30000ms",
        "elapsed_time": 30.500,
        "total_tokens": 0,
        "total_steps": 5,
        "created_at": 1773922900.000,
        "finished_at": 1773922900,
        "exceptions_count": 1,
        "files": []
    }
}
```

#### 场景 B: 用户停止响应

workflow_finished 的 `status`=`"stopped"`, `outputs`=`{answer, url}`, `error`=`null`, **发送** `message_end`。

```json
{
    "event": "workflow_finished",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922800.000,
    "data": {
        "id": "workflow_run_cd5fb921",
        "workflow_run_id": "workflow_run_cd5fb921",
        "status": "stopped",
        "outputs": {
            "answer": "# 任务一：汽车基础电路认知与应用\n\n## 一、任务引入\n\n（用户在此处停止，内容截断）",
            "url": "http://192.168.50.54:7800/api/files/tenants/default/users/default/workspaces/b201d445-0d39-4d6b-9144-3bcc8ced8926/artifacts/document.md"
        },
        "error": null,
        "elapsed_time": 69.383,
        "total_tokens": 22100,
        "total_steps": 25,
        "created_at": 1773922800.000,
        "finished_at": 1773922800,
        "exceptions_count": 0,
        "files": []
    }
}
```

紧接着发送 message_end:

```json
{
    "event": "message_end",
    "task_id": "955b5f5d-2849-44ee-b3ab-cf5d43239748",
    "conversation_id": "b201d445-0d39-4d6b-9144-3bcc8ced8926",
    "message_id": "task_8eb2978a",
    "created_at": 1773922800.100,
    "id": "task_8eb2978a",
    "metadata": {
        "annotation_reply": null,
        "retriever_resources": [],
        "usage": {
            "prompt_tokens": 19000,
            "completion_tokens": 3100,
            "total_tokens": 22100
        }
    },
    "files": []
}
```

---

### parent_id 树形结构重建

前端可通过 `parent_id` 重建如下树形结构：

```
workflow_started
└── node_started (agent: document-generator, id="11179223255")
    ├── ROUND 1 (id="r1-uuid-0001", parent_id=null)
    │   ├── perceive/started → perceive/succeeded
    │   ├── think/started → think/succeeded (output="我需要搜索知识库...")
    │   ├── act/started
    │   │   ├── CALL knowledge_search/started → succeeded
    │   │   └── CALL emit_event/started → succeeded
    │   ├── act/succeeded
    │   └── observe/started → observe/succeeded
    │
    └── ROUND 2 (id="r2-uuid-0002", parent_id=null)
        ├── perceive/started → perceive/succeeded
        ├── think/started → think/succeeded (output="并发调用section-writer...")
        ├── act/started
        │   ├── section-writer/started (id="sa1-act-uuid", node_type="agent")
        │   │   └── ROUND 1 (id="sub1-r1-uuid", parent_id="sa1-act-uuid")
        │   │       ├── perceive → think → act(workspace_write) → observe → reflect
        │   │       └── message (parent_id="section-writer_abc123...")
        │   ├── section-writer/started (id="sa2-act-uuid", node_type="agent")
        │   │   └── ROUND 1 (id="sub2-r1-uuid", parent_id="sa2-act-uuid")
        │   │       ├── perceive → think → act(workspace_write) → observe → reflect
        │   │       └── message (parent_id="section-writer_xyz789...")
        │   ├── section-writer/succeeded (子 agent 1)
        │   └── section-writer/succeeded (子 agent 2)
        ├── act/succeeded
        ├── observe/started → observe/succeeded
        └── reflect/started → reflect/succeeded
node_finished
workflow_finished (outputs: {answer, url}, error: null)
message_end (metadata: {usage: {...}})
```

---

## 风险评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| sub-agent 并发时 ExecutionFrame 栈混乱 | parent_id 错误 | `Promise.all` 下每个子 agent 是独立的 `spawnStreaming` 调用，共享 adapter 实例的 stack 会交叉。需要改为 Map 而非 Stack | 
| 子 agent 的 node_started/finished 被 adapter 误认为主 agent 的 | ROUND 计数错误 | Task 3 确保子 agent 事件在子 frame 下处理 |
| video-course / sim-training 使用 v1 streamAgent | 无 Dify 兼容 | Task 9 迁移 |

### 并发子 agent 的 ExecutionFrame 问题（关键风险）

当主 agent 并发调用 N 个 sub-agent（`spawnParallel`）时，所有子 agent 事件都推入同一个 channel，DifyStreamAdapter 的 `executionStack` 是单一 Array，无法区分不同子 agent 的事件归属。

**解决方案**：将 `executionStack` 改为 `Map<string, ExecutionFrame>`，key 为 `childTaskId`。在 `onAgentStarted` 时以 `child_task_id` 为 key 注册子 frame，在处理子 agent 转发的事件时通过 `child_task_id` 查找正确的 frame。

这需要：
1. 原生事件中 `agent_tool_started`/`agent_message` 等已包含 `child_task_id` ✓
2. 新转发的 `node_started`/`node_finished` 需要包装带 `child_task_id`（通过 SubAgentManager 的 forwardChildEvent 注入）

具体改造在 Task 2 和 Task 3 中一并实现。
