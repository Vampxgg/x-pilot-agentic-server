# Fix: agent_log output 位置 + 主/子 agent 流式模式 + message_end usage

---

## 问题分析

### 问题 1: agent_log 的 output 位置错误

**现状**: `buildAgentLog` 将 `output` 放在外层 `data.output`

```json
{
    "event": "agent_log",
    "data": {
        "id": "...",
        "label": "LLM Thought",
        "step": "think",
        "status": "succeeded",
        "data": {},                    ← 内层 data 为空
        "error": null,
        "output": "LLM完整文本",       ← 错误：在外层 data.output
        "elapsed_time": 12.375
    }
}
```

**期望**: `output` 应在 `data.data.output`（内层 data 中），与工具结果的 `data.data.output` 一致

```json
{
    "event": "agent_log",
    "data": {
        "id": "...",
        "label": "LLM Thought",
        "step": "think",
        "status": "succeeded",
        "data": {
            "output": "LLM完整文本"    ← 正确：在 data.data.output
        },
        "error": null,
        "elapsed_time": 12.375
    }
}
```

**注意**: `node_finished` 事件（非 agent_log）保持 `data.output` 不变，不受此修改影响。

### 问题 2: 主 agent / 子 agent 流式模式不正确

**现状**: `agent-runtime.ts` 中 `streamAgentV2` 对所有 agent（主 + 子）统一使用 blocking 模式：

```typescript
// agent-runtime.ts:600-606
if (item.kind === "message_token") {
  if (item.nodeName === "think") {
    thinkTokenBuffer += item.token;  // ALL agents buffer tokens
  }
  continue;  // NO message events emitted
}
```

子 agent 通过 `SubAgentManager.spawnStreaming` → `agentRuntime.streamAgentV2` 运行，复用相同逻辑，因此子 agent 的 think 也是 blocking 的。

**期望**:
- **主 agent**: blocking 模式 — think 不输出 message 事件 ✅（已实现）
- **子 agent**: streaming 模式 — think 输出 message 事件（打字机效果）

**影响**: 由于子 agent 不输出 message 事件，`routes.ts` 中 `accumulatedAnswer` 无法从 `agent_message` 事件累积内容，导致 `outputs.answer` 为空。

### 问题 3: outputs.answer 为空

