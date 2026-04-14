## ID 体系说明

本项目中常见的 ID 可以按三层来理解：**平台与账号层、会话与任务层、外部系统层**。本文件用于帮助产品、前端、后端在对接时说清楚“这是谁”“它在哪一层有效”，避免混用。

---

## 平台与账号层

- **tenantId**
  - **含义**：租户 ID，对应一个学校 / 机构 / 企业。
  - **来源**：鉴权中间件，从请求头或 Token 中解析。
  - **作用**：
    - 长期记忆按 `tenantId + agentName` 组织。
    - 工作区路径为 `tenantId / userId / sessionId` 的第一段。
    - 确保不同租户的数据（文稿、视频、日志等）物理隔离。

- **userId**
  - **含义**：用户 ID，对应租户下的某位老师 / 操作人。
  - **来源**：鉴权中间件，从请求头或 Token 中解析。
  - **作用**：
    - 工作区路径的第二段：`tenantId / userId / sessionId`。
    - E2B 项目命名空间：`/api/projects/{userId}/preview`。
    - 在同一租户内部区分不同用户的产物和权限。

---

## 会话与任务层

- **sessionId**
  - **含义**：一次完整“工作流 / 会话”的容器 ID，例如：
    - 一次教学文稿的生成 + 多轮修改。
    - 一条视频课从创建到多次编辑。
  - **来源**：
    - 前端显式传入；或
    - 后端在业务路由中使用 `conversationId` 或随机 UUID 作为默认值。
  - **作用**：
    - 工作区根路径第三段：`tenantId / userId / sessionId`。
    - 绑定所有中间产物：如 `script_json_{conversationId}`、`code_array_{conversationId}`、`scene_data_*` 等。
    - SSE 进度流 `/api/sessions/:sessionId/events` 的订阅键。
    - 在 `invokeAgent(..., { sessionId })` 时，开启该会话下的 `workspace_*`、`emit_event` 等工具。

- **conversationId**（主要用于视频课业务）
  - **含义**：视频课程域内的“业务会话 ID / 项目主线 ID”。
  - **来源**：`/api/business/video-course/generate` 中按以下优先级确定：
    - `body.conversationId`
    - `body.sessionId`
    - `crypto.randomUUID()`
  - **作用**：
    - 作为脚本和代码等产物的 Key：`script_json_{conversationId}`、`code_array_{conversationId}`。
    - 串联 `video-course-director`、`video-script-creator`、`scene-builder`、`remotion-code-generator`、`remotion-scene-coder` 等多个 Agent 的同一条业务主线。
  - **与 sessionId 的关系**：
    - 视频课场景下通常有 `sessionId = conversationId`。
    - `sessionId` 强调“工作区 / 技术会话”，`conversationId` 强调“业务会话 / 视频项目主线”。

- **threadId**
  - **含义**：LangGraph 推理线程 ID，用于标识同一条 Agent 对话 / 推理链。
  - **来源**：
    - 前端可传入以复用同一线程；
    - 未传时由 `invokeAgent` 内部自动生成 UUID。
  - **作用**：
    - 作为 LangGraph `configurable.thread_id`，用于多步推理和检查点管理。
    - 作为 `AgentInvokeResponse.threadId` 返回给前端，支持后续“在同一推理上下文中继续执行”。

- **taskId**
  - **含义**：异步任务 ID，仅存在于 `invokeAgentAsync` / `taskExecutor` 场景。
  - **来源**：提交异步任务时由 `taskExecutor` 生成。
  - **作用**：
    - `POST /api/agents/:name/invoke-async` 返回 `{ taskId, sessionId, status }`。
    - `GET /api/tasks/:id` 查询任务状态。
    - `DELETE /api/tasks/:id` 取消未完成的任务。

---

## 外部系统层

- **project_id / projectId**（E2B 视频项目 ID）
  - **含义**：在 E2B 渲染服务中的视频项目主键。
  - **来源**：
    - 初次创建视频时，由 `pushToE2b` 调用返回。
  - **作用**：
    - `/api/business/video-course/generate` 返回给前端，标记这条视频课的项目。
    - `/api/business/video-course/edit` 作为必要入参，告诉 `video-code-editor` 和 E2B “要修改哪一个视频项目”。
  - **与 conversationId 的区别**：
    - `conversationId`：平台内“这条课程对话线”的标识，可在未成功渲染前就存在。
    - `project_id`：外部渲染系统中“已生成的视频项目”的标识，仅在成功推送 E2B 后才有。

- **database_id / datasetIds**（教学资源业务）
  - **含义**：知识库数据集 ID，用于限定教学文稿生成时的知识检索范围。
  - **来源**：教学资源前端在选择知识库后传入。
  - **作用**：
    - 在 `knowledge_search` 工具调用中作为 `datasetIds` 传入，优先从指定知识库中查找内容。

---

## 快速对照表

| ID           | 层级           | 典型格式      | 主要用途                         |
|--------------|----------------|---------------|----------------------------------|
| tenantId     | 平台 / 账号    | 字符串 / UUID | 租户隔离、内外部数据分区         |
| userId       | 平台 / 账号    | 字符串        | 区分同租户下不同用户             |
| sessionId    | 会话 / 工作流  | UUID          | Workspace 命名空间、事件订阅键   |
| conversationId | 会话 / 业务  | UUID          | 视频课业务主线 / 课程会话        |
| threadId     | 推理线程       | UUID          | LangGraph 推理上下文与检查点     |
| taskId       | 异步任务       | UUID          | 查询 / 取消异步任务              |
| project_id   | 外部系统 (E2B) | 字符串        | 外部视频项目主键，用于后续编辑   |
| database_id  | 业务（教学）   | 字符串        | 知识库数据集筛选 (Dify)         |

