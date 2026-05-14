# 网页互动教程（Web App）智能体 — HTTP 接口说明

本文档描述 `apps/interactive-tutorial` 业务域当前对外推荐使用的 HTTP/SSE 接口，对应「通过对话生成或修改可交互教学 Web 应用」能力。

| 项目 | 说明 |
|------|------|
| 路由注册 | `apps/interactive-tutorial/code/routes.ts` → `registerInteractiveTutorialRoutes(app)` |
| 编排 Agent | `interactive-tutorial-director` |
| 运行时 | `agentRuntime.streamAgentV2` + `createStreamWriter`（`src/core/stream-writer-factory.ts`） |

---

## 1. 概述

| 项目 | 说明 |
|------|------|
| 业务前缀 | `/api/business/interactive-tutorial` |
| 主入口 | `POST /api/business/interactive-tutorial/chat-stream` |
| 取消入口 | `POST /runs/:runId/cancel` |
| 静态访问 | 构建产物通过 `GET /api/files/tutorials/{sessionId}/dist/...` 提供 |
| 模板工程 | 服务端期望在 `process.cwd()` 的上一级目录存在 `react-code-rander` 项目（含已安装的 `node_modules`），用于复制模板与链接依赖 |

新接入方只需要调用 `chat-stream`。生成、继续修改、携带知识库、联网检索和用户文件都通过同一个对话入口完成。

---

## 2. 认证与身份

全局中间件：`src/api/middleware/auth.ts`。

- **需认证的请求**：除 `/api/health` 与以 `/api/files/` 开头的 URL 外，均经过 `authMiddleware`。
- **鉴权方式**（任选其一）：
  - 请求头：`Authorization: Bearer <apiKey>`
  - 查询参数：`?apiKey=<apiKey>`
- **`config/tenants.yaml`**：
  - 若文件存在且解析出至少一个 API Key：生产环境缺少 Key 返回 **401**；开发环境可回落为 `tenantId=userId=default`。
  - 若文件不存在或为空：所有请求视为 `default` / `default`，不校验 Key。
- **租户与用户覆盖**：中间件支持从 JSON Body 读取 `tenant_id`、`user_id` 覆盖身份；取消接口需要与创建流时解析出的 `userId` 一致。

**静态文件** `/api/files/...` **跳过鉴权**，任何人持有 URL 即可访问；若需保护预览链接，应在网关或业务层增加令牌或短期签名。

---