**根因**: 与问题 2 直接关联。`accumulatedAnswer` 目前只从以下来源累积：
1. `message` 事件的 delta（主 agent 不发 → 无内容）
2. `agent_message` 事件的 delta（子 agent 不发 → 无内容）
3. `agent_tool_started` 拦截 `workspace_write` 写入 sections/*.md 的内容

当 workspace_write 拦截未命中时，`accumulatedAnswer` 为空 → `outputs.answer = ""`。

**修复**: 实现子 agent streaming 模式后，子 agent think tokens 会作为 `message` 事件发出 → 转发为 `agent_message` → 累积到 `accumulatedAnswer`。

### 问题 4: message_end 缺少 usage 信息

**现状**: `routes.ts` 调用 `createMessageEnd(ctx, accumulatedAnswer)` 未传递 usage

```typescript
// routes.ts:393-394
writer.write(createMessageEnd(writer.streamContext, accumulatedAnswer));
// 第三个参数 usage? 未传递
```

**期望**: `message_end` 的 `metadata.usage` 应包含完整 token 信息

---

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/core/dify/stream-adapter.ts` | **修改** | Fix 1: buildAgentLog output → data.data.output |
| `src/core/types.ts` | **修改** | Fix 2: AgentConfig 添加 `streamMode` 字段 |
| `src/core/agent-runtime.ts` | **修改** | Fix 2: 解析 streamMode 配置 + 调用级覆盖 |
| `src/core/sub-agent-manager.ts` | **修改** | Fix 2: StreamAgentInvoker 类型签名更新 |
| `apps/document-generation/section-writer/agent.config.yaml` | **修改** | Fix 2: 添加 `streamMode: stream` |
| `apps/document-generation/code/routes.ts` | **修改** | Fix 4: 传递 usage 给 createMessageEnd |
| `apps/video-course/code/routes.ts` | **修改** | Fix 4: 同步修改 |
| `apps/sim-training/code/routes.ts` | **修改** | Fix 4: 同步修改 |

---

## Fix 1: agent_log output → data.data.output

**文件**: `src/core/dify/stream-adapter.ts`

### 改动: `buildAgentLog` 方法

**当前代码** (line 576-610):

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
    data?: Record<string, unknown>;
    error?: string | null;
    output?: unknown;
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
      step: opts.step as any,
      status: opts.status,
      node_type: opts.nodeType,
      data: opts.data ?? {},                                              // 内层 data
      error: opts.error ?? null,
      ...(opts.output !== undefined ? { output: opts.output } : {}),      // ← 外层 data.output (错误)
      ...(opts.elapsed_time !== undefined ? { elapsed_time: opts.elapsed_time } : {}),
    },
  } as DifyEvent;
}
```

**改为**:

```typescript
private buildAgentLog(
  frame: ExecutionFrame | undefined,
  opts: {
    // ... 参数不变
  },
  ts: number,
): DifyEvent {
  // 合并 output 到内层 data 中
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
      data: innerData,                                                     // output 现在在 data.data.output
      error: opts.error ?? null,
      ...(opts.elapsed_time !== undefined ? { elapsed_time: opts.elapsed_time } : {}),
    },
  } as DifyEvent;
}
```

**效果对比**:

| 事件类型 | 修改前 | 修改后 |
|---------|--------|--------|
| think succeeded | `data.output = "LLM文本"`, `data.data = {}` | `data.data = { output: "LLM文本" }` |
| reflect succeeded | `data.output = "反思结果"`, `data.data = {}` | `data.data = { output: "反思结果" }` |
| tool succeeded | `data.data = { output: { tool_call_id... } }` | 不变（已在 data.data.output） |
| agent finished | `data.output = "子agent结果"`, `data.data = {agent_name...}` | `data.data = { agent_name..., output: "子agent结果" }` |

**注意**: `node_finished` 事件不受影响，它使用 `DifyNodeFinishedData` 结构，output 在 `data.outputs` 中。

---

## Fix 2: Agent 级别 stream/block 模式配置

### 设计: 三级优先级

```
调用级 streamThinkTokens（最高） > agent.config.yaml streamMode > 默认 "block"
```

| 层级 | 设置位置 | 说明 |
|------|---------|------|
| Agent 配置级 | `agent.config.yaml` 中 `streamMode: "stream" \| "block"` | 每个 agent 自己决定默认模式 |
| 调用级覆盖 | `streamAgentV2(name, input, { streamThinkTokens: true/false })` | 调用方可覆盖 agent 配置 |
| 全局默认 | `"block"` | 未配置时默认 blocking |

**典型配置示例**:

| Agent | streamMode | 效果 |
|-------|-----------|------|
| document-generator（主 agent） | `block`（默认） | think 不输出 message，只有 node_finished 有完整 output |
| section-writer（子 agent） | `stream` | think 实时输出 message 事件（打字机效果），node_finished 也有完整 output |
| sim-training-director | `block` | 主 agent blocking |
| video-course-director | `block` | 主 agent blocking |

### Step 1: types.ts — AgentConfig 添加 streamMode

在 `AgentConfig` 接口中添加:

```typescript
export interface AgentConfig {
  model: string;
  // ... 现有字段 ...
  streamMode?: "stream" | "block";  // LLM think 输出模式，默认 "block"
}
```

### Step 2: agent.config.yaml — 为需要 streaming 的 agent 添加配置

**section-writer** (`apps/document-generation/section-writer/agent.config.yaml`):

```yaml
model: google/gemini-2.5-flash
streamMode: stream   # ← 新增：子 agent 流式输出
# ... 其余不变
```

**document-generator** 不加（默认 block），其他主 agent 同理。

### Step 3: agent-runtime.ts — streamAgentV2 解析 streamMode

**当前 `streamAgentV2` 签名**:

```typescript
async *streamAgentV2(
  agentName: string,
  input: string,
  options?: { threadId?: string; sessionId?: string; context?: Record<string, unknown>; tenantId?: string; userId?: string; skipPipeline?: boolean },
): AsyncGenerator<StreamEvent<StreamEventTypeName>> {
```

**改为**: 在 options 中添加 `streamThinkTokens?: boolean`（调用级覆盖）

```typescript
async *streamAgentV2(
  agentName: string,
  input: string,
  options?: {
    threadId?: string;
    sessionId?: string;
    context?: Record<string, unknown>;
    tenantId?: string;
    userId?: string;
    skipPipeline?: boolean;
    streamThinkTokens?: boolean;  // 调用级覆盖，优先于 agent config
  },
): AsyncGenerator<StreamEvent<StreamEventTypeName>> {
```

**在函数体内解析最终模式**（在 `streamAgentV2` 开头，agentDef 加载之后）:

```typescript
// 三级优先级：调用级 > agent config > 默认 block
const shouldStreamThink = options?.streamThinkTokens
  ?? (agentDef.config.streamMode === "stream")
  ?? false;
```

**当前 message_token 处理** (line 600-606):

```typescript
if (item.kind === "message_token") {
  if (item.nodeName === "think") {
    thinkTokenBuffer += item.token;
  }
  continue;
}
```

**改为**:

```typescript
if (item.kind === "message_token") {
  if (item.nodeName === "think") {
    thinkTokenBuffer += item.token;
    if (shouldStreamThink) {
      yield createMessage(ctx, item.token);
    }
  }
  continue;
}
```

**关键逻辑**:
- `shouldStreamThink = false`: agent 行为不变，think tokens 仅 buffer，不输出 message
- `shouldStreamThink = true`: 额外输出 `createMessage(ctx, token)` 事件（打字机效果）
- **两种模式下 `thinkTokenBuffer` 都会累积**，确保 `node_finished(think).data.data.output` 始终有完整 blocking 文本

### Step 4: sub-agent-manager.ts — StreamAgentInvoker 类型签名更新

**当前** (line 25-29):

```typescript
type StreamAgentInvoker = (
  agentName: string,
  input: string,
  options?: { threadId?: string; sessionId?: string; context?: Record<string, unknown>; tenantId?: string; userId?: string },
) => AsyncGenerator<StreamEvent<StreamEventTypeName>>;
```

**改为**:

```typescript
type StreamAgentInvoker = (
  agentName: string,
  input: string,
  options?: { threadId?: string; sessionId?: string; context?: Record<string, unknown>; tenantId?: string; userId?: string; streamThinkTokens?: boolean },
) => AsyncGenerator<StreamEvent<StreamEventTypeName>>;
```

**注意**: `spawnStreaming` 调用 **不需要**硬编码 `streamThinkTokens: true`，因为子 agent 的 `agent.config.yaml` 中已配置 `streamMode: stream`。`streamAgentV2` 内部会自动读取。但如果调用方想覆盖，仍然可以传入。

### 事件流变化

**streamMode: block（document-generator 主 agent）**:
```
node_started(think) → (silent, tokens buffered) → node_finished(think, output: "完整文本")
```

**streamMode: stream（section-writer 子 agent）**:
```
node_started(think) → message("我") → message("需要") → message("搜索") → ... → node_finished(think, output: "完整文本")
```

这些 `message` 事件通过 `forwardChildEvent` 转发为 `agent_message` → adapter 的 `onAgentMessage` 转为 flat message event（含 `parent_id`）→ routes.ts 累积到 `accumulatedAnswer`。

### 灵活性示例

如果未来某个主 agent 也需要 streaming（例如交互式对话场景），只需在其 `agent.config.yaml` 中添加:

```yaml
streamMode: stream
```

无需改任何代码。反之，如果某个子 agent 不需要 streaming:

```yaml
streamMode: block  # 或不配置（默认 block）
```

调用级覆盖的场景：同一个 agent 在不同业务中需要不同模式:

```typescript
// 在某个特殊路由中强制 streaming
agentRuntime.streamAgentV2("document-generator", input, {
  streamThinkTokens: true,  // 覆盖 agent 配置的 block
});
```

---

## Fix 3: outputs.answer 累积（无额外代码改动）

Fix 2 实现后，子 agent 的 message 事件会通过 `forwardChildEvent` 转发为 `agent_message`。

`routes.ts` 已有累积逻辑：

```typescript
if (event.event === "agent_message") {
  accumulatedAnswer += (event.data as { delta?: string }).delta ?? "";
}
```

此逻辑无需改动，Fix 2 完成后 `accumulatedAnswer` 自然会包含子 agent 的流式输出内容。

---

## Fix 4: message_end 传递 usage

### Step 1: routes.ts — 从 task_finished 提取 usage 并传给 createMessageEnd

**当前代码** (document-generation/routes.ts, line 372-395):

```typescript
if (event.event === "task_finished") {
  streamCompleted = true;
  const downloadUrl = buildDownloadUrl(tenantId, userId, sessionId);
  const data = event.data as TaskFinishedData;
  data.outputs = {
    answer: accumulatedAnswer,
    url: downloadUrl,
  };
}

// ... accumulate messages ...

writer.write(event);

if (event.event === "task_finished") {
  writer.write(createMessageEnd(writer.streamContext, accumulatedAnswer));  // ← 缺少 usage
}
```

**改为**:

```typescript
let lastUsage: import("../../../src/core/types.js").TokenUsage | undefined;

// ... 在循环内 ...

if (event.event === "task_finished") {
  streamCompleted = true;
  const downloadUrl = buildDownloadUrl(tenantId, userId, sessionId);
  const data = event.data as TaskFinishedData;
  lastUsage = data.usage;
  data.outputs = {
    answer: accumulatedAnswer,
    url: downloadUrl,
  };
}

// ... accumulate messages ...

writer.write(event);

if (event.event === "task_finished") {
  writer.write(createMessageEnd(writer.streamContext, accumulatedAnswer, lastUsage));
}
```

### Step 2: 同步修改其他业务线

`apps/video-course/code/routes.ts` 和 `apps/sim-training/code/routes.ts` 做同样的 usage 传递修改。

### Step 3: 同步修改 incomplete stream 的 message_end

对于用户停止（aborted）场景，也传递 usage（如有的话）：

```typescript
if (writer.abortSignal?.aborted) {
  writer.write(createTaskFinished(ctx, {
    status: "stopped",
    outputs: { answer: accumulatedAnswer, url: downloadUrl },
    elapsedTime: elapsed,
  }));
  writer.write(createMessageEnd(ctx, accumulatedAnswer, lastUsage));
}
```

---

## 验证清单

- [ ] agent_log 事件的 output 在 `data.data.output` 中
- [ ] node_finished 事件的 output 保持在 `data.outputs` 中
- [ ] `streamMode: block` 的 agent think 不输出 message 事件
- [ ] `streamMode: stream` 的 agent think 输出 message 事件（打字机效果）
- [ ] 无论 stream/block，think succeeded 的 `data.data.output` 都包含完整 blocking 文本
- [ ] 调用级 `streamThinkTokens` 可覆盖 agent 配置
- [ ] `agent.config.yaml` 中 `streamMode` 字段被正确解析
- [ ] `workflow_finished.outputs.answer` 包含所有累积内容
- [ ] `node_finished.outputs.answer` 包含所有累积内容
- [ ] `message_end.metadata.usage` 包含 token 信息
- [ ] 编译零错误
