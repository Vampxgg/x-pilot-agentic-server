# src 核心目录与文件说明

本文档按目录结构说明 `src` 下每个文件的职责与作用。

---

## 1. 入口与启动

### `index.ts`
- **用途**：应用入口
- **职责**：加载配置 → 初始化 Agent 注册表 → 启动 Heartbeat → 启动 HTTP 服务，并处理 SIGINT/SIGTERM 优雅退出。

---

## 2. API 层（`src/api/`）

### `server.ts`
- **用途**：创建 Fastify 服务
- **职责**：注册 CORS、WebSocket、multipart、静态文件，应用 auth 中间件，注册健康/Agent/Task/Business 路由，并通过 `routeRegistry` 挂载业务路由。

### `route-registry.ts`
- **用途**：业务路由注册表
- **职责**：维护路由注册函数列表，启动时批量挂载到 Fastify（供 `apps/<domain>/code/` 等业务模块使用）。

### `middleware/auth.ts`
- **用途**：认证中间件
- **职责**：读取 `config/tenants.yaml` 解析租户/用户，从 Header 或 Query 提取 API Key，映射到 tenantId/userId 并挂载到 request。

### `routes/agent.routes.ts`
- **用途**：Agent 相关 HTTP 路由
- **职责**：`GET/POST /api/agents` 列举/创建 Agent；`/invoke`、`/invoke-async`、`/stream` 同步/异步/SSE 调用；记忆读写、进化提案、会话事件 SSE、产物管理、WebSocket 等。

### `routes/task.routes.ts`
- **用途**：任务路由
- **职责**：`GET /api/tasks/:id` 查询任务状态；按 agent/parent 筛选；`DELETE /api/tasks/:id` 取消任务。

### `routes/health.routes.ts`
- **用途**：健康检查
- **职责**：`GET /api/health` 返回 status、timestamp、agents/tools/tasks 统计。

### `routes/business.routes.ts`
- **用途**：业务路由占位
- **职责**：业务路由通常在 `apps/document-generation/code/`、`apps/video-course/code/` 等地方通过 routeRegistry 注册。此处可提供向后兼容或基础占位。

---

## 3. 核心编排（`src/core/`）

### `types.ts`
- **用途**：核心类型定义
- **职责**：Agent 配置、提示文件、Pipeline、记忆、反思、任务结果、子 Agent 结果、进化提案等类型。

### `agent-registry.ts`
- **用途**：Agent 注册表
- **职责**：注册内置工具和技能，发现并加载 `apps/` 下的 Agent，合并各 Agent 本地技能，提供 get/list/create/reload。

### `agent-loader.ts`
- **用途**：Agent 加载器
- **职责**：发现 Agent 目录，读取 `agent.config.yaml`、提示文件（IDENTITY.md、SOUL.md、MISSION.md 等），加载技能。

### `agent-runtime.ts`
- **用途**：Agent 运行时
- **职责**：根据 Agent 配置组装工具链，调用 LangGraph 执行推理，支持 Pipeline 与 LLM 模式切换，提供 invoke/stream/async 等调用方式。

### `agent-graph.ts`
- **用途**：LangGraph 图定义
- **职责**：定义 Agent 状态（messages、记忆、工具调用等），实现 `buildAgentGraph`，包含工具调用、反思、记忆更新等节点与边。

### `output-parser.ts`
- **用途**：输出解析
- **职责**：按 outputFormat（text/json/code）解析 Agent 输出，支持裸 JSON、代码块提取、schema 校验。

### `event-bus.ts`
- **用途**：事件总线
- **职责**：发布/订阅 task_complete、task_failed、artifact_created、progress 等事件，支持按类型、会话、Agent 订阅。

### `pipeline-executor.ts`
- **用途**：Pipeline 执行器
- **职责**：对配置了 Pipeline 的 Agent，按依赖拓扑排序执行步骤，支持子 Agent 调用和自定义 handler，合并结果。

### `task-executor.ts`
- **用途**：任务队列
- **职责**：基于 p-queue 的任务队列，支持提交、并行、轮询、取消，供异步任务和子 Agent 使用。

