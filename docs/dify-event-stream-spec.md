# Dify 兼容事件流协议规范

> 协议版本：v2.3 | 生成时间：2026-03-20
> 激活方式：`.env` 中设置 `STREAM_PROTOCOL=dify`

---

## 一、公共信封（所有事件共享）

每个 SSE 事件的 JSON 顶层均包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `event` | `string` | 事件类型名 |
| `task_id` | `string` | 本次流的唯一 UUID，用于停止响应 |
| `conversation_id` | `string` | 会话 ID（= 原生 sessionId） |
| `message_id` | `string` | 消息 ID（= 原生 taskId） |
| `created_at` | `number` | Unix 时间戳（秒，含小数） |

---

## 二、事件类型总表

| # | event | 结构 | 说明 |
|---|-------|------|------|
| 1 | `workflow_started` | envelope + `data:{...}` | 任务开始 |
| 2 | `node_started` | envelope + `data:{...}` | 根 Agent 节点开始 |
| 3 | `agent_log` | envelope + `data:{...}` | Agent 内部步骤日志 |
| 4 | `message` | envelope + `id` + `answer` + `parent_id`（**扁平，无 data**） | 正文 / 思考流式片段 |
| 5 | `node_finished` | envelope + `data:{...}` | 根 Agent 节点结束 |
| 6 | `workflow_finished` | envelope + `data:{...}` | 任务结束 |
| 7 | `message_end` | envelope + `id` + `metadata` + `files`（**扁平，无 data**） | 消息结束统计 |
| 8 | `error` | envelope + `data:{...}` | 运行时错误 |
| 9 | `progress` | envelope + `data:{...}` | 自定义进度（扩展） |
| 10 | `ping` | SSE `data:` 为空 | 心跳保活 |

---

## 三、每种事件的精确字段

### 3.1 `workflow_started`

```json
{
  "event": "workflow_started",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920000.123,
  "data": {
    "id": "workflow_run_abcd1234",
    "workflow_run_id": "workflow_run_abcd1234",
    "agent_name": "document-generator",
    "inputs": {
      "sys.query": "用户原始问题全文",
      "sys.user_id": "user-123",
      "sys.tenant_id": "tenant-456"
    },
    "thread_id": "thread-uuid-or-null",
    "created_at": 1773920000.123
  }
}
```

| 字段路径 | 类型 | 说明 |
|----------|------|------|
| `data.id` | `string` | = workflow_run_id |
| `data.workflow_run_id` | `string` | 工作流运行实例 ID |
| `data.agent_name` | `string` | 根 Agent 名称 |
| `data.inputs` | `object` | 输入上下文；**`sys.query`、`sys.user_id`、`sys.tenant_id` 均在此对象内**，并与业务自定义 `inputs` 字段合并 |
| `data.inputs.sys.query` | `string` | 用户查询文本 |
| `data.inputs.sys.user_id` | `string` | 用户 ID |
| `data.inputs.sys.tenant_id` | `string` | 租户 ID |
| `data.thread_id` | `string?` | 线程 ID（可选） |
| `data.created_at` | `number` | 创建时间戳 |

---

### 3.2 `node_started`（根 Agent 节点）

```json
{
  "event": "node_started",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920000.123,
  "data": {
    "id": "1742476800000",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "node_type": "agent",
    "title": "document-generator",
    "parent_id": "",
    "index": 1,
    "inputs": null,
    "created_at": 1773920000.123
  }
}
```

| 字段路径 | 类型 | 说明 |
|----------|------|------|
| `data.id` | `string` | = node_execution_id |
| `data.node_id` | `string` | **纯数字字符串**（如 `"1742476800000"`），自增模拟 Dify 工作流节点在库中的 ID，同一运行内按分配顺序递增，**不再使用** `agent_${name}` 形式 |
| `data.node_execution_id` | `string` | 本次执行实例 ID（根节点上与 `node_id` 相同） |
| `data.node_type` | `"agent"` | 固定值，表示根 Agent |
| `data.title` | `string` | 节点标题（= agent_name） |
| `data.parent_id` | `string` | 父级 exec ID，根节点为 `""` |
| `data.index` | `number` | 节点序号（递增） |
| `data.inputs` | `object \| null` | 预留，当前为 `null` |
| `data.created_at` | `number` | 时间戳 |

