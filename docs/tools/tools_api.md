# 工具 API 参考

本文档详细说明 `src/tools` 下所有内置工具的输入/输出结构及智能体正确调用方式。

> **通用约定**：所有工具返回值为 **JSON 字符串**，需 `JSON.parse()` 后使用。错误时通常包含 `error` 字段。

---

## 目录

- [一、文件操作类](#一文件操作类) — file_read, file_write, file_list
- [二、HTTP 与网络](#二http-与网络) — http_request, web_search
- [三、Shell 与代码执行](#三shell-与代码执行) — shell, code_executor
- [四、子 Agent 与并行](#四子-agent-与并行) — spawn_sub_agent, spawn_parallel_agents
- [五、工作区（会话级）](#五工作区会话级) — workspace_write, workspace_read, workspace_list
- [六、图片生成](#六图片生成) — image_generate
- [七、事件与 Agent 创建](#七事件与-agent-创建) — emit_event, create_agent
- [八、知识库](#八知识库) — knowledge_list, knowledge_search, knowledge_doc_retrieve
- [九、E2B 沙箱](#九e2b-沙箱视频项目) — e2b_project_status, e2b_preflight, e2b_manage_assets, e2b_render, e2b_share, e2b_sandbox_exec
- [十、智能体调用指南](#十智能体调用指南)

---

## 一、文件操作类

### 1.1 file_read

**用途**：读取指定路径文件内容。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | ✅ | 绝对或相对文件路径 |

**输出**（成功）：
```json
{
  "success": true,
  "content": "文件内容（最多 50,000 字符）"
}
```

**输出**（失败）：
```json
{
  "error": "File not found: /path/to/file"
}
```

**调用示例**：
```json
{ "name": "file_read", "arguments": { "path": "/data/tenants/default/users/default/workspaces/xxx/artifacts/doc.md" } }
```

**注意**：`path` 需在服务可访问的目录内，通常是 `data/` 或工作区路径。

---

### 1.2 file_write

**用途**：向文件写入内容，必要时自动创建父目录。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | ✅ | 目标文件路径 |
| `content` | string | ✅ | 要写入的内容 |

**输出**（成功）：
```json
{ "success": true, "path": "/path/to/file" }
```

**输出**（失败）：
```json
{ "error": "错误信息" }
```

**调用示例**：
```json
{ "name": "file_write", "arguments": { "path": "output.md", "content": "# Hello" } }
```

---

### 1.3 file_list

**用途**：列出目录下的文件和子目录。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `directory` | string | ✅ | 目录路径 |
| `recursive` | boolean | ❌ | 是否递归（当前实现仅返回一级） |

**输出**（成功）：
```json
{
  "success": true,
  "items": [
    { "name": "file1.txt", "type": "file" },
    { "name": "subdir", "type": "directory" }
  ]
}
```

**调用示例**：
```json
{ "name": "file_list", "arguments": { "directory": "/data/tenants/default" } }
```

---

## 二、HTTP 与网络

### 2.1 http_request

**用途**：发起 HTTP 请求（GET、POST、PUT、PATCH、DELETE）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `method` | enum | ❌ | `GET`\|`POST`\|`PUT`\|`PATCH`\|`DELETE`，默认 GET |
| `url` | string | ✅ | 完整 URL（需符合 url 格式） |
| `headers` | string | ❌ | 请求头 JSON 字符串，如 `"{\"Authorization\":\"Bearer xxx\"}"` |
| `body` | string | ❌ | 请求体字符串 |
| `timeout` | number | ❌ | 超时毫秒，默认 30,000 |

**输出**（成功）：
```json
{
  "status": 200,
  "statusText": "OK",
  "headers": { "content-type": "application/json", "..." },
  "body": "响应体（最多 20,000 字符，JSON 会自动 stringify）"
}
```

**输出**（失败）：
```json
{ "error": "错误信息" }
```

**调用示例**：
```json
{
  "name": "http_request",
  "arguments": {
    "method": "POST",
    "url": "https://api.example.com/v1/action",
    "headers": "{\"Content-Type\":\"application/json\"}",
    "body": "{\"key\":\"value\"}"
  }
}
```

**注意**：`headers` 必须传合法的 JSON 字符串。

---

### 2.2 web_search

**用途**：通过 SearchApi.io 的 Google 搜索，返回结构化结果，可选提取前 5 条链接正文。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `query` | string | ✅ | - | 搜索关键词 |
| `location` | string | ❌ | - | 地理位置，如 `"New York,United States"` |
| `num` | number | ❌ | 10 | 请求结果数量 |
| `timeout` | number | ❌ | 30,000 | 超时毫秒 |
| `extract_content` | boolean | ❌ | false | 为 true 时对前 5 条 URL 拉取并提取正文 |

**输出**（成功）：
```json
{
  "search_metadata": { "id": "...", "status": "Success" },
  "query": "实际搜索的 query",
  "ai_overview": "AI 摘要（若有）",
  "knowledge_graph": { "title": "...", "description": "...", "type": "...", "image": "...", "source": "..." },
  "organic_results": [
    {
      "position": 1,
      "title": "标题",
      "link": "https://...",
      "snippet": "摘要",
      "extracted_content": "正文（仅 extract_content=true 时前 5 条有）"
    }
  ],
  "inline_images": { "images": [] },
  "related_questions": []
}
```

**输出**（失败）：
```json
{ "error": "Search API Key is missing. Please set SEARCH_API_KEY in the environment." }
```
或
```json
{ "status": 400, "error": "..." }
```

**环境变量**：`SEARCH_API_KEY`（SearchApi.io）

**调用示例**：
```json
{
  "name": "web_search",
  "arguments": {
    "query": "LangChain agent 最佳实践 2024",
    "num": 5,
    "extract_content": true
  }
}
```

**智能体建议**：当只需要简短回答或确认事实时，设置 `extract_content: false` 即可从 snippet 获知；当需要深究内容（如代码示例、详细步骤）时，请设置 `extract_content: true`。

---

## 三、Shell 与代码执行

### 3.1 shell

**用途**：在服务器上执行 shell 命令，返回 stdout 和 stderr。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | ✅ | 要执行的 shell 命令 |
| `cwd` | string | ❌ | 工作目录 |
| `timeout` | number | ❌ | 超时毫秒，默认 30,000 |

**输出**（成功）：
```json
{
  "success": true,
  "stdout": "stdout 内容（最多 10,000 字符）",
  "stderr": "stderr 内容（最多 5,000 字符）"
}
```

**输出**（失败）：
```json
{
  "success": false,
  "error": "错误信息"
}
```

**调用示例**：
```json
{ "name": "shell", "arguments": { "command": "ls -la /data", "cwd": "/tmp" } }
```

**安全**：命令在服务端执行，需严格控制权限。

---

### 3.2 code_executor

**用途**：执行 TypeScript 或 Python 代码，返回 stdout/stderr。支持自定义工作目录和最长 600s 超时。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `language` | enum | ✅ | `"typescript"` \| `"python"` |
| `code` | string | ✅ | 要执行的代码 |
| `timeout` | number | ❌ | 超时毫秒，默认 30,000，最大 600,000 |
| `workingDir` | string | ❌ | 工作目录，必须在 data 或 temp 内 |
| `env` | record | ❌ | 额外环境变量，如 `{"MY_VAR":"value"}` |

**输出**（成功）：
```json
{
  "success": true,
  "stdout": "stdout（最多 10,000 字符）",
  "stderr": "stderr（最多 5,000 字符）"
}
```

**输出**（失败）：
```json
{
  "success": false,
  "error": "错误信息"
}
```

**调用示例**：
```json
{
  "name": "code_executor",
  "arguments": {
    "language": "python",
    "code": "print(1+1)"
  }
}
```

**注意**：`workingDir` 必须落在 `data` 或系统 temp 目录下。

---

## 四、子 Agent 与并行

### 4.1 spawn_sub_agent

**用途**：派生子 Agent 执行指定任务，子 Agent 与当前会话共享工作区。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentName` | string | ✅ | 已注册的 Agent 名称 |
| `instruction` | string | ✅ | 任务说明 |
| `model` | string | ❌ | 覆盖 LLM 模型（成本优化） |
| `parallel` | boolean | ❌ | 为 true 时不等待完成，异步执行 |

**输出**（成功）：
```json
{
  "success": true,
  "taskId": "uuid",
  "agentName": "xxx",
  "result": "子 Agent 返回结果",
  "duration": 1234
}
```

**输出**（失败）：
```json
{ "success": false, "error": "..." }
```

**调用示例**：
```json
{
  "name": "spawn_sub_agent",
  "arguments": {
    "agentName": "section-writer",
    "instruction": "请根据以下大纲撰写第一章内容：..."
  }
}
```

**智能体建议**：先通过 `GET /api/agents` 确认可用 Agent 列表。

---

### 4.2 spawn_parallel_agents

**用途**：并行派生多个子 Agent，共享工作区和租户隔离。（会话相关，需 sessionId）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tasks` | array | ✅ | 任务列表，每项含 `agentName`、`instruction`、`model`、`context` |

**输出**（成功）：
```json
{
  "success": true,
  "totalTasks": 3,
  "succeeded": 2,
  "failed": 1,
  "results": [
    { "agentName": "xxx", "taskId": "uuid", "success": true, "duration": 1000, "result": "..." },
    { "agentName": "yyy", "taskId": "uuid", "success": false, "duration": 500, "result": null }
  ]
}
```

**调用示例**：
```json
{
  "name": "spawn_parallel_agents",
  "arguments": {
    "tasks": [
      { "agentName": "researcher", "instruction": "研究主题 A" },
      { "agentName": "researcher", "instruction": "研究主题 B" }
    ]
  }
}
```

---

## 五、工作区（会话级）

> 以下工具仅在存在 `sessionId` 时可用，由 `dynamicToolRegistry` 按会话创建。

### 5.1 workspace_write

**用途**：将文件写入当前会话的共享工作区，其他 Agent 可读。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 文件名或路径，如 `research.md`、`scenes/scene-1.tsx` |
| `content` | string | ✅ | 文件内容 |

**说明**：不以 `assets/`、`artifacts/`、`logs/` 开头时，会自动加 `assets/` 前缀。

**输出**（成功）：
```json
{ "success": true, "path": "assets/research.md", "sessionId": "xxx" }
```

**调用示例**：
```json
{ "name": "workspace_write", "arguments": { "name": "research.md", "content": "# 调研报告\n..." } }
```

---

### 5.2 workspace_read

**用途**：从当前会话工作区读取文件。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 文件路径 |

**输出**（成功）：
```json
{ "success": true, "name": "research.md", "content": "文件内容（最多 50,000 字符）" }
```

**输出**（失败）：
```json
{ "success": false, "error": "Artifact not found: xxx" }
```

---

### 5.3 workspace_list

**用途**：列出当前会话工作区内的所有文件/产物。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| （无） | - | - | 无需参数 |

**输出**（成功）：
```json
{
  "success": true,
  "sessionId": "xxx",
  "artifacts": [
    { "name": "research.md", "size": 1024, "createdAt": "...", "modifiedAt": "..." }
  ]
}
```

---

## 六、图片生成

### 6.1 image_generate

**用途**：通过 AI 生成图片（Gemini 或 DALL-E 兼容 API），自动保存到会话工作区。

> 按会话动态创建，需 sessionId。环境变量：`IMAGE_GENERATE_MODEL`、`IMAGE_GENERATE_API_KEY`（或 `OPENROUTER_API_KEY` / `OPENAI_API_KEY`）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | ✅ | 图片描述提示词，建议英文 |
| `timeout` | number | ❌ | 超时毫秒，默认 90,000，范围 5,000–180,000 |

**输出**（成功）：
```json
{
  "success": true,
  "imageUrl": "本地或远程图片 URL",
  "filePath": "本地文件路径",
  "fileName": "xxx.png",
  "markdownImage": "![prompt](imageUrl)",
  "textResponse": "模型附带文本（若有）"
}
```

**输出**（失败）：
```json
{ "success": false, "error": "OPENROUTER_API_KEY is not configured for Gemini image generation" }
```

**调用示例**：
```json
{
  "name": "image_generate",
  "arguments": {
    "prompt": "A professional diagram showing data flow in a microservices architecture"
  }
}
```

---

## 七、事件与 Agent 创建

### 7.1 emit_event

**用途**：向当前会话的事件总线发送事件，供前端或其他 Agent 监听。（会话相关）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `eventType` | enum | ✅ | `"progress"` \| `"custom"` |
| `message` | string | ✅ | 人类可读消息 |
| `data` | object | ❌ | 额外结构化数据 |

**输出**（成功）：
```json
{ "success": true, "eventType": "progress", "sessionId": "xxx" }
```

---

### 7.2 create_agent

**用途**：运行时从 `_template` 创建新 Agent，可随后通过 `spawn_sub_agent` 调用。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 唯一名称，小写无空格 |
| `identity` | string | ✅ | 身份定义：角色与能力 |
| `mission` | string | ✅ | 使命：目标与成功标准 |
| `soul` | string | ❌ | 行为准则（CORE/MUTABLE 格式） |
| `model` | string | ❌ | 使用的 LLM 模型 |
| `allowedTools` | string[] | ❌ | 允许使用的工具列表，默认全部 |

**输出**（成功）：
```json
{
  "success": true,
  "agentName": "xxx",
  "model": "gpt-4o",
  "skills": ["skill1", "skill2"]
}
```

**输出**（失败）：
```json
{ "success": false, "error": "Agent \"xxx\" already exists" }
```

---

## 八、知识库

### 8.1 knowledge_list

**用途**：列出 Dify 中可用的知识库（数据集）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `keyword` | string | ❌ | 按名称或描述过滤 |

**输出**（成功）：
```json
{
  "success": true,
  "total": 5,
  "datasets": [
    {
      "id": "xxx",
      "name": "产品手册",
      "description": "...",
      "documentCount": 10,
      "wordCount": 50000
    }
  ]
}
```

**调用建议**：搜索前先调用 `knowledge_list` 获取 dataset id。

---

### 8.2 knowledge_search

**用途**：在知识库中检索，支持单查询/多查询 RRF 融合、重排序等。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | ✅* | 主查询（`queries` 存在时被忽略） |
| `queries` | string[] | ❌ | 多查询用于 RRF 融合 |
| `datasetIds` | string[] | ❌ | 目标数据集 ID |
| `datasetNames` | string[] | ❌ | 按名称模糊匹配数据集 |
| `searchMethod` | enum | ❌ | `hybrid_search`\|`semantic_search`\|`full_text_search`\|`keyword_search` |
| `topK` | number | ❌ | 最大返回数，1–50 |
| `scoreThreshold` | number | ❌ | 最低相关性分数，0–1 |
| `enableRerank` | boolean | ❌ | 是否启用重排序 |
| `documentFilter` | string[] | ❌ | 限制到指定文档名 |

**输出**（成功，RetrievalResult）：
```json
{
  "success": true,
  "query": "xxx 或 [query1, query2]",
  "totalResults": 10,
  "results": [
    {
      "content": "文本片段",
      "score": 0.85,
      "source": {
        "datasetId": "xxx",
        "datasetName": "产品手册",
        "documentId": "yyy",
        "documentName": "第一章",
        "segmentId": "zzz"
      },
      "position": 1,
      "keywords": ["关键词"],
      "sourceType": "document"
    }
  ],
  "metadata": {
    "datasetsSearched": 1,
    "searchMethod": "hybrid_search",
    "rerankUsed": true,
    "rrfUsed": false,
    "durationMs": 200
  }
}
```

**调用示例**：
```json
{
  "name": "knowledge_search",
  "arguments": {
    "query": "如何配置代理",
    "datasetIds": ["dataset-id-from-knowledge_list"],
    "topK": 5
  }
}
```

---

### 8.3 knowledge_doc_retrieve

**用途**：按文档 ID 获取完整文档内容，适用于已确定文档的场景。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `datasetId` | string | ✅ | 数据集 ID |
| `documentId` | string | ✅ | 文档 ID |

**输出**（成功）：
```json
{
  "success": true,
  "document": {
    "documentId": "xxx",
    "documentName": "第一章",
    "sourceType": "upload",
    "totalBlocks": 5,
    "contentBlocks": [
      { "content": "段落内容", "position": 1, "score": null }
    ],
    "metadata": {},
    "videoUrl": "（若有）",
    "duration": "（若有）"
  }
}
```

**输出**（失败）：
```json
{ "success": false, "error": "Document not found or contains no segments" }
```

---

## 九、E2B 沙箱（视频/项目）

### 9.1 e2b_project_status

**用途**：获取 E2B 项目状态和预览数据，用于验证推送后是否编译通过。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectId` | string | ✅ | E2B 项目 ID |

**输出**（成功）：
```json
{
  "status": { "bundleStatus": "pending|building|ready|error", "manifest": [...], "bundleUrl": "...", "errors": [] },
  "previewData": { "scenes": [...], "durations": [...] }
}
```

**环境变量**：`E2B_BASE_URL`（默认 `http://35.232.154.66:7780`）

**调用示例**：
```json
{ "name": "e2b_project_status", "arguments": { "projectId": "proj-xxx" } }
```

---

### 9.2 e2b_preflight

**用途**：对 E2B 项目做运行前检查，检测编译错误、缺失导入、运行时异常。用于自愈：若有错误则修复代码后重新推送。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectId` | string | ✅ | 项目 ID |

**输出**：直接返回 E2B API 的原始 JSON。有错误时包含 `error` 等字段。

**调用示例**：
```json
{ "name": "e2b_preflight", "arguments": { "projectId": "proj-xxx" } }
```

---

### 9.3 e2b_manage_assets

**用途**：管理 E2B 项目资源（图片、音频、视频）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | enum | ✅ | `upload`\|`list`\|`get`\|`delete` |
| `projectId` | string | ✅ | 项目 ID |
| `assetId` | string | ❌ | 资源 ID（get/delete 必填） |
| `fileSource` | string | ❌ | 本地路径或 HTTP URL（upload 必填） |
| `type` | string | ❌ | `image`\|`audio`\|`video`（upload 必填） |
| `role` | string | ❌ | `cover`\|`bgm`\|`sfx`\|`logo`\|`illustration`\|`broll`\|`avatar`（upload 必填） |
| `title` | string | ❌ | 标题 |
| `description` | string | ❌ | 描述 |
| `tags` | string[] | ❌ | 标签 |
| `limit` | number | ❌ | 分页 limit |
| `offset` | number | ❌ | 分页 offset |

---

### 9.4 e2b_render

**用途**：在 E2B 上渲染视频。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | enum | ✅ | `start`\|`poll`\|`poll_gpu`\|`queue` |
| `projectId` | string | ❌ | 项目 ID（start/poll 需要） |
| `jobId` | string | ❌ | 渲染任务 ID（poll/poll_gpu 需要） |
| `compositionId` | string | ❌ | Remotion 合成 ID，默认 MainVideo |

---

### 9.5 e2b_share

**用途**：生成 E2B 项目分享链接或获取视频配置。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | enum | ✅ | `share`\|`profile` |
| `projectId` | string | ✅ | 项目 ID |

---

### 9.6 e2b_sandbox_exec

**用途**：在 E2B 沙箱内执行 shell 命令，用于调试。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sandboxId` | string | ✅ | 沙箱 ID |
| `cmd` | string | ✅ | 命令 |
| `timeoutMs` | number | ❌ | 超时毫秒，默认 5,000 |

---

## 十、3D 素材与仿真项目管理类

### 10.1 asset_search

**用途**：搜索 3D 素材库，查找符合描述的模型、环境或材质。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 否 | 搜索关键词 |
| `category` | enum | 否 | `model`\|`environment`\|`material` |
| `tags` | string[]| 否 | 标签筛选 |
| `limit` | number | 否 | 返回数量限制（默认10） |

---

### 10.2 asset_metadata

**用途**：获取指定 3D 素材的详细元数据（包含尺寸、动画列表、材质信息等）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `assetId` | string | ✅ | 素材 ID |

---

### 10.3 sim_project_init

**用途**：从仿真模板初始化 3D 虚拟仿真项目。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectName` | string | ✅ | 项目名称 |
| `template` | string | 否 | 使用的模板名称（默认为 `default`） |

---

### 10.4 sim_inject_scene

**用途**：将 AI 生成的 3D 场景代码 (R3F) 注入到仿真项目工程中。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectId` | string | ✅ | 项目 ID |
| `sceneId` | string | ✅ | 场景 ID |
| `code` | string | ✅ | React Three Fiber 组件代码 |
| `dependencies` | string[]| 否 | 需要安装的额外 npm 依赖 |

---

### 10.5 sim_build

**用途**：触发仿真项目的前端构建。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectId` | string | ✅ | 项目 ID |

---

### 10.6 sim_deploy

**用途**：将已构建完成的仿真项目部署到静态资源服务器目录，并生成预览入口。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectId` | string | ✅ | 项目 ID |
| `version` | string | 否 | 版本号（可选） |

---

### 10.7 sim_preview

**用途**：获取已部署仿真项目的预览 URL 和资源清单信息。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `projectId` | string | ✅ | 项目 ID |

---

## 十一、智能体调用指南

### 11.1 工具白名单

Agent 的 `agent.config.yaml` 中 `allowedTools` 需包含要调用的工具名，或使用 `["*"]` 全部允许。

### 11.2 会话相关工具

以下工具**必须在有 sessionId 的上下文中**才可用：
- `workspace_write`、`workspace_read`、`workspace_list`
- `spawn_parallel_agents`
- `emit_event`
- `image_generate`

### 11.3 环境变量

| 工具 | 环境变量 |
|------|----------|
| web_search | `SEARCH_API_KEY` |
| image_generate | `IMAGE_GENERATE_MODEL`、`IMAGE_GENERATE_API_KEY` 或 `OPENROUTER_API_KEY` |
| knowledge_* | Dify 相关配置（见 `config-helper`） |
| e2b_* | `E2B_BASE_URL` |

### 11.4 结果解析

1. 所有返回值均为 **JSON 字符串**，需 `JSON.parse()`。
2. 先检查 `error` 或 `success: false`。
3. 成功时根据各工具文档中的输出结构读取字段。
4. 部分输出会截断（如 file_read 50k、http body 20k、web_search 50k）。

### 11.5 推荐调用顺序

- **知识库**：`knowledge_list` → `knowledge_search` →（如需全文）`knowledge_doc_retrieve`
- **网页信息**：`web_search`（需要深度阅读时设 `extract_content: true`）
- **跨 Agent 协作**：先 `workspace_write` 写入中间结果，再 `spawn_sub_agent` 或 `spawn_parallel_agents`
- **图片**：知识库/搜索无合适图时，用 `image_generate` 生成