### `sub-agent-manager.ts`
- **用途**：子 Agent 管理器
- **职责**：负责调用和调度子 Agent，支持重试、超时、结果解析；提供 spawn_sub_agent 工具。

### `sse-writer.ts`
- **用途**：统一 SSE 写入器
- **职责**：封装流式事件的发送，添加 id/task_id/session_id 包装，支持心跳及标准化消息格式。

### `stream-protocol.ts`
- **用途**：流式协议定义
- **职责**：定义所有 `StreamEvent` 的数据结构和工厂方法，如 task_started、agent_message、tool_started 等。

---

## 4. 工具（`src/tools/`）

### `tool-registry.ts`
- **用途**：工具注册表
- **职责**：注册、获取、列举工具，支持按名称列表或 `*` 批量获取。

### `tool-executor.ts`
- **用途**：工具执行器
- **职责**：带超时的工具调用包装，执行并记录。

### `dynamic-tool-registry.ts`
- **用途**：动态工具注册表
- **职责**：按 tenant/user/session 创建工具实例（如 workspace_*、emit_event、image_generate）。

### 内置工具（`built-in/`）
| 文件 | 工具名 | 用途 |
|------|--------|------|
| `file-ops.ts` | file_read, file_write, file_list | 文件读写、列举 |
| `shell.ts` | shell | 执行 shell 命令 |
| `code-executor.ts` | code_executor | 执行代码片段 |
| `http-request.ts` | http_request | HTTP 请求 |
| `web-search.ts` | web_search | 网页搜索（SearchAPI + 正文提取） |
| `image-generate.ts` | image_generate | 图片生成（按 Agent 配置动态创建） |
| `sub-agent.ts` | spawn_sub_agent | 子 Agent 调用 |
| `create-agent.ts` | create_agent | 运行时创建 Agent |
| `event-emit.ts` | emit_event | 向事件总线发送事件 |
| `workspace.ts` | workspace_write, workspace_read, workspace_list | 会话级工作区读写 |
| `spawn-parallel.ts` | spawn_parallel_agents | 并行 spawn 子 Agent |
| `e2b.ts` | e2b_* | E2B 沙箱（项目状态、预检、资产管理、渲染、分享、沙箱执行） |
| `knowledge-search.ts` | knowledge_search | 知识库检索（Dify + RRF + 重排序） |
| `knowledge-list.ts` | knowledge_list | 列出 Dify 知识库 |
| `knowledge-doc-retrieve.ts` | knowledge_doc_retrieve | 获取知识库文档全文 |
| `web-search.ts` | web_search | 联网检索（SearchApi.io），支持网页内容提取 |

### 知识库（`knowledge/`）
| 文件 | 用途 |
|------|------|
| `index.ts` | 导出知识库模块 |
| `types.ts` | Dify、检索、格式化等相关类型 |
| `dify-client.ts` | Dify API 客户端 |
| `kb-manager.ts` | 知识库、元数据管理 |
| `rag-service.ts` | RAG 检索服务 |
| `retrieval-engine.ts` | 检索引擎（RRF 合并、重排） |
| `content-formatter.ts` | 检索结果格式化 |
| `config-helper.ts` | 知识库配置读取与校验 |

---

## 5. 记忆（`src/memory/`）

### `memory-manager.ts`
- **用途**：记忆总入口
- **职责**：选择 file/postgres 存储，集成长时记忆、整合器和搜索。

### `short-term.ts`
- **用途**：短时记忆
- **职责**：创建/更新 WorkingMemory（facts、context、shortTermLog），汇总为文本摘要。

### `long-term.ts`
- **用途**：长时记忆
- **职责**：读写 MEMORY.md，支持 appendLesson，并调用底层 store 搜索。

### `memory-consolidator.ts`
- **用途**：记忆整合
- **职责**：读取日志，用 LLM 生成摘要，合并到长时记忆。

### `stores/file-store.ts`
- **用途**：文件存储
- **职责**：基于文件系统的记忆读写、追加、搜索。

### `stores/pg-store.ts`
- **用途**：PostgreSQL 存储
- **职责**：基于 Postgres 的记忆存储实现（可替代文件存储）。

