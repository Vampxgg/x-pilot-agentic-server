# X-Pilot 项目 API 接口文档

本文档整理 X-Pilot 工作区中 **x-pilot-agentic-server** 与 **x-pilot-e2b-server** 两个项目提供的全部 HTTP 接口。

---

## 目录

1. [x-pilot-agentic-server](#1-x-pilot-agentic-server)
2. [x-pilot-e2b-server](#2-x-pilot-e2b-server)

---

## 概述

| 项目 | 默认端口 | 认证方式 |
|------|----------|----------|
| x-pilot-agentic-server | 配置 `server.port`（如 3000） | `Authorization: Bearer <apiKey>` 或 `?apiKey=<key>`（生产环境必填） |
| x-pilot-e2b-server | 配置指定 | 部分接口需 `Authorization: Bearer <API_TOKEN>` 或 `X-API-KEY`；预览类接口支持 `sig` 签名 |

---

## 1. x-pilot-agentic-server

Agentic 服务，提供 Agent 调用、教学资源生成、任务管理等功能。

### 1.1 健康检查

#### `GET /api/health`

健康检查，无需认证。

**请求**
- 无参数

**响应示例**
```json
{
  "status": "ok",
  "timestamp": "2026-03-11T10:00:00.000Z",
  "agents": 1,
  "tools": 5,
  "tasks": {
    "size": 0,
    "pending": 0,
    "paused": 0
  }
}
```

---

### 1.2 Agent 相关

#### `GET /api/agents`

获取所有已注册 Agent 列表。

**请求**
- 无参数

**响应示例**
```json
[
  {
    "name": "document-generator",
    "model": "openrouter/openai/gpt-4o",
    "tools": ["knowledge_search", "web_search"],
    "skills": ["teaching-resource"],
    "heartbeatEnabled": false,
    "evolutionEnabled": false
  }
]
```

---

#### `GET /api/agents/:name`

获取指定 Agent 详情。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Agent 名称 |

**响应示例**
```json
{
  "name": "document-generator",
  "config": {
    "model": "openrouter/openai/gpt-4o",
    "maxConcurrency": 10,
    "allowedTools": ["knowledge_search", "web_search", "spawn_parallel_agents", "workspace_write", "workspace_list"],
    "heartbeat": { "enabled": false, "intervalMs": 0 },
    "evolution": { "enabled": false, "requireApproval": true },
    "timeout": 300000
  },
  "prompts": { "identity": "...", "mission": "..." },
  "skills": [{ "name": "teaching-resource", "description": "..." }],
  "memoryPath": "data/tenants/default/agents/document-generation/memory"
}
```

**错误**
- `404`: Agent not found

---

#### `POST /api/agents/:name/invoke`

同步调用 Agent，阻塞等待完成。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Agent 名称 |

**请求体**
```json
{
  "input": "请生成关于光合作用的教学教案",
  "threadId": "optional-thread-id",
  "sessionId": "optional-session-id",
  "context": { "customKey": "customValue" },
  "metadata": {}
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| input | string | 是 | 输入指令/提示词 |
| threadId | string | 否 | 线程 ID，用于多轮对话上下文 |
| sessionId | string | 否 | 会话 ID |
| context | object | 否 | 自定义上下文 |
| metadata | object | 否 | 元数据 |

**响应示例**
```json
{
  "threadId": "thread-xxx",
  "output": "生成的 Markdown 内容...",
  "taskResult": {
    "success": true,
    "output": "...",
    "duration": 15000,
    "toolCalls": [],
    "subAgentResults": []
  }
}
```

---

#### `POST /api/agents/:name/invoke-async`

异步调用 Agent，立即返回任务 ID，完成后通过 webhook 回调。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Agent 名称 |

**请求体**
```json
{
  "input": "生成关于牛顿定律的教案",
  "threadId": "optional",
  "sessionId": "optional",
  "context": {},
  "webhookUrl": "https://your-server.com/webhook/callback"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| webhookUrl | string | 否 | 任务完成后的回调 URL |

**响应**
- 状态码：`202 Accepted`
```json
{
  "taskId": "task-xxx",
  "status": "pending"
}
```

---

#### `POST /api/agents/:name/stream`

SSE 流式调用 Agent。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Agent 名称 |

**请求体**
与 `invoke` 相同（不含 `webhookUrl`）。

**响应**
- `Content-Type`: `text/event-stream`
- 每行：`data: <JSON event>`

```json
{ "type": "token", "data": { "content": "..." }, "timestamp": "2026-03-11T10:00:00.000Z" }
{ "type": "tool_call", "data": { "toolName": "knowledge_search", ... }, "timestamp": "..." }
{ "type": "done", "data": { "output": "..." }, "timestamp": "..." }
```

---

#### `POST /api/agents`

运行时创建新 Agent。

**请求体**
```json
{
  "name": "my-custom-agent",
  "identity": "你是一个...",
  "soul": "...",
  "mission": "...",
  "config": { "model": "gpt-4", "allowedTools": [] }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Agent 名称 |
| identity | string | 否 | 身份描述 |
| soul | string | 否 | 灵魂/个性 |
| mission | string | 否 | 使命描述 |
| config | object | 否 | 部分配置覆盖 |

**响应**
- 状态码：`201 Created`
```json
{
  "name": "my-custom-agent",
  "config": { ... },
  "skills": []
}
```

---

#### `POST /api/agents/:name/reload`

重新加载指定 Agent 配置。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Agent 名称 |

**响应示例**
```json
{
  "name": "document-generator",
  "config": { ... }
}
```

---

#### `GET /api/agents/:name/memory`

查询 Agent 长期记忆。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Agent 名称 |

**查询参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 否 | 搜索关键词；不传则返回全部 longTermMemory |

**响应示例（带 query）**
```json
{
  "results": [
    { "key": "lessons/xxx", "content": "...", "score": 0.95 }
  ]
}
```

**响应示例（不带 query）**
```json
{
  "longTermMemory": "积累的教学经验..."
}
```

---

#### `POST /api/agents/:name/memory`

向 Agent 追加记忆（lesson）。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Agent 名称 |

**请求体**
```json
{
  "content": "新学到的教学经验或反思..."
}
```

**响应示例**
```json
{
  "success": true
}
```

---

#### `GET /api/agents/:name/evolution`

获取待审批的进化提案列表。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Agent 名称 |

**响应示例**
```json
{
  "proposals": [
    {
      "id": "prop-xxx",
      "tenantId": "default",
      "agentName": "document-generation",
      "timestamp": "2026-03-11T10:00:00.000Z",
      "type": "soul_update",
      "description": "...",
      "diff": "...",
      "status": "pending",
      "confidence": 0.8
    }
  ]
}
```

---

#### `POST /api/agents/:name/evolution/:id/approve`

批准进化提案。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Agent 名称 |
| id | string | 是 | 提案 ID |

**响应示例**
```json
{
  "success": true,
  "proposal": { ... }
}
```

---

#### `POST /api/agents/:name/evolution/:id/reject`

拒绝进化提案。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | Agent 名称 |
| id | string | 是 | 提案 ID |

**响应示例**
```json
{
  "success": true,
  "proposal": { ... }
}
```

---

#### `GET /api/sessions/:sessionId/events`

SSE 订阅指定会话的 Agent 事件。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string | 是 | 会话 ID |

**响应**
- `Content-Type`: `text/event-stream`

---

#### `GET /api/sessions/:sessionId/artifacts`

列出会话中生成的工作区产物。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string | 是 | 会话 ID |

**响应示例**
```json
{
  "sessionId": "demo-session-001",
  "artifacts": ["images/1773214151308-79d05a06.png", "out.md"]
}
```

---

#### `GET /api/sessions/:sessionId/artifacts/*`

下载指定产物的文件内容。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string | 是 | 会话 ID |
| * | string | 是 | 产物相对路径，如 `images/1773214151308.png` |

**响应**
- 根据文件类型返回对应 `Content-Type` 和文件流

---

### 1.2.1 图床（全局图片库）

以下端点由 `registerImageRoutes` 注册，认证规则与同节其他 `/api/*` 接口一致（见上文认证说明）。

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/images/upload` | multipart 上传入库 |
| `GET` | `/api/images` | 条件列表 |
| `GET` | `/api/images/:id` | 元数据 |
| `GET` | `/api/images/:id/file` | 图片流 |
| `PATCH` | `/api/images/:id` | 更新元数据 |
| `DELETE` | `/api/images/:id` | 删除 |
| `POST` | `/api/images/from-url` | URL 导入 |
| `POST` | `/api/images/resolve` | 章节上下文匹配 |

**完整字段说明、请求/响应体、Resolve 算法与环境变量**：见 [图床服务器.md](./图床服务器.md)。

---

#### `WebSocket /ws/agents/:name`

WebSocket 与 Agent 流式交互。

**连接后发送消息**
```json
{
  "input": "请生成教案",
  "threadId": "optional",
  "sessionId": "optional",
  "context": {}
}
```

**收到消息**
- 与 SSE 流格式一致（JSON 对象）

---

### 1.3 任务管理

#### `GET /api/tasks/:id`

获取任务状态。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 任务 ID |

**响应示例**
```json
{
  "id": "task-xxx",
  "agentName": "document-generation",
  "instruction": "...",
  "status": "completed",
  "result": { ... },
  "createdAt": "2026-03-11T10:00:00.000Z",
  "completedAt": "2026-03-11T10:00:15.000Z"
}
```

**错误**
- `404`: Task not found

---

#### `GET /api/tasks`

按条件查询任务。

**查询参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agent | string | 否 | 按 Agent 名称筛选 |
| parent | string | 否 | 按父任务 ID 筛选 |

**响应示例（带 agent 或 parent）**
```json
[
  {
    "id": "task-xxx",
    "agentName": "document-generator",
    "status": "completed",
    ...
  }
]
```

**响应示例（无查询参数）**
```json
{
  "stats": {
    "size": 0,
    "pending": 0,
    "paused": 0
  }
}
```

---

#### `DELETE /api/tasks/:id`

取消待执行任务。

**路径参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 任务 ID |

**响应示例**
```json
{
  "success": true
}
```

**错误**
- `400`: Task cannot be cancelled (not pending or not found)

---

### 1.4 业务接口 - 教学资源生成

#### `POST /api/business/document-generation/upload-template`

上传 Word 模板（.docx/.doc），解析为 HTML 与骨架结构。

**请求**
- `Content-Type`: `multipart/form-data`
- 字段：`file`（Word 文件）

**响应示例**
```json
{
  "filename": "template.docx",
  "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "sizeBytes": 12345,
  "html": "<p>...</p>",
  "skeleton": {
    "sections": [...],
    "totalSections": 5,
    "totalTables": 2,
    "totalImages": 1,
    "hasMergedCells": false,
    "looksLikeFullTemplate": true
  },
  "skeletonText": "## 教学目标\n...",
  "warnings": []
}
```

**错误**
- `400`: No file uploaded / Only .docx / .doc files are accepted

---

#### `POST /api/business/document-generation/generate`

同步生成教学资源（阻塞直至完成）。

**请求体**
```json
{
  "select_knowledge_unit": "光合作用",
  "prompt": "请补充更多案例",
  "database_id": "optional-knowledge-dataset-id",
  "docCategory": "teachingMaterials",
  "docTemplate": {
    "name": "教案模板",
    "type": "lesson-plan",
    "html": "<p>...</p>",
    "markdown": "# 教学目标\n...",
    "plainText": "..."
  },
  "is_single_file_processing": false,
  "large_text": null,
  "smart_search": true,
  "knowledgeContext": "可选的知识上下文",
  "webSearchContext": "可选的联网检索上下文",
  "references": [
    {
      "title": "参考标题",
      "url": "https://...",
      "summary": "摘要",
      "imageUrls": []
    }
  ],
  "options": {
    "language": "zh-CN",
    "preserveTemplateNumbering": true,
    "requireImageSuggestions": true
  },
  "threadId": "optional",
  "sessionId": "optional"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| select_knowledge_unit / topic | string | 是 | 主题/知识点 |
| prompt / extraPrompt | string | 否 | 用户自定义补充 prompt |
| database_id | string | 否 | 知识库 ID，用于 knowledge_search |
| docCategory | string | 否 | 模版类别 |
| docTemplate | string \| object | 否 | 模版内容（html / markdown / plainText） |
| is_single_file_processing | boolean | 否 | 是否为单文件模式 |
| large_text | string | 否 | 用户上传文件内容（需 is_single_file_processing=true） |
| smart_search | boolean | 否 | 是否启用联网检索 |
| options.language | string | 否 | 输出语言，默认 zh-CN |

**响应示例**
```json
{
  "agent": "document-generator",
  "threadId": "thread-xxx",
  "markdown": "# 光合作用\n\n## 教学目标\n...",
  "skeleton": {
    "totalSections": 5,
    "totalTables": 2,
    "totalImages": 1,
    "hasMergedCells": false
  },
  "templateTruncated": false,
  "taskResult": { ... }
}
```

**错误**
- `400`: topic 或 select_knowledge_unit 为必填参数
- `503`: Required agent not found: document-generation

---

#### `POST /api/business/document-generation/generate-stream`

SSE 流式生成教学资源。

**请求体**
与 `generate` 相同。

**响应**
- `Content-Type`: `text/event-stream`
- 事件格式：`event: <type>\ndata: <JSON>\n\n`

```json
{ "type": "token", "data": { "content": "..." }, "timestamp": "..." }
{ "type": "done", "data": { "output": "..." }, "timestamp": "..." }
```

---