---

### 3.3 `agent_log`（核心事件，所有内部步骤）

#### 3.3.0 ROUND 分组（每轮 ReAct 边界）

每次 **`perceive` 阶段开始**时，先于该轮 `perceive` 的 `started` 日志，额外发射一条 **`ROUND N`** 分组事件：

- `step` 固定为 `"round"`，`label` 为 `"ROUND 1"`、`"ROUND 2"` …（与轮次递增）。
- `status` 为 `"started"`；`id` 为本轮 **ROUND 的稳定 UUID**，后续本 Agent 在同一轮内的 perceive / think / act / observe / reflect 等 `agent_log` 的 **`parent_id` 均指向该 ROUND 的 `id`**。
- ROUND 事件的 **`parent_id` 当前实现恒为 `null`**（根 Agent 与子 Agent 均如此）；与「父 Agent 上那条启动子 Agent 的 `act` / `node_type: agent` 日志」的关联**不**写在 ROUND 的 `parent_id` 上，消费方可结合时间顺序、`node_id` / `node_execution_id` 所在栈帧及子 Agent 结束事件中的 `child_execution_id` 对齐子树（见 3.3.10）。

同一轮内事件父子关系：**`ROUND id` → 同帧内各阶段 `agent_log.id`（各自独立 UUID）**。

#### 3.3.1 ROUND 开始 + perceive 开始（同一轮）

```json
{
  "event": "agent_log",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920001.400,
  "data": {
    "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "parent_id": null,
    "label": "ROUND 1",
    "step": "round",
    "status": "started",
    "data": {},
    "error": null
  }
}
```

```json
{
  "event": "agent_log",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920001.500,
  "data": {
    "id": "11111111-2222-3333-4444-555555555555",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "parent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "label": "perceive",
    "step": "perceive",
    "status": "started",
    "data": {},
    "error": null
  }
}
```

#### 3.3.2 阶段结束（perceive / observe — 无 LLM 输出）

```json
{
  "event": "agent_log",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920002.100,
  "data": {
    "id": "66666666-7777-8888-9999-aaaaaaaaaaaa",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "parent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "label": "perceive",
    "step": "perceive",
    "status": "succeeded",
    "data": {},
    "error": null,
    "elapsed_time": 0.6,
    "output": ""
  }
}
```

#### 3.3.3 think 结束（含 LLM 完整输出）

`label` 在 think 成功结束时会带模型名，例如 `"deepseek-v3 Thought"`（由配置中的模型名决定）。

```json
{
  "event": "agent_log",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920010.800,
  "data": {
    "id": "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "parent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "label": "deepseek-v3 Thought",
    "step": "think",
    "status": "succeeded",
    "data": {},
    "error": null,
    "elapsed_time": 8.3,
    "output": "我需要根据用户提供的主题「电子电工原理」生成教学文稿。首先搜索知识库获取相关资料，然后规划文稿蓝图，最后调度子Agent并行写作各章节。"
  }
}
```

#### 3.3.4 reflect 结束（含反思 JSON 输出）

```json
{
  "event": "agent_log",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920120.000,
  "data": {
    "id": "cccccccc-dddd-eeee-ffff-000000000000",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "parent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "label": "reflect",
    "step": "reflect",
    "status": "succeeded",
    "data": {},
    "error": null,
    "elapsed_time": 3.2,
    "output": {
      "summary": "文稿已完成，共5个章节，内容涵盖电路基础、故障诊断等",
      "quality_score": 0.85,
      "should_continue": false
    }
  }
}
```

#### 3.3.5 工具调用开始（`step: "act"`，`node_type: "tool"`）

工具元数据放在 **`data.data`**（扩展载荷）中；`label` 为人类可读摘要，如 **`CALL knowledge_search`**。

```json
{
  "event": "agent_log",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920011.000,
  "data": {
    "id": "dddddddd-eeee-ffff-0000-111111111111",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "parent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "label": "CALL knowledge_search",
    "step": "act",
    "status": "started",
    "node_type": "tool",
    "data": {
      "tool_name": "knowledge_search",
      "tool_call_id": "call_abc123",
      "tool_input": {
        "query": "电子电工原理 故障诊断",
        "dataset_id": "53bc2550-..."
      }
    },
    "error": null
  }
}
```

