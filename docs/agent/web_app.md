# 网页互动教程（Web App）智能体 — HTTP 接口说明

本文档描述 `apps/interactive-tutorial` 业务域对外暴露的 HTTP/SSE 接口，对应「生成可交互教学 Web 应用」能力。

| 项目 | 说明 |
|------|------|
| 路由注册 | `apps/interactive-tutorial/code/routes.ts` → `routeRegistry.register("interactive-tutorial", ...)` |
| 编排 Agent | `interactive-tutorial-director` |
| 运行时 | `agentRuntime.streamAgentV2` + `createStreamWriter`（`src/core/stream-writer-factory.ts`） |

---

## 1. 概述

| 项目 | 说明 |
|------|------|
| 业务前缀 | `/api/business/interactive-tutorial` |
| 核心能力 | 根据主题与可选上下文调用 Director，产出基于 Vite 构建的静态教程站点 |
| 静态访问 | 构建产物通过 `GET /api/files/tutorials/{tutorialId}/dist/...` 提供（见第 6 节） |
| 模板工程 | 服务端期望在 **`process.cwd()` 的上一级目录** 存在 `react-code-rander` 项目（含已安装的 `node_modules`），用于复制模板与链接依赖 |

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
- **租户与用户覆盖**（可选）：JSON Body 中可传 `tenant_id`、`user_id`，会覆盖中间件解析出的身份（见 `getTenantId` / `getUserId`）。

**静态文件** `/api/files/...` **跳过鉴权**，任何人持有 URL 即可访问；若需保护预览链接，应在网关或业务层增加令牌或短期签名。

---

## 3. 端点总览

当前实现**仅**注册以下两个端点（不再有 `test-build` / `dashboard` 等辅助路由）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/business/interactive-tutorial/generate-stream` | 生成教程（SSE，统一流协议 v2） |
| `POST` | `/api/business/interactive-tutorial/edit-stream` | 编辑已有教程（SSE，`skipPipeline: true`） |

---

## 4. `POST .../generate-stream`

### 4.1 用途

启动一次「互动教程」生成。服务端会：

1. 校验 `topic`；
2. 根据 Body 计算**意图标签**（见第 8 节），并拼入发给 Director 的自然语言指令（含固定「核心规则」段落，见 `routes.ts` 中 `buildGenerateInstruction`）；
3. **创建或复用会话工作区**：`workspaceManager.create(tenantId, userId, body.sessionId)`，返回的会话 ID 与请求中的 `sessionId` 一致（未传则新建 UUID）；
4. 通过 **`agentRuntime.streamAgentV2("interactive-tutorial-director", instruction, options)`** 推送事件流；未设置 `skipPipeline`，故默认走 `agent.config.yaml` 中的 **Pipeline**（见第 7 节）。

### 4.2 请求

- **Headers**：`Content-Type: application/json`；按需带 `Authorization`。
- **Body**（`apps/interactive-tutorial/code/types.ts` — `GenerateRequest`）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `topic` | `string` | 是 | 教程主题；缺失返回 **400** `{ "error": "topic is required" }` |
| `userPrompt` | `string` | 否 | 用户补充需求 |
| `databaseId` | `string` | 否 | 知识库 ID；写入指令并放入 `context.databaseId` |
| `smartSearch` | `boolean` | 否 | 为 true 时在指令与 `context` 中说明可启用联网检索 |
| `userFiles` | `string` | 否 | 用户上传文件的文本内容（需由上游先解析为字符串） |
| `sessionId` | `string` | 否 | 指定工作区会话 ID；不传则新建 |
| `conversationId` | `string` | 否 | 业务侧会话标识，传入 `context.conversationId` |
| `tenant_id` | `string` | 否 | 覆盖租户 |
| `user_id` | `string` | 否 | 覆盖用户 |

### 4.3 调用上下文 `InvokeOptions.context`（非 Body 字段）

生成请求传入：

| 字段 | 说明 |
|------|------|
| `businessType` | 固定 `"interactive-tutorial"` |
| `intent` | `DIRECT` / `OUTLINE` / `INTERACTIVE`（见第 8 节） |
| `conversationId` | 来自 Body，可选 |
| `databaseId` | 来自 Body，可选 |
| `smartSearch` | 来自 Body，可选 |

### 4.4 响应：Server-Sent Events（统一流协议）

- **成功建立流**：`200`，`Content-Type: text/event-stream`，`Cache-Control: no-cache`，`Connection: keep-alive`。
- **响应头（Native 模式）**：`X-Stream-Protocol: 2.0`、`X-Task-Id`、`X-Session-Id`（见 `src/core/sse-writer.ts`）。
- **协议切换**：环境变量 `STREAM_PROTOCOL` 为 `dify` 时，由 `DifySSEWriter` 输出 Dify 兼容格式；默认 `native` 为下文所述 JSON 载荷格式。

**帧格式**：每条事件为 SSE 标准帧，`data` 为**完整 JSON 对象**，包含至少：`event`、`id`、`task_id`、`session_id`、`created_at`、`data`。事件名与 `event` 字段一致。

**常见事件类型**（完整枚举见 `src/core/types.ts` 中 `StreamEventType`）：

| `event` | 说明 |
|---------|------|
| `task_started` | 任务开始；`data.agent_name` 等为 Director 名 |
| `node_started` / `node_finished` | Pipeline 每步或图节点生命周期；Pipeline 下 `node_id` 为步骤名（如 `research`、`assemble`） |
| `progress` | 流水线步骤完成进度（`data.message`、`data.phase`、`data.percentage`） |
| `message` | 非 Pipeline 图模式下，若 Agent 配置为流式思考，可能推送 think 的 token 增量 |
| `tool_started` / `tool_finished` | 工具调用 |
| `agent_*` | 子 Agent 相关事件 |
| `task_finished` | 任务结束；**最终业务结果主要看此事件** |
| `error` | 错误；`data.code`、`data.message`、`data.recoverable` |
| `ping` | 心跳（默认约 15s） |
| `done` | 流正常结束标记 |

路由层在 `catch` 中会写入 `error` 事件，典型 `code`：`GENERATION_ERROR`。

**`task_finished` 与教程产物**

- Pipeline **成功**且最后一步为 `assemble` 时，`task_finished.data.output` 为 **字符串**：非字符串的终态结果会被 `JSON.stringify`（见 `agent-runtime.ts` 中 `streamPipeline`）。
- 客户端应对 `output` 做 JSON 解析后使用，语义上对应 `assembleApp` 的返回值，常见字段包括：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tutorialId` | `string` | 本次构建目录 UUID |
| `title` | `string` | 来自蓝图 `title`，缺省为 `"互动教程"` |
| `url` | `string` | 入口页路径，形如 `/api/files/tutorials/{tutorialId}/dist/index.html` |
| `createdAt` | `string` | ISO 8601 时间 |
| `teachingGuide` | `unknown` | 来自蓝图 `teaching_guide`（若有） |
| `fileCount` | `number` | 参与构建的组件文件数 |
| `warnings` | `string[]` | 可选；静态校验告警、剔除失败组件等 |

