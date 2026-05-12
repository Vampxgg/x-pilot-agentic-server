# 网页应用 Agent SSE 流式数据文档

本文档面向前端开发，说明 `interactive-tutorial` 业务接口返回的 SSE 流式数据如何读取、解析和落地到界面。

适用接口：

- `POST /api/business/interactive-tutorial/chat-stream`
- `POST /api/business/interactive-tutorial/generate-stream`（已废弃，但流格式相同）
- `POST /api/business/interactive-tutorial/edit-stream`（已废弃，但流格式相同）

---

## 1. 先说结论

前端需要重点处理这几类事件：

1. `message`：增量文本，可用于聊天输出打字机效果
2. `progress`：阶段进度，可用于步骤提示/进度条
3. `tool_started` / `tool_finished`：工具调用过程，可用于展示“正在生成/正在重建”
4. `task_finished`：最终结果，最重要
5. `error`：错误提示
6. `done`：流结束标记

业务成功判定建议：

- 以 `task_finished.data.status === "succeeded"` 为主
- 如果 `task_finished.data.outputs?.tutorialUrl` 存在，则可直接展示“查看网页应用”

---

## 2. 为什么不能直接用 `EventSource`

这些接口是 `POST`，而浏览器原生 `EventSource` 只支持 `GET`。

因此前端应使用：

- `fetch`
- `ReadableStream`
- 手动按 SSE 协议解析返回内容

---

## 3. 响应头

服务端成功建立流后，响应头通常为：

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Stream-Protocol: 2.0
X-Task-Id: task_xxxxxxxx
X-Session-Id: <sessionId>
```

前端建议：

- 从响应头里先缓存 `X-Task-Id`
- 从响应头里先缓存 `X-Session-Id`
- 如果后续事件里也带了同样字段，以事件体为准即可

---

## 4. SSE 原始格式

服务端按标准 SSE 输出，每个事件块之间用空行分隔：

```text
event: task_started
id: 1
data: {"event":"task_started","id":1,"task_id":"task_abcd1234","session_id":"sess_001","created_at":1740000000,"data":{"agent_name":"interactive-tutorial-director","thread_id":"biz-conv-001"}}

event: message
id: 2
data: {"event":"message","id":2,"task_id":"task_abcd1234","session_id":"sess_001","created_at":1740000001,"data":{"role":"assistant","delta":"我先帮你梳理需求"}}
```

说明：

- `event:` 是 SSE 事件名
- `id:` 是 SSE 递增序号
- `data:` 是真正要解析的 JSON
- 前端应以 `data:` 里的 JSON 为主，不要只依赖最外层的 `event:` 行

---

## 5. 通用数据结构

所有事件的 JSON 外层结构统一如下：

```json
{
  "event": "message",
  "id": 2,
  "task_id": "task_abcd1234",
  "session_id": "sess_001",
  "created_at": 1740000001,
  "data": {}
}
```

字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| `event` | `string` | 事件类型 |
| `id` | `number` | 当前流内递增序号 |
| `task_id` | `string` | 当前请求任务 ID |
| `session_id` | `string` | 当前网页应用/工作区 ID |
| `created_at` | `number` | 秒级时间戳 |
| `data` | `object` | 具体事件载荷 |

建议前端本地统一存成：

```ts
type StreamEvent = {
  event: string;
  id: number;
  task_id: string;
  session_id: string;
  created_at: number;
  data: Record<string, unknown>;
};
```

---

## 6. 事件类型总表

当前协议支持以下事件：

| 事件 | 是否重点处理 | 说明 |
|------|--------------|------|
| `task_started` | 是 | 一次请求开始 |
| `task_finished` | 是 | 一次请求结束，最终结果主入口 |
| `done` | 是 | 流正常结束 |
| `ping` | 否 | 心跳包，前端通常忽略 |
| `node_started` | 可选 | LangGraph 节点开始 |
| `node_finished` | 可选 | LangGraph 节点结束 |
| `message` | 是 | 文本增量输出 |
| `message_end` | 可选 | 文本完整输出结束 |
| `tool_started` | 是 | 工具开始调用 |
| `tool_finished` | 是 | 工具调用完成 |
| `agent_started` | 可选 | 子 Agent 开始 |
| `agent_message` | 可选 | 子 Agent 输出增量 |
| `agent_tool_started` | 可选 | 子 Agent 工具开始 |
| `agent_tool_finished` | 可选 | 子 Agent 工具结束 |
| `agent_finished` | 可选 | 子 Agent 完成 |
| `thinking` | 可忽略 | 独立 thinking 事件，当前业务流里不常见 |
| `progress` | 是 | 业务进度提示 |
| `error` | 是 | 错误事件 |

前端推荐最小实现：

- 必做：`message`、`progress`、`task_finished`、`error`、`done`
- 选做：`tool_started`、`tool_finished`、`agent_started`、`agent_finished`

---

## 7. 各事件字段说明

### 7.1 `task_started`

示例：

```json
{
  "event": "task_started",
  "id": 1,
  "task_id": "task_abcd1234",
  "session_id": "sess_001",
  "created_at": 1740000000,
  "data": {
    "agent_name": "interactive-tutorial-director",
    "thread_id": "biz-conv-001"
  }
}
```

`data` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent_name` | `string` | 当前执行的主 Agent |
| `thread_id` | `string` | 对话线程 ID，通常等于 `conversationId` 或服务端生成值 |