#### 3.3.6 工具调用结束（结果在 `data.data.output`）

工具返回体位于 **`data.data.output`**（对象，内含 `tool_call_id` / `tool_call_name` / `tool_response`）。**不要**与 think/reflect 阶段顶层的 **`data.output`** 混淆（见下文「嵌套结构」）。

```json
{
  "event": "agent_log",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920014.500,
  "data": {
    "id": "eeeeeeee-ffff-0000-1111-222222222222",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "parent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "label": "CALL knowledge_search",
    "step": "act",
    "status": "succeeded",
    "node_type": "tool",
    "data": {
      "output": {
        "tool_call_id": "call_abc123",
        "tool_call_name": "knowledge_search",
        "tool_response": "[搜索结果内容...]"
      }
    },
    "error": null,
    "elapsed_time": 3.5
  }
}
```

#### 3.3.7 工具调用失败

失败时 **`error`** 为错误字符串；`data` 内仍可携带与调用相关的字段。

```json
{
  "event": "agent_log",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920015.000,
  "data": {
    "id": "ffffffff-0000-1111-2222-333333333333",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "parent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "label": "CALL knowledge_search",
    "step": "act",
    "status": "failed",
    "node_type": "tool",
    "data": {
      "output": {
        "tool_call_id": "call_abc123",
        "tool_call_name": "knowledge_search",
        "tool_response": null
      }
    },
    "error": "Dataset not found: 53bc2550-...",
    "elapsed_time": 0.8
  }
}
```

#### 3.3.8 子 Agent 启动（`step: "act"`，`node_type: "agent"`）

子 Agent **不再使用** `label: "sub_agent"`：启动时发射 **`act` / `started`**，**`node_type` 为 `"agent"`**，`label` 一般为 **子 Agent 名称**（如 `section-writer`）。事件挂在 **父 Agent 帧**上（`node_id` / `node_execution_id` 为父 Agent）。**`parent_id` 指向父 Agent 当前轮的 ROUND id**。

```json
{
  "event": "agent_log",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920030.000,
  "data": {
    "id": "10101010-abcd-ef01-2345-6789abcdef01",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "parent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "label": "section-writer",
    "step": "act",
    "status": "started",
    "node_type": "agent",
    "data": {
      "agent_name": "section-writer",
      "child_task_id": "child-task-uuid",
      "instruction": "请为「第一章：电路基础」撰写内容..."
    },
    "error": null
  }
}
```

#### 3.3.9 子 Agent 结束（仍在父帧上）

```json
{
  "event": "agent_log",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920060.000,
  "data": {
    "id": "20202020-bcde-f012-3456-789abcdef012",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "parent_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "label": "section-writer",
    "step": "act",
    "status": "succeeded",
    "node_type": "agent",
    "data": {
      "agent_name": "section-writer",
      "child_task_id": "child-task-uuid",
      "child_execution_id": "exec_cc502ee6"
    },
    "error": null,
    "output": "章节已写入 sections/01-电路基础.md",
    "elapsed_time": 30.0
  }
}
```

#### 3.3.10 子 Agent 内部事件（perceive / think / act 等）

子 Agent 入栈后，其 **perceive / think / act / observe / reflect** 均通过 **`agent_log`** 输出；`node_id` / `node_execution_id` 为 **子 Agent 的数字 ID 与 `exec_xxxxxxxx` 执行 ID**。子 Agent 自己的每一轮同样先有 **`ROUND N`**（`step: "round"`），该子轮内各阶段的 **`parent_id` 指向子 Agent 的 ROUND id**。

**`parent_id` 链路（逻辑树）**：子 Agent 的 **perceive / think / act …** → 子 Agent **该轮 ROUND 的 `id`**；再往上的 **父 Agent `act`（`node_type: agent`）** 在 `parent_id` 上指向的是 **父轮 ROUND**，而非子 ROUND。跨帧关联：子 Agent 结束事件的 `data.data.child_execution_id` 等于该子 Agent 帧的 `node_execution_id`，可与子树内所有 `agent_log` / `message` 对齐。

#### 3.3.11 子 Agent 内部工具调用（示例）