- `task_finished.data.status` 为 `succeeded` | `failed` 等（见 `TaskFinishStatus`）；失败时可能同时带 `data.error`。

### 4.5 其他 HTTP 错误

| 状态码 | 条件 |
|--------|------|
| **400** | 缺少 `topic` |
| **503** | 注册表中不存在 `interactive-tutorial-director`（在建立 SSE **之前**返回 JSON，非流） |

---

## 5. `POST .../edit-stream`

### 5.1 用途

在**已有**工作区上按自然语言修改教程。流程分为两个阶段：

1. **Agent 编辑阶段**：调用 `streamAgentV2`（`skipPipeline: true`），Director 通过 `spawn_sub_agent` 委托 `tutorial-scene-editor` 执行场景文件修改和蓝图同步。
2. **自动重建阶段**：Agent 编辑完成后，路由层自动调用 `reassembleForSession` 重新同步场景文件并执行 Vite 构建，更新 `artifacts/tutorial-meta.json`。

路由层在发送 Agent 事件流时，会拦截 `task_finished` 和 `done` 事件，在重建完成后才发送包含更新后教程 URL 的 `task_finished`。

### 5.2 请求

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | 是 | 与生成时一致的会话 ID |
| `editPrompt` | `string` | 是 | 编辑指令 |
| `conversationId` | `string` | 否 | 传入 `context.conversationId` |
| `tenant_id` / `user_id` | `string` | 否 | 身份覆盖 |

缺失 `sessionId` 或 `editPrompt` 返回 **400** `{ "error": "sessionId and editPrompt are required" }`。

### 5.3 `context`

| 字段 | 说明 |
|------|------|
| `businessType` | 固定 `"interactive-tutorial-edit"` |
| `conversationId` | 可选 |

（编辑路径**不**传入生成接口中的 `intent` / `databaseId` / `smartSearch`。）

### 5.4 响应

与生成接口相同：**统一 SSE 协议 v2**。路由层 `catch` 中典型 `error.code`：`EDIT_ERROR`。