前端建议：

- 初始化当前流状态
- 记录 `task_id`、`session_id`

### 7.2 `message`

示例：

```json
{
  "event": "message",
  "id": 2,
  "task_id": "task_abcd1234",
  "session_id": "sess_001",
  "created_at": 1740000001,
  "data": {
    "role": "assistant",
    "delta": "我先帮你梳理需求"
  }
}
```

`data` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `role` | `"assistant"` | 当前固定为 assistant |
| `delta` | `string` | 本次增量文本 |

前端建议：

- 把 `delta` 追加到当前 assistant 消息缓冲区
- 用于实现打字机效果

### 7.3 `progress`

示例：

```json
{
  "event": "progress",
  "id": 8,
  "task_id": "task_abcd1234",
  "session_id": "sess_001",
  "created_at": 1740000010,
  "data": {
    "message": "Preview is ready",
    "percentage": 100,
    "phase": "assemble",
    "metadata": {
      "stage": "preview_ready",
      "url": "http://host/api/files/tutorials/sess_001/dist/index.html"
    }
  }
}
```

`data` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `message` | `string` | 进度提示文案 |
| `percentage` | `number` | 进度百分比，可能不存在 |
| `phase` | `string` | 阶段名，如 `assemble` |
| `metadata` | `object` | 扩展信息 |

前端建议：

- 直接展示 `message`
- 如果有 `percentage`，可驱动进度条
- 如果 `metadata.url` 已存在，可以提前展示“预览已就绪”

### 7.4 `node_started` / `node_finished`

示例：

```json
{
  "event": "node_finished",
  "id": 6,
  "task_id": "task_abcd1234",
  "session_id": "sess_001",
  "created_at": 1740000008,
  "data": {
    "node_type": "think",
    "status": "succeeded",
    "elapsed_time": 1.25,
    "iteration": 0,
    "node_id": "think",
    "output": "..."
  }
}
```

`data` 常见字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `node_type` | `perceive \| think \| act \| observe \| reflect` | 节点类型 |
| `status` | `succeeded \| failed` | 仅 `node_finished` 有 |
| `elapsed_time` | `number` | 节点耗时，秒 |
| `iteration` | `number` | 当前迭代轮次 |
| `node_id` | `string` | 节点 ID |
| `output` | `unknown` | 节点输出，可能不存在 |

前端建议：

- 普通业务 UI 可不展示
- 如果要做调试面板/开发者模式，可以展示

### 7.5 `tool_started`

示例：