```json
{
  "event": "agent_log",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920040.000,
  "data": {
    "id": "30303030-cdef-0123-4567-89abcdef0123",
    "node_id": "1742476800001",
    "node_execution_id": "exec_cc502ee6",
    "parent_id": "77777777-8888-9999-aaaa-bbbbbbbbbbbb",
    "label": "CALL workspace_write",
    "step": "act",
    "status": "started",
    "node_type": "tool",
    "data": {
      "tool_name": "workspace_write",
      "tool_call_id": "call_def456",
      "tool_input": {
        "name": "sections/01-电路基础.md",
        "content": "# 第一章 电路基础\n\n..."
      }
    },
    "error": null
  }
}
```

#### 3.3.12 嵌套结构说明（`data` 与 `output`）

> **双层 / 三层含义**：SSE 事件最外层的 `data` 是**事件体**；其下的 `data`（即 **`data.data`**）是 **`agent_log` 专用扩展载荷**。因此 JSON 路径上会出现 **`data.data`**（外层 `data` + 内层字段名 `data`），这是预期结构，不是笔误。

| 路径 | 含义 |
|------|------|
| 事件体 **`data`** | SSE JSON 上、`agent_log` 的载荷对象（与 `workflow_started` 等同级的 `data`） |
| **`data.data`** | `agent_log` 内统一的扩展字段（工具入参、工具结果包装、子 Agent 元数据等），无扩展时为 **`{}`** |
| **`data.data.output`** | 工具结果对象（在「事件体 `data` → 扩展 `data` → `output`」共 **三层路径**）：内含 `tool_call_id` / `tool_call_name` / `tool_response` |
| **`data.output`**（与 **`data.data`** 平级，同属事件体 `data`） | **阶段级**完整输出：think / reflect 的完整文本或 JSON，或子 Agent 结束摘要等；**不要**与工具结果 `data.data.output` 混淆 |

#### 3.3.13 流式 vs 非流式（think 与 `message`）

- **流式模式**：think 进行过程中会额外产生 **`message` 事件**（`answer` 为增量片段），用于前端打字机效果；**`think` 阶段 `succeeded` 的 `agent_log` 仍必须在 `data.output` 中携带完整思考文本**。
- **非流式模式**：可无中途 `message`，**但 `think` `succeeded` 的 `data.output` 仍须为完整文本**，与流式一致，便于日志与回放。

---