`task_finished.data.output` 为 `reassembleForSession` 返回的 JSON 字符串，结构与生成接口的 `assembleApp` 输出一致（含 `tutorialId`、`url`、`fileCount`、`warnings` 等）。`task_finished.data.metadata` 也包含相同字段的对象形式。若重建失败，`status` 为 `failed`，错误信息在 `error` 字段中，之前还会有一个 `error` 事件（code: `REBUILD_ERROR`）。

### 5.5 其他 HTTP 错误

| 状态码 | 条件 |
|--------|------|
| **503** | `interactive-tutorial-director` 未注册 |

---

## 6. 静态资源：`GET /api/files/...`

由 `@fastify/static` 挂载，`root` 为仓库内 `data/`（`src/api/server.ts`）。

教程构建输出目录：

`data/tutorials/{tutorialId}/dist/`

浏览器入口通常为：

`/api/files/tutorials/{tutorialId}/dist/index.html`

该路径**不经 API Key 校验**（见第 2 节）。

---

## 7. 生成流水线（Pipeline，`skipPipeline` 为 false 时）

配置：`apps/interactive-tutorial/interactive-tutorial-director/agent.config.yaml`。

| 顺序 | 步骤名 | 类型 | 说明 |
|------|--------|------|------|
| 1 | `research` | Agent `tutorial-content-researcher` | 可选；失败可跳过 |
| 2 | `architect` | Agent `tutorial-scene-architect` | 场景蓝图 JSON |
| 3 | `save-blueprint` | Handler `saveBlueprint` | 写入 `artifacts/blueprint.json` |
| 4 | `coder` | Agent `tutorial-scene-coder` | 场景 TSX，通常写入 workspace `assets/scenes/**` |
| 5 | `assemble` | Handler `assembleApp` | 同步场景、Vite 构建、写 `artifacts/tutorial-meta.json` |

**额外注册的 Handler**（`apps/interactive-tutorial/code/index.ts`）：`reassembleApp`，供编辑/工具链在已有 `tutorial-meta.json` 上重新同步与构建。

Handler 实现在 `apps/interactive-tutorial/code/handlers.ts`：

- 从 workspace `assets/scenes` 复制 `.tsx`；若为空则尝试从 Coder 文本中提取 ```tsx 代码块（需含 `export const sceneMeta` 与 `sceneMeta.id`）。
- 构建前会做静态校验（`validators.ts`）：`sceneMeta`、默认导出、import 白名单等。
- 构建失败时有限次重试，并可**删除**报错的场景文件以降级通过（`warnings` 会记录）。

---

## 8. 意图标签（写入 Director 指令）

`routes.ts` 中 `classifyIntent(body)`：

| 条件 | 标签 | 含义（文档性） |
|------|------|----------------|
| `topic` 存在且（`userPrompt` 或 `userFiles` 或 `databaseId`）任一为真 | `DIRECT` | 信息较完整，倾向完整生成 |
| 仅有 `topic` | `OUTLINE` | 细节不足，倾向先大纲 |
| 不满足上述 | `INTERACTIVE` | 对话引导（`topic` 已必填时极少出现） |

该字符串出现在发给 Director 的指令「【意图路径】」一节，并写入 `context.intent`。**是否走 Pipeline** 由 `streamAgentV2` 的 `skipPipeline` 决定：生成接口未设置 `skipPipeline`，默认走 Pipeline。

---

## 9. 相关类型参考

| 位置 | 内容 |
|------|------|
| `apps/interactive-tutorial/code/types.ts` | `GenerateRequest` / `EditRequest`；`TutorialMeta`；`TutorialResponse`（产品层聚合形状参考） |
| `src/core/types.ts` | `StreamEvent`、`StreamEventType`、`TaskFinishedData`、`ErrorData` 等流事件载荷 |

---

## 10. 运维与依赖摘要

1. **磁盘**：`data/tutorials/` 持续增长；`data/tenants/.../workspaces/{sessionId}` 存会话产物。
2. **CPU/时间**：Vite 生产构建单次可达数十秒；`exec` 超时 120s（handlers）。
3. **Windows**：优先使用 `vite.cmd` 调用本地 Vite。
4. **Agent 可用性**：若 `interactive-tutorial-director` 未加载，生成/编辑在发流前返回 **503**。

---

*文档与实现对齐：以 `apps/interactive-tutorial/code/*.ts` 与 `src/core/agent-runtime.ts`（`streamAgentV2` / `streamPipeline`）为准；路由或流协议变更时请同步更新本文。*