```json
{
  "event": "tool_started",
  "id": 10,
  "task_id": "task_abcd1234",
  "session_id": "sess_001",
  "created_at": 1740000012,
  "data": {
    "tool_call_id": "tool_123",
    "tool_name": "start_generation_pipeline",
    "arguments": {
      "topic": "牛顿第二定律",
      "brief": "..."
    }
  }
}
```

前端建议：

- 根据 `tool_name` 显示更友好的文案
- 推荐映射：
  - `start_generation_pipeline` -> `开始生成网页应用`
  - `reassemble_app` -> `正在重建网页应用`

### 7.6 `tool_finished`

示例：

```json
{
  "event": "tool_finished",
  "id": 11,
  "task_id": "task_abcd1234",
  "session_id": "sess_001",
  "created_at": 1740000035,
  "data": {
    "tool_call_id": "tool_123",
    "tool_name": "start_generation_pipeline",
    "status": "succeeded",
    "output": "{\"success\":true,\"url\":\"http://host/api/files/tutorials/sess_001/dist/index.html\",\"title\":\"牛顿第二定律互动教程\"}",
    "elapsed_time": 23.4
  }
}
```

说明：

- `data.output` 可能是对象
- 也可能是 JSON 字符串

前端建议：

- 对 `output` 做一次“字符串转 JSON”的兼容解析
- 如果工具是 `start_generation_pipeline` 或 `reassemble_app`，可提前从 `output.url` 拿预览链接

### 7.7 `agent_started` / `agent_finished`

用于表示子 Agent 生命周期。

前端建议：

- 普通用户界面可简化成“正在调用子任务”
- 调试模式可展示具体 `agent_name`

### 7.8 `error`

示例：

```json
{
  "event": "error",
  "id": 20,
  "task_id": "task_abcd1234",
  "session_id": "sess_001",
  "created_at": 1740000040,
  "data": {
    "code": "CHAT_ERROR",
    "message": "Something went wrong",
    "recoverable": false
  }
}
```

`data` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | `string` | 错误码 |
| `message` | `string` | 错误信息 |
| `recoverable` | `boolean` | 是否可恢复 |

前端建议：

- 直接展示 `message`
- 若 `recoverable === false`，应将本轮流状态标为失败

### 7.9 `task_finished`

这是最终结果主入口。

示例：

```json
{
  "event": "task_finished",
  "id": 21,
  "task_id": "task_abcd1234",
  "session_id": "sess_001",
  "created_at": 1740000042,
  "data": {
    "status": "succeeded",
    "output": "您的互动教材已生成完成",
    "outputs": {
      "tutorialUrl": "http://host/api/files/tutorials/sess_001/dist/index.html",
      "tutorialTitle": "牛顿第二定律互动教程"
    },
    "elapsed_time": 38.52
  }
}
```

`data` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `succeeded \| failed \| cancelled \| paused \| stopped` | 最终状态 |
| `output` | `string` | 最终文本输出 |
| `outputs` | `object` | 结构化业务结果，最重要 |
| `error` | `string` | 失败原因 |
| `elapsed_time` | `number` | 总耗时，秒 |
| `usage` | `object` | 模型 token 用量，可能不存在 |
| `metadata` | `object` | 扩展信息，可能不存在 |

当前网页应用业务前端最应该读取：

| 字段 | 说明 |
|------|------|
| `data.status` | 是否成功 |
| `data.outputs.tutorialUrl` | 最终网页应用链接 |
| `data.outputs.tutorialTitle` | 最终网页应用标题 |
| `data.error` | 失败原因 |

### 7.10 `done`

示例：

```json
{
  "event": "done",
  "id": 22,
  "task_id": "task_abcd1234",
  "session_id": "sess_001",
  "created_at": 1740000042,
  "data": {}
}
```

前端建议：

- 收到 `done` 后关闭读取循环
- 但业务成功与否仍以 `task_finished` 为准，不要只看 `done`

### 7.11 `ping`

示例：

```json
{
  "event": "ping",
  "id": 5,
  "task_id": "task_abcd1234",
  "session_id": "sess_001",
  "created_at": 1740000005,
  "data": {}
}
```

前端建议：

- 直接忽略
- 可用于更新“连接还活着”的状态