## 3. 端点总览

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/business/interactive-tutorial/chat-stream` | 主对话入口（SSE，统一流协议 v2，`skipPipeline: true`） |
| `POST` | `/runs/:runId/cancel` | 取消正在运行的流式任务；`runId` 使用 SSE 的 `task_id` 或响应头 `X-Task-Id` |

---

## 4. `POST .../chat-stream`

### 4.1 用途

启动或继续一次「互动教程」对话。服务端会：

1. 校验 `message`；
2. 创建或复用会话工作区：`workspaceManager.create(tenantId, userId, body.sessionId)`，未传 `sessionId` 时创建新会话；
3. 生成 `conversationId`（未传则自动生成 UUID）与 `taskId`；
4. 处理本轮用户文件：`fileUrls` 会先导入为用户级 `fileId`，`fileIds` 会绑定到当前 `sessionId`，随后读取当前会话已绑定文件摘要并写入 `context.userFiles`；
5. 通过 `agentRuntime.streamAgentV2("interactive-tutorial-director", enrichedMessage, options)` 推送事件流。

### 4.2 请求

- **Headers**：`Content-Type: application/json`；按需带 `Authorization`。
- **Body**（`apps/interactive-tutorial/code/types.ts` — `ChatRequest`）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | `string` | 是 | 本轮用户消息；缺失返回 **400** `{ "error": "message is required" }` |
| `conversationId` | `string` | 否 | 业务侧会话标识；未传则服务端生成 UUID，并作为 `threadId` 使用 |
| `sessionId` | `string` | 否 | 工作区会话 ID；首次不传会新建，后续继续修改同一教程时应传回同一个 `sessionId` |
| `databaseId` | `string` | 否 | 知识库 ID；写入 `context.databaseId` |
| `smartSearch` | `boolean` | 否 | 是否允许联网检索；写入 `context.smartSearch` |
| `fileIds` | `string[]` | 否 | 已通过 `POST /api/uploads` 上传得到的文件 ID；服务端会绑定到本次 `sessionId` |
| `fileUrls` | `ChatFileUrlInput[]` | 否 | 本轮直接导入的远程文件列表；服务端导入后绑定到本次 `sessionId` |
| `attachments` | `string` | 否 | **已废弃**；路由不再读取，请改用 `fileIds` 或 `fileUrls` |

`ChatFileUrlInput`：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `fileName` | `string` | 是 | 文件名；不能为空 |
| `fileType` | `string` | 是 | MIME 类型；不能为空 |
| `url` | `string` | 是 | 远程文件 URL；不能为空，仅支持 `http` / `https` |

> 注意：旧的 `userFiles: string` 传参已不再用于 `chat-stream`。当前文件传参以 `fileIds` 为主；需要服务端从 URL 抓取时使用 `fileUrls`。

### 4.3 上传文件参数

推荐流程：

1. 先调用 `POST /api/uploads` 上传本地文件，得到 `files[].fileId`；
2. 调用 `chat-stream` 时把这些 ID 放入 `fileIds`；
3. 如果文件已经有公网可访问 URL，也可以直接在 `chat-stream` 中传 `fileUrls`，服务端会先导入再绑定。

`POST /api/uploads` 简要说明：

```http
POST /api/uploads
Content-Type: multipart/form-data
Authorization: Bearer <apiKey>
```

成功响应：

```json
{
  "files": [
    {
      "fileId": "file_...",
      "name": "lesson.pdf",
      "mimeType": "application/pdf",
      "kind": "doc",
      "size": 12345,
      "byteSize": 12345,
      "url": "http://host/api/files/uploads/objects/file_....pdf"
    }
  ]
}
```

`chat-stream` 携带已上传文件示例：

```json
{
  "message": "请基于这些材料生成一个雨刮系统互动教程",
  "sessionId": "optional-existing-session-id",
  "conversationId": "optional-conversation-id",
  "databaseId": "optional-database-id",
  "smartSearch": true,
  "fileIds": ["file_abc", "file_def"]
}
```

`chat-stream` 携带远程文件示例：

```json
{
  "message": "请读取这份讲义并生成互动教程",
  "fileUrls": [
    {
      "fileName": "雨刮系统讲义.pdf",
      "fileType": "application/pdf",
      "url": "https://example.com/materials/wiper.pdf"
    }
  ]
}
```

文件绑定与读取规则：

- `fileIds` 必须属于当前认证解析出的 `tenantId` / `userId`，否则返回 **400** `{ "error": "file not found or not accessible" }`。
- `fileUrls` 每一项都必须包含非空 `fileName`、`fileType`、`url`，否则返回 **400**，错误信息形如 `fileUrls[0] must be an object with fileName, fileType, and url`。
- 首次无 `sessionId` 调用时，服务端会先创建 session，再把 `fileIds` / `fileUrls` 绑定到该 session。
- 后续同一 `sessionId` 的请求会继续读取该 session 已绑定的文件列表；本轮新传的文件会追加绑定。
- 传给 Agent 的 `context.userFiles` 只包含摘要：`fileId`、`name`、`mimeType`、`kind`、`byteSize`、`url`、`textChars`、`unreadable`；正文由下游工具按需读取。

### 4.4 调用上下文 `InvokeOptions.context`（非 Body 字段）

| 字段 | 说明 |
|------|------|
| `businessType` | 固定 `"interactive-tutorial"` |
| `conversationId` | 来自 Body 或服务端生成 |
| `databaseId` | 来自 Body，可选 |
| `smartSearch` | 来自 Body，可选 |
| `userFiles` | 当前 session 已绑定文件摘要；仅当存在文件时传入 |

`chat-stream` 固定以 `skipPipeline: true` 调用 Director。具体生成或重建动作由 Director 在对话中调用工具完成，例如 `start_generation_pipeline`、`reassemble_app`。

### 4.5 响应：Server-Sent Events（统一流协议）

- **成功建立流**：`200`，`Content-Type: text/event-stream`，`Cache-Control: no-cache`，`Connection: keep-alive`。
- **响应头（Native 模式）**：`X-Stream-Protocol: 2.0`、`X-Task-Id`、`X-Session-Id`（见 `src/core/sse-writer.ts`）。
- **协议切换**：环境变量 `STREAM_PROTOCOL` 为 `dify` 时，由 `DifySSEWriter` 输出 Dify 兼容格式；默认 `native` 为下文所述 JSON 载荷格式。两种协议下都应缓存 `X-Task-Id` 或首个 SSE 事件中的 `task_id`，用于取消接口。

**帧格式**：每条事件为 SSE 标准帧，`data` 为完整 JSON 对象，包含至少：`event`、`id`、`task_id`、`session_id`、`created_at`、`data`。事件名与 `event` 字段一致。

常见事件类型：

| `event` | 说明 |
|---------|------|
| `task_started` | 任务开始；`data.agent_name` 等为 Director 名 |
| `message` | Agent 输出消息或 token 增量 |
| `tool_started` / `tool_finished` | 工具调用；生成或重建结果通常出现在相关工具的 `output` 中 |
| `agent_*` | 子 Agent 相关事件 |
| `progress` | 会话进度事件；例如生成、构建、同步等阶段 |
| `task_finished` | 任务结束；若捕获到教程产物，`data.outputs.tutorialUrl` / `data.outputs.tutorialTitle` / `data.outputs.coverUrl` 会被补充到该事件 |
| `error` | 错误；`data.code`、`data.message`、`data.recoverable` |
| `ping` | 心跳（默认约 15s） |
| `done` | 流正常结束标记 |

路由层在 `catch` 中会写入 `error` 事件，典型 `code`：`CHAT_ERROR`。

### 4.6 教程产物

当 Director 调用 `start_generation_pipeline` 或 `reassemble_app` 成功后，路由会尝试从对应 `tool_finished.data.output` 中解析教程 URL，并在最终 `task_finished.data.outputs` 中追加：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tutorialUrl` | `string` | 教程入口 URL，通常形如 `/api/files/tutorials/{sessionId}/dist/index.html` |
| `tutorialTitle` | `string \| null` | 教程标题；无法解析时为 `null` |
| `coverUrl` | `string \| undefined` | 应用封面截图 URL，形如 `/api/files/tutorials/{sessionId}/cover.png`；构建成功后由 Playwright 自动截图生成，异步完成后追加 |