---

## 6. 进化（`src/evolution/`）

### `heartbeat.ts`
- **用途**：心跳运行器
- **职责**：按配置周期性执行记忆整合和进化，根据反思生成提案并可按置信度自动应用。

### `evolver.ts`
- **用途**：进化器
- **职责**：基于反思，用 LLM 生成进化提案（soul_update、new_skill、config_change、workflow_adjustment），管理提案状态。

### `reflector.ts`
- **用途**：反思器
- **职责**：任务结束后用 LLM 分析工具调用和子 Agent 结果，输出 lessonsLearned、suggestedImprovements、confidence。

### `skill-crystallizer.ts`
- **用途**：技能结晶
- **职责**：从重复出现的工具调用序列中提炼可复用技能（Markdown 定义）。

### `proposal-applier.ts`
- **用途**：提案应用
- **职责**：将已批准的进化提案应用到文件（SOUL_OVERRIDE、新技能、config_override、workflow 记录等）。

---

## 7. LLM（`src/llm/`）

### `provider.ts`
- **用途**：LLM 提供方
- **职责**：根据模型名解析 provider（openai、anthropic、openrouter、zhipu 等），创建 LangChain ChatModel 实例。

### `model-router.ts`
- **用途**：模型路由
- **职责**：为 Agent 获取主模型及 fallback，按复杂度选择模型，并缓存实例。

### `resilient-model.ts`
- **用途**：容错模型
- **职责**：为主模型配置 fallback 链，识别 429/503 等可重试错误。

---

## 8. 技能（`src/skills/`）

### `skill-registry.ts`
- **用途**：技能注册表
- **职责**：注册、获取、列举 SkillDefinition。

### `skill-loader.ts`
- **用途**：技能加载
- **职责**：从目录加载 .md 技能，格式化到 Prompt。

### 内置技能（`built-in/`）
| 文件 | 用途 |
|------|------|
| `self-reflect.ts` | 自我反思技能 |
| `self-evolve.ts` | 自我进化技能 |
| `memory-search.ts` | 记忆搜索技能 |

---

## 9. 工具类（`src/utils/`）

### `config.ts`
- **用途**：配置加载
- **职责**：加载 config/default.yaml，支持 env 变量覆盖，提供 loadConfig / getConfig。

### `logger.ts`
- **用途**：日志
- **职责**：Winston 配置，控制台 + 文件输出，支持 createAgentLogger。

### `md-parser.ts`
- **用途**：Markdown 解析
- **职责**：gray-matter 解析 frontmatter，提取正文。

### `template-parser.ts`
- **用途**：模板解析
- **职责**：docx → HTML → 骨架提取（标题、表格、图片、列表），用于文档生成 Agent 的结构化输入。

### `content-extractor.ts` & `content-cleaner.ts`
- **用途**：网页内容提取与清理
- **职责**：配合 `web-search.ts` 从原始 HTML 中提取正文内容并降噪。

### `large-text-chunker.ts`
- **用途**：大文本分块
- **职责**：对过长的文本内容进行合理分块（Chunking），防止 Token 超限。

### `content-extractor.ts`
- **用途**：正文提取
- **职责**：从 URL 拉取 HTML，用 Readability 提取正文，转 Markdown，可配合 content-cleaner 清洗。

### `content-cleaner.ts`
- **用途**：正文清洗
- **职责**：去除导航、页脚、广告、版权等噪音，规范化空白，供 LLM 消费。

### `large-text-chunker.ts`
- **用途**：大文本分块
- **职责**：按标题/段落切分长文本，生成带 sectionRef、excerpt、charStart/charEnd 的 chunk，用于文档生成避免上下文溢出。

---

## 10. 数据流概览

```
请求 → auth middleware → 路由 → agent-runtime
                                    ↓
agent-registry (Agent 定义) + tool-registry + skill-registry
                                    ↓
agent-graph (LangGraph) ← model-router ← llm/provider
                                    ↓
tool-executor / sub-agent-manager / pipeline-executor
                                    ↓
memory-manager / event-bus / workspaceManager
```