---

## 8. 推荐前端状态模型

建议前端维护一份流式状态：

```ts
type AgentStreamState = {
  taskId?: string;
  sessionId?: string;
  conversationId?: string;
  status: "idle" | "streaming" | "succeeded" | "failed";
  text: string;
  progressText?: string;
  progressPercent?: number;
  tutorialUrl?: string;
  tutorialTitle?: string;
  errorMessage?: string;
  events: StreamEvent[];
};
```

推荐更新规则：

- `task_started` -> `status = "streaming"`
- `message` -> `text += delta`
- `progress` -> 更新 `progressText`、`progressPercent`
- `tool_finished` -> 尝试提取 `url`、`title`
- `task_finished(status=succeeded)` -> `status = "succeeded"`
- `task_finished(status!=succeeded)` 或 `error` -> `status = "failed"`
- `done` -> 结束读取

---

## 9. 推荐解析策略

### 9.1 核心原则

前端应做三层处理：

1. 按 SSE 协议拆包
2. 把 `data:` 行解析成 JSON
3. 再按 `event` 分发给不同处理函数

### 9.2 TypeScript 解析示例

```ts
type StreamEvent = {
  event: string;
  id: number;
  task_id: string;
  session_id: string;
  created_at: number;
  data: Record<string, unknown>;
};

function tryParseJson<T = unknown>(value: unknown): T | unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value;
  }
}

function parseSseBlock(block: string): StreamEvent | null {
  const lines = block.split("\n");
  let dataLine = "";

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLine += line.slice(5).trim();
    }
  }

  if (!dataLine) return null;

  try {
    return JSON.parse(dataLine) as StreamEvent;
  } catch {
    return null;
  }
}

export async function consumeAgentStream(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  onEvent: (event: StreamEvent) => void,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("ReadableStream 不存在");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (!event) continue;
      onEvent(event);
    }
  }
}
```

---

## 10. 推荐事件分发示例

```ts
function handleStreamEvent(
  event: StreamEvent,
  state: AgentStreamState,
) {
  state.taskId = event.task_id || state.taskId;
  state.sessionId = event.session_id || state.sessionId;
  state.events.push(event);

  switch (event.event) {
    case "task_started":
      state.status = "streaming";
      break;

    case "message": {
      const delta = String(event.data?.delta ?? "");
      state.text += delta;
      break;
    }

    case "progress": {
      state.progressText = String(event.data?.message ?? "");
      if (typeof event.data?.percentage === "number") {
        state.progressPercent = event.data.percentage;
      }

      const metadata = (event.data?.metadata ?? {}) as Record<string, unknown>;
      if (typeof metadata.url === "string") {
        state.tutorialUrl = metadata.url;
      }
      break;
    }

    case "tool_finished": {
      const toolName = String(event.data?.tool_name ?? "");
      const output = tryParseJson<Record<string, unknown>>(event.data?.output);

      if (
        (toolName === "start_generation_pipeline" || toolName === "reassemble_app") &&
        output &&
        typeof output === "object"
      ) {
        if (typeof output.url === "string") state.tutorialUrl = output.url;
        if (typeof output.title === "string") state.tutorialTitle = output.title;
        if (typeof output.stableUrl === "string" && !state.tutorialUrl) {
          state.tutorialUrl = output.stableUrl;
        }
      }
      break;
    }

    case "task_finished": {
      const outputs = (event.data?.outputs ?? {}) as Record<string, unknown>;
      if (typeof outputs.tutorialUrl === "string") {
        state.tutorialUrl = outputs.tutorialUrl;
      }
      if (typeof outputs.tutorialTitle === "string") {
        state.tutorialTitle = outputs.tutorialTitle;
      }

      if (event.data?.status === "succeeded") {
        state.status = "succeeded";
      } else {
        state.status = "failed";
        state.errorMessage = String(event.data?.error ?? "任务失败");
      }
      break;
    }

    case "error":
      state.status = "failed";
      state.errorMessage = String(event.data?.message ?? "流式调用失败");
      break;

    case "done":
      break;
  }
}
```