### agent_log 完整字段表

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` (UUID) | 是 | 本条 `agent_log` 唯一 ID；**ROUND 行的 `id` 即该轮分组 ID**，供同轮子事件 `parent_id` 引用 |
| `node_id` | `string` | 是 | 所属 Agent 节点 ID（纯数字字符串） |
| `node_execution_id` | `string` | 是 | 所属 Agent 本次执行 ID（根节点与 `node_id` 相同；子 Agent 为 `exec_` 前缀短 UUID） |
| `parent_id` | `string \| null` | 是 | **父日志 ID**：一般为当前 Agent **当前轮 ROUND 的 `id`**；**启动子 Agent** 的 `act` / `node_type: agent` 日志的 `parent_id` 指向**父 Agent 该轮 ROUND**；**ROUND 行自身**为 `null` |
| `label` | `string` | 是 | **动态展示文案**，如 `"ROUND 1"`、`"perceive"`、`"CALL knowledge_search"`、`"deepseek-v3 Thought"`、子 Agent 名等（**不再限定为固定枚举**） |
| `step` | `string` | 是 | 固定阶段名：`perceive` / `think` / `act` / `observe` / `reflect` / **`round`** |
| `status` | `"started" \| "succeeded" \| "failed" \| "stopped"` | 是 | 生命周期状态 |
| `node_type` | `string` | 否 | `"tool"`：工具调用；**`"agent"`**：子 Agent 启停（`step` 仍为 `act`） |
| `data` | `object` | 是 | 扩展载荷，默认 **`{}`**；工具参数见 `tool_name` / `tool_call_id` / `tool_input`；**工具结果**在 **`data.data.output`**（勿与阶段级 `data.output` 混淆） |
| `error` | `string \| null` | 是 | 统一错误字段，无错误为 **`null`** |
| `output` | `unknown` | 否 | **阶段级**输出（think / reflect 全文、子 Agent 结束摘要等）；与 **`data.data.output`（工具结果）** 区分 |
| `elapsed_time` | `number` | 否 | 耗时（秒） |

> **已迁移进 `data` 的字段**（不要再期待顶层重复）：工具名称、调用 ID、入参、子 Agent 的 `agent_name` / `instruction` / `child_task_id` / `child_execution_id` 等均放在 **`data.data`** 中，具体形状见上文示例。

---

### 3.4 `message`（流式片段 — 扁平结构）

```json
{
  "event": "message",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920045.000,
  "id": "task_xxxxxxxx",
  "parent_id": null,
  "answer": "# 第一章 电路基础\n\n电路是由电源、导线、开关和用电器组成的..."
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | = message_id |
| `parent_id` | `string \| null` | **输出来源**：根 Agent 正文流式为 **`null`**；来自子 Agent 的正文或思考流式时，为 **该子 Agent 的 `node_execution_id`**（`exec_xxxxxxxx`），便于前端将片段挂到对应子树 |
| `answer` | `string` | 本次流式文本片段 |

> **注意**：`message` 事件**没有 `data` 包装层**，`id`、`parent_id`、`answer` 直接在顶层。

**message 内容来源**：

- 路由层拦截子 Agent 的 `workspace_write` 等路径，将写入正文的增量注入为 `message`（`parent_id` 指向子 Agent 执行 ID）。
- **流式 think**：原生 `thinking` 流会映射为 `message`（打字机）；**无论是否流式**，think 结束时的 **`agent_log`（think / succeeded）仍须在 `data.output` 中带全文**（见 3.3.13）。

---

### 3.5 `node_finished`（根 Agent 节点结束）

```json
{
  "event": "node_finished",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920130.000,
  "data": {
    "id": "1742476800000",
    "node_id": "1742476800000",
    "node_execution_id": "1742476800000",
    "node_type": "agent",
    "title": "document-generator",
    "parent_id": "",
    "index": 15,
    "inputs": null,
    "status": "succeeded",
    "outputs": {
      "answer": "# 第一章 电路基础\n\n...\n\n# 第二章 ...",
      "url": "http://192.168.50.54:7800/api/files/tenants/default/users/default/workspaces/session-uuid/artifacts/document.md"
    },
    "error": null,
    "elapsed_time": 130.0,
    "usage": {
      "prompt_tokens": 15000,
      "completion_tokens": 8000,
      "total_tokens": 23000
    },
    "created_at": 1773920130.000
  }
}
```

---

### 3.6 `workflow_finished`

```json
{
  "event": "workflow_finished",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920130.000,
  "data": {
    "id": "workflow_run_abcd1234",
    "workflow_run_id": "workflow_run_abcd1234",
    "status": "succeeded",
    "outputs": {
      "answer": "# 第一章 电路基础\n\n...\n\n# 第二章 ...",
      "url": "http://192.168.50.54:7800/api/files/..."
    },
    "error": null,
    "elapsed_time": 130.0,
    "total_tokens": 23000,
    "total_steps": 0,
    "created_at": 1773920000.123,
    "finished_at": 1773920130,
    "exceptions_count": 0,
    "files": []
  }
}
```

| 字段路径 | 类型 | 说明 |
|----------|------|------|
| `data.status` | `"succeeded" \| "failed" \| "stopped"` | 终态 |
| `data.outputs` | `object` | 结构化输出 |
| `data.outputs.answer` | `string` | 全部正文累积内容 |
| `data.outputs.url` | `string` | 文档下载地址 |
| `data.error` | `string \| null` | 错误信息，成功/停止时为 `null` |
| `data.elapsed_time` | `number` | 总耗时（秒） |
| `data.total_tokens` | `number` | 总 token 消耗 |
| `data.finished_at` | `number` | 完成 Unix 时间戳（秒） |

---

### 3.7 `message_end`（扁平结构，在 workflow_finished 之后）

```json
{
  "event": "message_end",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920130.100,
  "id": "task_xxxxxxxx",
  "metadata": {
    "annotation_reply": null,
    "retriever_resources": [],
    "usage": {
      "prompt_tokens": 15000,
      "completion_tokens": 8000,
      "total_tokens": 23000
    }
  },
  "files": []
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | = message_id |
| `metadata.annotation_reply` | `null` | 预留注释回复 |
| `metadata.retriever_resources` | `array` | 检索资源引用列表 |
| `metadata.usage` | `object?` | Token 用量统计 |
| `files` | `array` | 关联文件列表 |

> **注意**：`message_end` **没有 `data` 包装层**。

---

### 3.8 `error`

```json
{
  "event": "error",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920050.000,
  "data": {
    "code": "AGENT_EXECUTION_FAILED",
    "message": "Tool execution timeout after 300s",
    "status": 500,
    "recoverable": false
  }
}
```

---

### 3.9 `progress`（自定义扩展）

```json
{
  "event": "progress",
  "task_id": "a1b2c3d4-...",
  "conversation_id": "session-uuid",
  "message_id": "task_xxxxxxxx",
  "created_at": 1773920040.000,
  "data": {
    "message": "正在搜索知识库...",
    "percentage": 25,
    "phase": "research",
    "metadata": {}
  }
}
```

---

### 3.10 `ping`

```
event: ping
data: 
```

> 纯心跳，data 为空。无 JSON 内容。

---

## 四、完整事件流序列（document-generation 正常场景）

以下是一次完整的文稿生成从头到尾的**示意**顺序。子 Agent **并发**时，下列步骤在时间上可能**交叉、乱序**；若开启流式 think，在 `think` 的 `started` 与 `succeeded` 之间还可能穿插多条 **`message`**（`answer` 为增量，`parent_id` 规则同下）。

```
 #  事件                      说明
─── ───────────────────────── ─────────────────────────────────
 1  workflow_started           任务启动；`data.inputs` 内含 `sys.query` / `sys.user_id` / `sys.tenant_id`
 2  node_started(agent)        根 Agent；`node_id` 与 `node_execution_id` 均为纯数字串（如 `1742476800000`）

    ─── 第 1 轮（每次 `perceive` 开始前先发 ROUND）───
 3  agent_log(round,started)   `label:"ROUND 1"`, `step:"round"`, `parent_id:null`
 4  agent_log(perceive,started) `parent_id` → 步骤 3 的 ROUND id
 5  agent_log(perceive,succeeded)
 6  agent_log(think,started)
    message(...)               流式时：思考打字机片段，`parent_id:null`（根 Agent）
 7  agent_log(think,succeeded) `data.output` **始终**为思考全文（与是否流式无关）
 8  agent_log(act,started)     act 阶段（若原生协议有独立 act 起止）
 9  agent_log(act,started,     工具：知识库检索
       node_type:tool,
       label:"CALL knowledge_search")
10  agent_log(act,succeeded,   工具结果在 `data.data.output`
       node_type:tool)
11  agent_log(act,succeeded)   act 阶段结束（若有）
12  agent_log(observe,started)
13  agent_log(observe,succeeded)

    ─── 第 2 轮 ───
14  agent_log(round,started)   `label:"ROUND 2"`
15  agent_log(perceive,started)
16  agent_log(perceive,succeeded)
17  agent_log(think,started)
18  agent_log(think,succeeded, output:"…规划章节，调用 spawn_parallel_agents…")
19  agent_log(act,started)
20  agent_log(act,started,
       node_type:tool,
       tool_name:spawn_parallel_agents)

    ─── 子 Agent 并发（均在父帧上先出现 `act`/`agent`/`started`）───
21  agent_log(act,started,     子 Agent 1 启动（非 sub_agent 枚举）
       node_type:agent,
       label:section-writer,
       parent_id 为父 Agent 第 2 轮 ROUND 的 id
22  agent_log(act,started, node_type:agent, …)   子 Agent 2
23  agent_log(act,started, node_type:agent, …)   子 Agent 3

    — 子 Agent 1 内部（`node_id` 为新数字串，`node_execution_id:exec_xxxxxxxx`）—
24  agent_log(round,started)   子帧 `ROUND 1`，`parent_id:null`
25  agent_log(perceive,started) `parent_id` → 子 ROUND id
    … think / act / observe …（`parent_id` 均挂子 Agent 当前轮 ROUND）

    — 子 Agent 1：`workspace_write` —
26  agent_log(act,started,
       node_type:tool,
       node_id:1742476800001,
       node_execution_id:exec_c1)
27  message(answer:"# 第一章…", parent_id:exec_c1)
28  message(answer:"…", parent_id:exec_c1)
29  agent_log(act,succeeded, node_type:tool, node_execution_id:exec_c1)

    — 子 Agent 3 / 2 类似（顺序可能交错）—
30  … workspace_write + message(parent_id:exec_c3) …
31  … workspace_write + message(parent_id:exec_c2) …

    — 子 Agent 结束（仍在父帧：`node_id` 仍为父根数字 id）—
32  agent_log(act,succeeded,   子 Agent 1 结束
       node_type:agent,
       label:section-writer,
       data.data.child_execution_id:exec_c1)
33  agent_log(act,succeeded, node_type:agent, … exec_c3)
34  agent_log(act,succeeded, node_type:agent, … exec_c2)
35  agent_log(act,succeeded,  spawn_parallel_agents 工具返回
       node_type:tool)
36  agent_log(act,succeeded)
37  agent_log(observe,started)
38  agent_log(observe,succeeded)

    ─── 第 3 轮（组装成稿）───
39  agent_log(round,started)   `ROUND 3`
40  agent_log(perceive,started)
41  agent_log(perceive,succeeded)
42  agent_log(think,started)
43  agent_log(think,succeeded, output:"…执行组装…")
44  agent_log(act,started)
45  agent_log(act,started, node_type:tool, workspace_write 最终文档)
46  agent_log(act,succeeded, node_type:tool)
47  agent_log(act,succeeded)
48  agent_log(observe,started)
49  agent_log(observe,succeeded)

    ─── 反思（仍在最后一轮 ROUND 下，或按实现挂在当前帧 ROUND）───
50  agent_log(reflect,started)
51  agent_log(reflect,succeeded,
       data.output:{summary:"…",quality_score:0.85,should_continue:false})

    ─── 结束 ───
52  node_finished(agent)
53  workflow_finished
54  message_end
```

---

## 五、三种终止场景

### 5.1 正常完成（succeeded）

```
... 正常事件流 ...
workflow_finished  → status:"succeeded", outputs:{answer:"...",url:"..."}, error:null
message_end        → metadata.usage:{prompt_tokens:...,total_tokens:...}
```

### 5.2 错误中断（failed）

```
... 部分事件流 ...
error              → code:"AGENT_EXECUTION_FAILED", message:"..."
workflow_finished  → status:"failed", outputs:{}, error:"具体错误描述字符串"
（无 message_end）
```

### 5.3 用户停止（stopped）

```
... 部分事件流 + 部分 message ...
workflow_finished  → status:"stopped", outputs:{answer:"停止前已输出内容",url:"..."}, error:null
message_end        → metadata.usage:{...}
```

---

## 六、ID 体系说明

| ID | 生成方式 | 作用域 | 说明 |
|----|----------|--------|------|
| `task_id` | `randomUUID()` | 每次流 | Dify 停止任务用，全局唯一 |
| `conversation_id` | = 原生 `sessionId` | 跨流 | 会话标识，持久化 |
| `message_id` | = 原生 `taskId` | 每次流 | 消息标识 |
| `workflow_run_id` | `workflow_run_${uuid8}` | 每次流 | 工作流运行实例 |
| `node_id` | 自增纯数字字符串（自 `Date.now()` 起递增） | 稳定（单次运行内） | 模拟 Dify 节点库 ID；**同一 Agent 名称在不同次运行中数字可能不同** |
| `node_execution_id` | **根 Agent**：与 `node_id` 相同（纯数字）；**子 Agent**：`exec_${uuid8前8位}` | 每次执行 | 根节点无单独 `exec_` 前缀；子 Agent 每次入栈生成新的 `exec_` ID |
| `child_execution_id` | 与对应子 Agent 的 `node_execution_id` 相同（`exec_` + `randomUUID` 截断前 8 位） | 子 Agent | 出现在父帧上子 Agent 结束日志的 `data.data` 中，用于对齐子树 |
| `tool_call_id` | LangChain 生成 | 每次工具调用 | 关联 tool_started ↔ tool_finished |

---

## 七、REST API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/conversations` | 查询会话列表 |
| `GET` | `/v1/messages` | 查询会话消息历史 |
| `DELETE` | `/v1/conversations/:id` | 删除会话 |
| `POST` | `/v1/chat-messages/:task_id/stop` | 停止响应（task_id = SSE 中的 task_id） |