封面截图也会通过 `progress` 事件通知，`stage` 为 `cover_ready`，`metadata.coverUrl` 包含封面地址。

客户端也可以直接监听 `tool_finished`，解析 `start_generation_pipeline` / `reassemble_app` 的 `output`，读取更完整的业务结果。

### 4.7 其他 HTTP 错误

| 状态码 | 条件 |
|--------|------|
| **400** | 缺少 `message` |
| **400** | `fileIds` 不存在、无权访问，或 `fileUrls` 参数格式不合法 |
| **503** | 注册表中不存在 `interactive-tutorial-director`（在建立 SSE 之前返回 JSON，非流） |

---

## 5. `POST /runs/:runId/cancel`

### 5.1 用途

取消一次正在运行的智能体流式任务。前端通常在用户点击「停止生成」时调用该接口。

`runId` 取值：

- 优先使用 SSE 响应头 `X-Task-Id`。
- 若响应头不可用，使用 SSE 帧 `data.task_id`。
- Native 模式和 Dify 兼容模式都使用同一个取消入口。

### 5.2 请求

```http
POST /runs/{task_id}/cancel
Content-Type: application/json
Authorization: Bearer <apiKey>

{}
```

取消接口只校验当前解析出的 `userId` 是否与运行中的任务一致。如果创建流时通过 Body 覆盖了 `user_id`，取消请求也应使用同一个身份（同一 API Key 或同样的 `user_id` 覆盖），否则会被视为非本人任务。

### 5.3 响应

| 状态码 | Body | 说明 |
|--------|------|------|
| `200` | `{ "success": true }` | 已触发取消；可能来自 Native run、Dify stream 或 pending task |
| `403` | `{ "error": "Run does not belong to current user" }` | 当前用户无权取消该任务 |
| `404` | `{ "error": "Run not found or already finished" }` | 任务不存在、已结束，或传入的不是当前协议暴露的 `task_id` |

### 5.4 取消后的 SSE

取消请求成功后，原 SSE 连接会尽快结束：

- Native 模式：通常收到 `task_finished`，`data.status = "cancelled"`，随后 `done`。
- Dify 兼容模式：通常收到 `workflow_finished`，`data.status = "cancelled"`，`data.error = "Run cancelled"`。

取消是尽力而为：若底层模型调用或工具调用已经进入不可中断阶段，服务端会在当前可观察节点结束后完成收敛，但不会再把该 run 当作可继续任务。

---

## 6. 静态资源：`GET /api/files/...`

由 `@fastify/static` 挂载，`root` 为仓库内 `data/`（`src/api/server.ts`）。

教程构建输出目录：

`data/tutorials/{sessionId}/dist/`

浏览器入口通常为：

`/api/files/tutorials/{sessionId}/dist/index.html`

该路径不经 API Key 校验（见第 2 节）。

---

## 7. 运维与依赖摘要

1. **磁盘**：`data/tutorials/`、`data/uploads/` 与 `data/tenants/.../workspaces/{sessionId}` 会持续增长。
2. **CPU/时间**：Vite 生产构建单次可达数十秒。
3. **Windows**：构建链路优先使用 `vite.cmd` 调用本地 Vite。
4. **Agent 可用性**：若 `interactive-tutorial-director` 未加载，`chat-stream` 在发流前返回 **503**。

---

*文档与实现对齐：以 `apps/interactive-tutorial/code/routes.ts`、`apps/interactive-tutorial/code/types.ts`、`src/api/routes/upload.routes.ts` 与 `src/api/routes/task.routes.ts` 为准；路由或流协议变更时请同步更新本文。*