---

## 11. 前端界面建议

### 11.1 聊天区

展示来源：

- `message.data.delta`

建议：

- 实时追加
- 流结束后保留完整 assistant 内容

### 11.2 进度区

展示来源：

- `progress.data.message`
- `progress.data.percentage`
- `tool_started.data.tool_name`
- `tool_finished.data.tool_name`

建议文案：

- `start_generation_pipeline` -> `开始生成应用`
- `reassemble_app` -> `正在重建应用`
- `progress` -> 直接显示服务端 message

### 11.3 结果区

展示来源：

- `task_finished.data.outputs.tutorialUrl`
- `task_finished.data.outputs.tutorialTitle`

建议：

- 成功时优先展示预览按钮
- 如果 `tutorialUrl` 已存在，即使 `message` 文本还没完全消费，也可以先展示入口

### 11.4 错误区

展示来源：

- `error.data.message`
- `task_finished.data.error`

建议：

- 优先显示更具体的一条
- 若已经收到 `error`，不要重复弹多次 toast

---

## 12. 典型事件顺序

### 12.1 新建网页应用

典型顺序如下：

1. `task_started`
2. 若干 `message`
3. `tool_started` (`start_generation_pipeline`)
4. 若干 `progress`
5. 若干 `agent_*` / `tool_*`
6. `tool_finished` (`start_generation_pipeline`)
7. `task_finished`
8. `done`

### 12.2 编辑已有网页应用

典型顺序如下：

1. `task_started`
2. 若干 `message`
3. 可能出现 `agent_started`（编辑子 Agent）
4. `tool_started` (`reassemble_app`)
5. 若干 `progress`
6. `tool_finished` (`reassemble_app`)
7. `task_finished`
8. `done`

说明：

- 事件数量和顺序会因模型行为略有差异
- 前端必须按“事件驱动”处理，不能写死严格顺序

---

## 13. 健壮性建议

### 13.1 忽略未知事件

后端未来可能增加新事件类型。前端应：

- 识别已知事件
- 忽略未知事件
- 不要因为新事件导致整个流解析失败

### 13.2 `output` 字段做兼容 JSON 解析

以下字段经常是“对象或 JSON 字符串二选一”：

- `tool_finished.data.output`
- `task_finished.data.output`

因此前端建议统一做一次 `tryParseJson`

### 13.3 不要只靠 `done` 判断成功

`done` 只表示流结束，不表示任务成功。

最终判断必须看：

- `task_finished.data.status`

### 13.4 断流处理

如果网络中断或用户主动取消：

- 流可能收不到 `done`
- 流也可能收不到 `task_finished`

因此前端应在 `fetch/read` 抛错时，把当前状态标记为“连接中断”或“请求失败”

---

## 14. 前端最小落地规则

如果你只实现最小功能，按这套规则即可：

1. 用 `fetch + ReadableStream` 调接口
2. 解析 SSE 块中的 `data:` JSON
3. `message` 追加文本
4. `progress` 更新状态文案
5. `task_finished` 读取 `status`、`outputs.tutorialUrl`
6. `error` 显示错误
7. `done` 结束读取

---

## 15. 和业务最相关的字段

前端最终最常用的只有这些：

| 路径 | 用途 |
|------|------|
| `event.task_id` | 标识本次请求 |
| `event.session_id` | 标识当前网页应用 |
| `message.data.delta` | 增量文本 |
| `progress.data.message` | 进度提示 |
| `tool_finished.data.tool_name` | 工具完成提示 |
| `task_finished.data.status` | 成功/失败 |
| `task_finished.data.outputs.tutorialUrl` | 最终网页地址 |
| `task_finished.data.outputs.tutorialTitle` | 最终标题 |
| `error.data.message` | 错误提示 |

---

*如果后续 SSE 协议有调整，请优先以 `src/core/types.ts`、`src/core/stream-protocol.ts`、`src/core/sse-writer.ts` 和 `apps/interactive-tutorial/code/routes.ts` 的实现为准更新本文。*
