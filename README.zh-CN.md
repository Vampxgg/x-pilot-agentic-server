# X-Pilot Agentic Server — 中文开发手册

> AI 智能体服务基座，为 X-Pilot 职业教育平台提供多智能体编排、自进化、多租户隔离的 Agent-as-a-Service 能力。

---

## 目录

- [架构哲学](#架构哲学)
- [整体架构](#整体架构)
- [系统分层](#系统分层)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [核心概念](#核心概念)
  - [Agent 定义](#agent-定义)
  - [LangGraph 执行流](#langgraph-执行流)
  - [声明式 Pipeline（多 Agent 编排）](#声明式-pipeline多-agent-编排)
  - [Agent IO 契约（结构化输出）](#agent-io-契约结构化输出)
  - [子 Agent 重试机制](#子-agent-重试机制)
  - [工具系统](#工具系统)
  - [技能系统](#技能系统)
  - [记忆系统](#记忆系统)
  - [自进化系统](#自进化系统)
  - [多租户与认证](#多租户与认证)
- [业务层智能体开发指南](#业务层智能体开发指南)
  - [新建业务智能体的完整步骤](#新建业务智能体的完整步骤)
  - [Agent 文件夹规范](#agent-文件夹规范)
  - [业务路由开发规范](#业务路由开发规范)
  - [构建多 Agent 协作应用](#构建多-agent-协作应用)
  - [现有示例：教学资源生成器](#现有示例教学资源生成器)
- [API 参考](#api-参考)
- [快速上手](#快速上手)
- [配置说明](#配置说明)

---

## 架构哲学

本系统的设计遵循五条核心原则，确保**永远站在 LLM 技术迭代之上**：

| # | 原则 | 含义 |
|---|------|------|
| 1 | **LLM 是可替换的推理引擎，不是架构本身** | 系统通过 pipeline/tools/constraints 定义"做什么"，LLM 只负责"怎么想"。换掉模型，业务逻辑零修改。 |
| 2 | **协议优于提示词 (Protocol over Prompt)** | Agent 间数据流通过 IO Schema 约定格式。提示词会随模型迭代失效，协议不会。 |
| 3 | **确定性编排，创意推理** | 多 Agent 执行顺序用声明式 Pipeline 配置，LLM 推理只用在每个步骤内部的创意决策。 |
| 4 | **工具是能力边界，LLM 是决策引擎** | Agent 能力上限由 `allowedTools` 决定。LLM 调用工具=手，LLM 推理=脑。 |
| 5 | **分层隔离** | 无论底层换什么 LLM SDK/数据库/执行引擎，`apps/` 里的 Markdown 和 YAML 稳定不变。 |

---

## 整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          客户端 (前端 / 第三方系统)                        │
│                  REST / SSE / WebSocket / Webhook                       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│                        API 网关层 (Fastify)                              │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  ┌───────────────┐  │
│  │ 认证中间件 │  │ 通用 Agent API │  │ 业务路由       │  │ 任务/会话 API  │  │
│  │  (多租户)  │  │ /api/agents   │  │ /api/business │  │ /api/tasks    │  │
│  └──────────┘  └──────┬───────┘  └───────┬───────┘  └───────────────┘  │
└─────────────────────────┼────────────────┼──────────────────────────────┘
                          │                │
┌─────────────────────────▼────────────────▼──────────────────────────────┐
│                      核心运行时层 (src/core/)                             │
│                                                                         │
│  ┌───────────────┐  ┌────────────────┐  ┌──────────────────────┐       │
│  │ AgentRegistry  │  │ AgentRuntime   │  │ SubAgentManager      │       │
│  │ (注册/发现)    │  │ (调用/流式)    │  │ (子Agent编排)         │       │
│  └───────┬───────┘  └───────┬────────┘  └──────────┬───────────┘       │
│          │                  │                       │                    │
│  ┌───────▼──────────────────▼───────────────────────▼───────────┐       │
│  │              LangGraph 状态图 (agent-graph.ts)                │       │
│  │                                                               │       │
│  │   START ──▶ perceive ──▶ think ──┬──▶ act ──▶ observe ──┐   │       │
│  │                                  │                       │   │       │
│  │                                  │   ┌───────────────────┘   │       │
│  │                                  │   │                       │       │
│  │                                  │   ▼                       │       │
│  │                                  └──▶ reflect ──▶ END        │       │
│  │                                                               │       │
│  │   路由规则:                                                    │       │
│  │   think → 有 tool_calls ? act : reflect                       │       │
│  │   observe → 迭代<max && 非连续失败 ? think : reflect           │       │
│  └───────────────────────────────────────────────────────────────┘       │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ TaskExecutor  │  │ EventBus     │  │ Workspace    │                  │
│  │ (p-queue)    │  │ (事件分发)   │  │ (会话产物)    │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────────────┐
│                       基础设施层                                         │
│                                                                         │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────┐     │
│  │ 工具系统          │  │ 记忆系统          │  │ LLM 供应商抽象层    │     │
│  │ (Tool Registry)  │  │ (Memory Manager) │  │ (Model Router)     │     │
│  │                   │  │                  │  │                    │     │
│  │ code_executor     │  │ 工作记忆          │  │ OpenAI             │     │
│  │ http_request      │  │ (Working)        │  │ Anthropic          │     │
│  │ file_ops          │  │                  │  │ Zhipu (智谱)       │     │
│  │ shell             │  │ 每日日志          │  │ ...                │     │
│  │ knowledge_search  │  │ (Daily Log)      │  │                    │     │
│  │ image_generate    │  │                  │  └────────────────────┘     │
│  │ spawn_sub_agent   │  │ 长期记忆          │                            │
│  │ spawn_parallel    │  │ (Long-term)      │  ┌────────────────────┐     │
│  │ workspace_*       │  │                  │  │ 技能系统            │     │
│  │ emit_event        │  │ 存储后端:         │  │ (Skill Registry)   │     │
│  └─────────────────┘  │ · File Store     │  │                    │     │
│                        │ · PostgreSQL     │  │ self-reflect       │     │
│                        └──────────────────┘  │ self-evolve        │     │
│                                              │ memory-search      │     │
│  ┌──────────────────────────────┐            │ (agent级自定义)     │     │
│  │ 自进化系统 (evolution/)       │            └────────────────────┘     │
│  │                               │                                       │
│  │ Reflector → 反思提取经验教训    │                                       │
│  │ MemoryConsolidator → 日志合并  │                                       │
│  │ SkillCrystallizer → 技能结晶   │                                       │
│  │ Evolver → 进化提案             │                                       │
│  │ ProposalApplier → 应用提案     │                                       │
│  │ HeartbeatRunner → 定期维护     │                                       │
│  └──────────────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────────────┐
│                       智能体应用层 (apps/)                               │
│                                                                         │
│  每个应用是一个独立文件夹，包含一个或多个 Agent:                           │
│                                                                         │
│  apps/                                                                  │
│  ├── _template/              ← 新 Agent 模板（不会被加载）                │
│  ├── system/                 ← 系统级应用                                │
│  │   └── orchestrator/       ←   顶层编排Agent                          │
│  ├── document-generation/    ← 文稿生成应用（多 Agent）                   │
│  │   ├── code/               ←   业务路由（自动加载）                     │
│  │   ├── document-generator/ ←   文稿生成编排Agent                        │
│  │   └── section-writer/     ←   章节编写Agent                            │
│  ├── video-course/           ← 视频课程应用（多 Agent）                   │
│  │   ├── code/               ←   业务代码（系统自动加载）                 │
│  │   ├── video-course-director/                                         │
│  │   ├── video-script-creator/                                          │
│  │   ├── scene-builder/                                                 │
│  │   ├── remotion-code-generator/                                       │
│  │   ├── remotion-scene-coder/                                          │
│  │   └── video-code-editor/                                             │
│  └── sim-training/           ← 3D虚拟仿真训练（多 Agent）                 │
│      ├── code/               ←   业务代码（系统自动加载）                 │
│      ├── sim-training-director/                                         │
│      ├── sim-requirement-analyst/                                       │
│      ├── sim-scene-designer/                                            │
│      ├── sim-code-generator/                                            │
│      ├── sim-scene-coder/                                               │
│      └── sim-validator/                                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 系统分层

本系统采用**三层分离**架构，业务开发只需关注上层，不需修改底层基座代码：

```
┌────────────────────────────────────────────────────────────────┐
│  业务层 (你负责的部分)                                           │
│                                                                 │
│  apps/<your-app>/<agent>/       业务 Agent 定义（Markdown+YAML） │
│  apps/<your-app>/code/         业务代码模块（工具+处理器+路由）   │
│  src/utils/<your-utils>.ts     业务辅助工具                      │
│                                                                 │
│  职责: 定义 Agent 人设/灵魂/任务/工具策略，编写业务代码/路由     │
├────────────────────────────────────────────────────────────────┤
│  核心层 (基座，通常不需修改)                                     │
│                                                                 │
│  src/core/         Agent 运行时、图引擎、注册中心、子Agent管理    │
│  src/tools/        工具注册表、执行器、内置工具                    │
│  src/skills/       技能加载器、注册表、内置技能                    │
│  src/memory/       三层记忆系统                                   │
│  src/evolution/    自进化管线                                     │
│  src/llm/          LLM 供应商路由                                │
│                                                                 │
│  职责: 提供通用 Agent 编排能力，对业务层透明                      │
├────────────────────────────────────────────────────────────────┤
│  基础设施层                                                      │
│                                                                 │
│  Fastify HTTP/WS 服务器                                          │
│  多租户认证 (config/tenants.yaml)                                │
│  文件存储 / PostgreSQL                                           │
│  配置管理 (config/default.yaml + .env)                           │
└────────────────────────────────────────────────────────────────┘
```

**核心原则**: 业务层通过 `agentRuntime.invokeAgent()` / `agentRuntime.streamAgent()` 调用核心层，传入 Agent 名称和指令文本，核心层完全领域无关。

---

## 技术栈

| 分类 | 技术 |
|------|------|
| 语言 | TypeScript (ES2022, Node16 模块) |
| 运行时 | Node.js >= 20 |
| Web 框架 | Fastify 5 + CORS + WebSocket + Multipart |
| Agent 框架 | LangGraph.js (@langchain/langgraph) |
| LLM | @langchain/openai, @langchain/anthropic |
| 校验 | Zod |
| 配置 | YAML (config/default.yaml) + dotenv (.env) |
| 日志 | Winston |
| 并发 | p-queue |
| 文档解析 | mammoth (docx), unified/rehype (HTML AST) |
| 测试 | Vitest |

---

## 目录结构

```
x-pilot-agentic-server/
├── apps/                            # 智能体应用层（每应用一个文件夹）
│   ├── _shared/                     # 跨应用共享资源
│   ├── _template/                   # 新Agent模板（下划线开头不加载）
│   │   ├── IDENTITY.md              # 身份：名称、角色、能力
│   │   ├── SOUL.md                  # 灵魂：不可变核心价值观 + 可进化行为
│   │   ├── MISSION.md               # 任务：目标、成功标准、工作流
│   │   ├── TOOLS.md                 # 工具使用指南和策略
│   │   ├── BOOTSTRAP.md             # 首次初始化行为
│   │   ├── HEARTBEAT.md             # 定期维护行为
│   │   ├── agent.config.yaml        # 模型、并发、工具白名单、超时
│   │   ├── memory/MEMORY.md         # 持久化长期记忆
│   │   └── skills/*.md              # Agent专属可复用技能
│   ├── system/                      # 系统级应用
│   │   └── orchestrator/            #   内置编排Agent
│   ├── document-generation/         # 文稿生成应用
│   │   ├── code/                    #   业务路由（自动加载）
│   │   ├── document-generator/      #   文稿生成编排Agent
│   │   └── section-writer/          #   章节编写Agent（并行）
│   ├── video-course/                # 视频课程应用（多Agent编排）
│   │   ├── code/                    #   业务代码模块（系统自动加载）
│   │   ├── video-course-director/   #   导演Agent
│   │   ├── video-script-creator/    #   脚本创作Agent
│   │   ├── scene-builder/           #   场景构建Agent（并行）
│   │   ├── remotion-code-generator/ #   代码生成Agent + E2B部署
│   │   ├── remotion-scene-coder/    #   场景代码Agent（并行）
│   │   └── video-code-editor/       #   代码编辑Agent + E2B部署
│   └── sim-training/                # 3D虚拟仿真训练应用（多Agent编排）
│       ├── code/                    #   业务代码模块（系统自动加载）
│       ├── sim-training-director/   #   主编排Agent (Pipeline)
│       ├── sim-requirement-analyst/ #   需求分析Agent
│       ├── sim-scene-designer/      #   场景设计Agent
│       ├── sim-code-generator/      #   代码生成编排Agent
│       ├── sim-scene-coder/         #   单场景代码Agent（并行）
│       └── sim-validator/           #   构建验证与部署Agent
├── sim-training-template/           # 3D虚拟仿真训练前端模板 (Three.js + React)
│   ├── src/engine/                  #   仿真核心引擎 (步骤管理/交互/评分)
│   ├── src/components/              #   UI 覆盖层与 3D 场景组件
│   ├── src/hooks/                   #   业务状态 Hooks (useStep, etc.)
│   └── src/scenes/                  #   AI 生成的 3D 场景代码目录
├── config/
│   ├── default.yaml                 # 全局运行时配置
│   └── tenants.yaml                 # 多租户API Key映射
├── src/
│   ├── index.ts                     # 应用入口
│   ├── api/
│   │   ├── server.ts                # Fastify服务器/路由注册
│   │   ├── middleware/auth.ts       # API Key认证/租户解析
│   │   ├── route-registry.ts         # 业务路由注册表（apps/ 自动加载）
│   │   └── routes/
│   │       ├── agent.routes.ts      # 通用Agent CRUD & 调用API
│   │       ├── task.routes.ts       # 异步任务管理API
│   │       ├── health.routes.ts     # 健康检查
│   │       └── business.routes.ts   # 业务API（教学资源生成等）
│   ├── core/
│   │   ├── types.ts                 # 所有共享TypeScript接口
│   │   ├── agent-loader.ts          # 从磁盘加载Agent定义
│   │   ├── agent-registry.ts        # Agent/工具/技能注册中心
│   │   ├── agent-graph.ts           # LangGraph图构建(perceive→think→act→observe→reflect)
│   │   ├── agent-runtime.ts         # invoke/stream/invokeAsync入口
│   │   ├── pipeline-executor.ts     # 声明式Pipeline引擎（多Agent编排）
│   │   ├── output-parser.ts         # Agent输出解析（JSON/Code提取+校验）
│   │   ├── sub-agent-manager.ts     # 子Agent派生、重试和结果聚合
│   │   ├── task-executor.ts         # p-queue异步任务队列
│   │   ├── workspace.ts             # 会话级产物存储
│   │   └── event-bus.ts             # 事件分发（SSE推送用）
│   ├── evolution/
│   │   ├── reflector.ts             # 任务后反思
│   │   ├── skill-crystallizer.ts    # 工具模式→技能结晶
│   │   ├── evolver.ts               # 进化提案生成
│   │   ├── proposal-applier.ts      # 提案应用（修改Agent文件）
│   │   └── heartbeat.ts             # 定期维护Runner
│   ├── llm/
│   │   ├── provider.ts              # LLM供应商工厂（OpenAI/Anthropic/Zhipu）
│   │   └── model-router.ts          # 模型选择和实例缓存
│   ├── memory/
│   │   ├── memory-manager.ts        # 统一记忆操作入口
│   │   ├── short-term.ts            # 工作记忆（图运行期间）
│   │   ├── long-term.ts             # 持久化长期记忆
│   │   ├── memory-consolidator.ts   # 每日日志→长期记忆合并
│   │   └── stores/
│   │       ├── file-store.ts        # 文件存储实现
│   │       └── pg-store.ts          # PostgreSQL存储(占位)
│   ├── skills/
│   │   ├── skill-loader.ts          # 加载.md技能并注入系统提示词
│   │   ├── skill-registry.ts        # 技能注册表
│   │   └── built-in/                # 内置技能(self-reflect, self-evolve, memory-search)
│   ├── tools/
│   │   ├── tool-registry.ts         # 工具注册表
│   │   ├── tool-executor.ts         # 工具执行器（带超时）
│   │   └── built-in/                # 内置工具
│   │       ├── code-executor.ts     # 执行TypeScript/Python
│   │       ├── http-request.ts      # HTTP请求
│   │       ├── file-ops.ts          # 文件读写
│   │       ├── shell.ts             # Shell命令
│   │       ├── sub-agent.ts         # 派生子Agent
│   │       ├── spawn-parallel.ts    # 并行派生多个Agent
│   │       ├── create-agent.ts      # 运行时创建新Agent
│   │       ├── knowledge-search.ts  # 知识库/混合检索
│   │       ├── image-generate.ts    # 图片生成
│   │       ├── workspace.ts         # 会话工作区读写
│   │       └── event-emit.ts        # 事件发射
│   └── utils/
│       ├── config.ts                # YAML+环境变量加载
│       ├── logger.ts                # Winston日志
│       ├── md-parser.ts             # Markdown解析
│       └── template-parser.ts       # DOCX解析/骨架提取
└── tests/
    ├── core/                        # 核心模块单元测试
    └── memory/                      # 记忆模块测试
```

---

## 核心概念

### Agent 定义

每个 Agent 是 `apps/<app-name>/` 下的一个独立文件夹。系统启动时自动递归扫描加载（以 `_` 开头的文件夹除外，通过 `agent.config.yaml` 识别 Agent 文件夹）。

一个 Agent 文件夹的完整结构：

```
apps/<app-name>/my-agent/
├── IDENTITY.md           # 必需 — 名称、角色、能力描述
├── SOUL.md               # 必需 — CORE(不可变价值观) + MUTABLE(可进化行为)
├── MISSION.md            # 必需 — 目标、成功标准、工作流
├── TOOLS.md              # 推荐 — 工具使用策略
├── BOOTSTRAP.md          # 可选 — 首次初始化行为
├── HEARTBEAT.md          # 可选 — 定期维护行为
├── agent.config.yaml     # 必需 — 模型、并发、maxTokens、工具白名单等
├── memory/
│   └── MEMORY.md         # 自动生成 — 长期记忆存储
└── skills/
    └── *.md              # 可选 — Agent专属技能文档
```

**关键：所有 `.md` 文件都会被拼接为 LLM 的系统提示词。** 拼接顺序：

```
Identity → Soul → Mission → Tools → (其他.md) → Skills → TaskContext → Session → LongTermMemory
```

**`agent.config.yaml` 字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | string | 主模型（如 `gpt-4o`） |
| `workerModel` | string | 轻量工作模型（反思/技能结晶等用，如 `gpt-4o-mini`） |
| `maxConcurrency` | number | 并发子任务数上限 |
| `maxTokens` | number | LLM 单次最大生成 Token 数（可选） |
| `allowedTools` | string[] | 允许的工具列表，`["*"]` 表示全部 |
| `heartbeat.enabled` | boolean | 是否开启定期心跳 |
| `heartbeat.intervalMs` | number | 心跳间隔（毫秒） |
| `evolution.enabled` | boolean | 是否开启自进化 |
| `evolution.requireApproval` | boolean | 进化提案是否需要人工审批 |
| `timeout` | number | 单次调用超时（毫秒） |
| `metadata` | object | 自定义元数据（如 `domain`, `outputFormat`） |
| `outputFormat.type` | `"text"` / `"json"` / `"code"` | 输出格式声明（系统自动提取） |
| `outputFormat.schema` | object | JSON Schema（可选，用于校验 JSON 输出） |
| `outputFormat.codeLanguage` | string | 代码语言（`type=code` 时使用） |
| `retry.maxAttempts` | number | 作为子 Agent 被调用时的最大重试次数 |
| `retry.backoffMs` | number | 重试退避间隔基数 |
| `pipeline` | PipelineConfig | 声明式多 Agent 编排配置 |

---

### LangGraph 执行流

每次调用 Agent 时，系统构建一个 LangGraph 状态图来执行：

```
                    ┌─────────────────────────────────────────┐
                    │           LangGraph 状态图                │
                    │                                          │
  用户输入 ─────▶   │  START                                   │
                    │    │                                     │
                    │    ▼                                     │
                    │  perceive  ─── 更新工作记忆，处理输入      │
                    │    │                                     │
                    │    ▼                                     │
              ┌───▶ │  think    ─── LLM推理（带工具绑定）       │
              │     │    │                                     │
              │     │    ├── 有tool_calls ──▶  act             │
              │     │    │                      │              │
              │     │    │                      ▼              │
              │     │    │                   observe            │
              │     │    │                      │              │
              │     │    │     ┌── 继续 ────────┘              │
              │     │    │     │                               │
              └─────┼────┼─────┘                               │
                    │    │                                     │
                    │    └── 无tool_calls ──▶  reflect          │
                    │                            │             │
                    │                            ▼             │
  最终输出 ◀─────   │                          END             │
                    └─────────────────────────────────────────┘

  各节点职责:
  ┌───────────┬────────────────────────────────────────────────────┐
  │ perceive  │ 解析输入，更新工作记忆                                │
  │ think     │ 发送 SystemPrompt + Messages 给 LLM，获取推理结果     │
  │ act       │ 并行执行所有 tool_calls（带重试机制）                  │
  │ observe   │ 记录工具结果，检查迭代次数和连续失败                    │
  │ reflect   │ 用独立 LLM 调用做结构化反思，提取 lessons              │
  └───────────┴────────────────────────────────────────────────────┘
```

**AgentGraphState 关键字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `messages` | BaseMessage[] | 完整对话历史 |
| `workingMemory` | WorkingMemory | 工作记忆（facts, context, shortTermLog） |
| `longTermMemory` | string | 持久化记忆文本 |
| `systemPrompt` | string | 组装后的系统提示词 |
| `toolCalls` | ToolCallRecord[] | 所有工具调用记录 |
| `subAgentResults` | SubAgentResult[] | 子Agent执行结果 |
| `reflections` | Reflection[] | 反思结果 |
| `iteration` | number | 当前迭代次数 |
| `maxIterations` | number | 最大迭代次数（默认20） |
| `done` | boolean | 是否完成 |

---

### 声明式 Pipeline（多 Agent 编排）

当一个 Agent 配置了 `pipeline` 字段，系统**不走 LangGraph 图执行**，而是使用 Pipeline 引擎按声明式拓扑编排多个子 Agent：

```
                    Pipeline 执行引擎
                    ==================

  用户输入 ─────▶ 拓扑排序 pipeline.steps
                      │
                      ▼
              ┌── Batch 1（无依赖）──────────────┐
              │                                   │
              │  research (video-researcher)       │
              │  search   (asset-searcher)         │
              │        [并行执行]                  │
              └───────────┬───────────────────────┘
                          │ results
                          ▼
              ┌── Batch 2（dependsOn: research, search）──┐
              │                                            │
              │  script (video-scriptwriter)                │
              │        [等待前置完成后执行]                  │
              └───────────┬────────────────────────────────┘
                          │ results.script.scenes → fan-out
                          ▼
              ┌── Batch 3（fan-out 并行）──────────────────┐
              │                                             │
              │  scenes[0] (remotion-scene-coder)           │
              │  scenes[1] (remotion-scene-coder)           │
              │  scenes[N] (remotion-scene-coder)           │
              │        [对数组每个元素并行调用同一 Agent]     │
              └───────────┬─────────────────────────────────┘
                          │ results
                          ▼
              ┌── Batch 4 ─────────────────────────────────┐
              │                                             │
              │  assemble (video-assembler)                 │
              └───────────┬─────────────────────────────────┘
                          │
                          ▼
                    最终输出（最后一个步骤的结果）
```

**Pipeline 配置示例** (`agent.config.yaml`)：

```yaml
pipeline:
  steps:
    - name: research
      agent: video-researcher
    - name: search
      agent: asset-searcher
    - name: script
      agent: video-scriptwriter
      dependsOn: [research, search]
    - name: scenes
      agent: remotion-scene-coder
      dependsOn: [script]
      parallel: true
      fanOutFrom: script.scenes
      optional: true
    - name: assemble
      agent: video-assembler
      dependsOn: [scenes]
```

**Pipeline 步骤字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 步骤名（唯一） |
| `agent` | string | 要调用的 Agent 名称 |
| `dependsOn` | string[] | 依赖的前置步骤名 |
| `parallel` | boolean | 是否对输入数组并行展开 |
| `fanOutFrom` | string | 从哪个步骤输出展开（如 `script.scenes`） |
| `inputMapping` | object | 字段映射 |
| `optional` | boolean | 失败是否可跳过 |

---

### Agent IO 契约（结构化输出）

通过 `agent.config.yaml` 的 `outputFormat` 声明 Agent 输出格式，系统自动从 LLM 原始输出中提取结构化结果：

```yaml
outputFormat:
  type: json              # text | json | code
  schema:                 # 可选 JSON Schema
    type: object
    required: [scenes]
    properties:
      scenes: { type: array }
  codeLanguage: typescript # type=code 时指定语言
```

- `type: json` → 系统自动提取 JSON（支持 ` ```json ``` ` 包裹、裸 JSON、嵌套在文本中的 JSON）
- `type: code` → 系统提取指定语言的代码块
- `type: text` → 原样返回（默认）

子 Agent 返回时也会自动应用目标 Agent 的 `outputFormat`，确保上下游数据格式兼容。

---

### 子 Agent 重试机制

通过 `retry` 配置声明该 Agent 作为子 Agent 被调用时的重试策略：

```yaml
retry:
  maxAttempts: 3        # 最多尝试次数
  backoffMs: 2000       # 退避间隔基数（实际等待 = backoffMs * attempt）
```

配合 `pipeline.steps[].optional: true`，可实现"重试后仍失败则跳过"的降级策略。

---

### 工具系统

工具通过 `ToolRegistry` 集中管理，每个工具是一个 LangChain `StructuredToolInterface` 实例（基于 Zod schema）。

**内置工具一览：**

| 工具名 | 类别 | 说明 |
|--------|------|------|
| `code_executor` | 静态 | 执行 TypeScript/Python 代码 |
| `http_request` | 静态 | HTTP 请求 |
| `file_read` / `file_write` / `file_list` | 静态 | 文件操作 |
| `shell` | 静态 | Shell 命令 |
| `knowledge_search` | 静态 | 知识库混合检索 (Dify + RRF + Rerank) |
| `knowledge_list` | 静态 | 列出所有可用的知识库 (Dify Datasets) |
| `knowledge_doc_retrieve` | 静态 | 从知识库中获取完整文档内容 |
| `web_search` | 静态 | 网页搜索 (SearchApi.io)，支持内容提取 |
| `image_generate` | 静态 | AI 图片生成 |
| `create_agent` | 静态 | 运行时创建新 Agent（支持 `group` 参数归入应用分组） |
| `spawn_sub_agent` | 动态 | 派生子 Agent（按 threadId 注入） |
| `spawn_parallel_agents` | 动态 | 并行派生多个子 Agent |
| `workspace_write` / `workspace_read` / `workspace_list` | 动态 | 会话工作区产物管理 |
| `emit_event` | 动态 | 向会话订阅者发送事件 |
| `e2b_project_status` | 业务 | 获取 E2B 项目状态与预览数据 |
| `e2b_preflight` | 业务 | E2B 运行时环境检查（检测代码错误） |
| `e2b_manage_assets` | 业务 | E2B 项目素材管理（上传/获取/删除/列表） |
| `e2b_render` | 业务 | E2B 视频渲染（启动/轮询/队列排队） |
| `e2b_share` | 业务 | 获取 E2B 分享链接与项目概览 |
| `e2b_sandbox_exec` | 业务 | 在 E2B 沙盒中执行任意命令 |
| `asset_search` | 业务 | 搜索 3D 素材库（支持分类与关键字匹配） |
| `asset_metadata` | 业务 | 获取 3D 素材的详细元数据（包含模型/动画/材质） |
| `sim_project_init` | 业务 | 从模板初始化 3D 虚拟仿真项目 |
| `sim_inject_scene` | 业务 | 将 AI 生成的场景代码注入到仿真项目 |
| `sim_build` | 业务 | 构建仿真项目（npm run build） |
| `sim_deploy` | 业务 | 部署已构建的仿真项目到静态托管目录 |
| `sim_preview` | 业务 | 获取已部署仿真的预览地址与清单 |

**工具选择流程：** Agent 的 `allowedTools` 配置 → `ToolRegistry.getByNames()` 过滤 → 动态工具注入 → 绑定到 LLM。

---

### 技能系统

技能是 Markdown 文档，描述 Agent 的可复用行为模式。加载后拼接到系统提示词末尾。

来源：
1. `apps/<app-name>/<agent-name>/skills/*.md` — Agent 专属技能
2. `src/skills/built-in/` — 全局内置技能（self-reflect, self-evolve, memory-search）
3. 自进化结晶 — 系统自动从重复工具模式中提取的新技能

---

### 记忆系统

三层记忆结构：

```
┌──────────────────────────────┐
│  工作记忆 (Working Memory)    │ ←── 单次图执行期间，随状态流转
│  facts[] + context + log[]   │
├──────────────────────────────┤
│  每日日志 (Daily Log)         │ ←── 每次任务完成后追加
│  data/.../YYYY-MM-DD.md      │
├──────────────────────────────┤
│  长期记忆 (Long-term)         │ ←── 经验教训、合并后的知识
│  data/.../MEMORY.md           │     加载到系统提示词中
└──────────────────────────────┘

合并流: 每日日志 ──(MemoryConsolidator)──▶ 长期记忆
```

存储路径：`data/tenants/{tenantId}/agents/{agentName}/memory/`

---

### 自进化系统

```
任务完成
   │
   ▼
Reflector (反思)  ──▶  提取 lessons (confidence ≥ 0.6 写入长期记忆)
   │
   ▼
SkillCrystallizer ──▶  重复工具模式 (≥3次) → 新技能 .md
   │
   ▼
HeartbeatRunner   ──▶  定期触发合并和进化
   │
   ▼
Evolver           ──▶  生成进化提案 (soul_update / new_skill / config_change / workflow_adjustment)
   │
   ▼
人工审批 / 自动通过 ──▶  ProposalApplier 修改 Agent 文件
```

---

### 多租户与认证

- **租户配置**：`config/tenants.yaml` 定义租户列表和 API Key
- **认证方式**：`Authorization: Bearer <apiKey>` 或 `?apiKey=...`
- **数据隔离**：`data/tenants/{tenantId}/` 下按租户隔离记忆和工作区
- **开发模式**：未配置租户或无 Key 时自动使用 `default` 租户

---

## 业务层智能体开发指南

### 新建业务智能体的完整步骤

开发一个新的业务层智能体需要完成以下三步：

```
步骤 1: 创建 Agent 定义文件夹（在对应应用目录下）
  └── apps/your-app-name/your-agent-name/
       ├── IDENTITY.md
       ├── SOUL.md
       ├── MISSION.md
       ├── TOOLS.md
       ├── agent.config.yaml
       └── memory/MEMORY.md

步骤 2: 编写业务代码（可选）
  └── apps/my-app/code/
       ├── index.ts    # register() — 注册工具/处理器/路由
       ├── routes.ts   # 业务 API 路由
       └── tools.ts    # 业务工具

步骤 3: 在 server.ts 中注册路由（如果是新文件）
  └── src/api/server.ts
```

---

### Agent 文件夹规范

#### 1. IDENTITY.md — 身份定义

```markdown
---
name: Your Agent Name
version: "1.0"
---

# Identity

你是 **Your Agent Name**，用于 [业务场景] 的智能体。

## Name
Your Agent Name

## Role
[用一段话描述核心职责]

## Core Capabilities
- [能力1]
- [能力2]
- [能力3]
```

#### 2. SOUL.md — 灵魂定义

```markdown
---
version: "1.0"
---

# Soul

## CORE (Immutable)

### Values
- [核心价值观1]：[说明]
- [核心价值观2]：[说明]

### Constraints
- [硬约束1]
- [硬约束2]

## MUTABLE (Evolvable)

### Decision Heuristics
- [可进化的决策偏好1]
- [可进化的决策偏好2]
```

#### 3. MISSION.md — 任务定义

```markdown
---
version: "1.0"
---

# Mission

## Primary Objective
[核心目标描述]

## Success Criteria
- [标准1]
- [标准2]

## Workflow
### Phase 1 — [阶段名]
[步骤描述]

### Phase 2 — [阶段名]
[步骤描述]
```

#### 4. TOOLS.md — 工具策略

```markdown
---
version: "1.0"
---

# Tool Usage Guidelines

## Preferred Tools

### [tool_name]（优先级说明）
[使用场景和最佳实践]

## Tool Strategy
[工具选择的决策流程]
```

#### 5. agent.config.yaml — 配置

```yaml
model: gpt-4o                    # 主模型
workerModel: gpt-4o-mini         # 辅助模型
maxConcurrency: 8                # 并发上限
allowedTools:                    # 工具白名单（按需选择）
  - knowledge_search
  - http_request
  - file_read
  - file_write
  - spawn_sub_agent
  - spawn_parallel_agents
  - workspace_write
  - workspace_read
  - workspace_list
heartbeat:
  enabled: true
  intervalMs: 1800000            # 30分钟
evolution:
  enabled: true
  requireApproval: true          # 进化提案需审批
timeout: 600000                  # 10分钟超时
metadata:
  domain: your-domain            # 业务域标识
  outputFormat: markdown         # 输出格式
```

**`allowedTools` 选择指南：**

| 场景 | 推荐工具集 |
|------|-----------|
| 纯文本生成 | `knowledge_search`, `http_request` |
| 图文生成 | 上述 + `image_generate` |
| 需要并行 | 上述 + `spawn_sub_agent`, `spawn_parallel_agents` |
| 需要会话状态 | 上述 + `workspace_write/read/list` |
| 需要代码执行 | 上述 + `code_executor` |
| 全能Agent | `["*"]` |

---

### 业务路由开发规范

业务路由负责：
1. **接收前端请求** → 校验参数
2. **构建指令文本** → 将业务参数转为 Agent 可理解的自然语言指令
3. **调用 AgentRuntime** → `invokeAgent()` 或 `streamAgent()`
4. **格式化返回** → 从 Agent 输出中提取业务需要的结果

**模式代码（同步调用）：**

```typescript
import type { FastifyInstance } from "fastify";
import { getTenantId } from "../middleware/auth.js";

const YOUR_AGENT = "your-agent-name";  // 与 apps/ 下的 Agent 文件夹名一致

export function registerYourBusinessRoutes(app: FastifyInstance): void {

  app.post("/api/business/your-domain/action", async (request, reply) => {
    const tenantId = getTenantId(request);
    const body = request.body as YourRequestType;

    // 1. 参数校验
    if (!body.requiredField) {
      return reply.code(400).send({ error: "requiredField is required" });
    }

    // 2. 动态导入核心模块（避免循环依赖）
    const [{ agentRegistry }, { agentRuntime }] = await Promise.all([
      import("../../core/agent-registry.js"),
      import("../../core/agent-runtime.js"),
    ]);

    if (!agentRegistry.has(YOUR_AGENT)) {
      return reply.code(503).send({ error: `Agent not found: ${YOUR_AGENT}` });
    }

    // 3. 构建指令（核心！将结构化参数转为自然语言）
    const instruction = buildInstruction(body);

    // 4. 调用 Agent
    const result = await agentRuntime.invokeAgent(YOUR_AGENT, instruction, {
      tenantId,
      sessionId: body.sessionId,
      context: { businessType: "your-type", /* 更多上下文 */ },
    });

    // 5. 格式化返回
    const parsed = result as { output?: string; threadId?: string };
    return { output: parsed.output, threadId: parsed.threadId };
  });
}
```

**模式代码（SSE 流式）：**

```typescript
app.post("/api/business/your-domain/action-stream", async (request, reply) => {
  // ... 同上的校验和构建 ...

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const stream = agentRuntime.streamAgent(YOUR_AGENT, instruction, {
    tenantId,
    sessionId: body.sessionId,
  });

  for await (const event of stream) {
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  reply.raw.end();
});
```

---

### 构建多 Agent 协作应用

以"Remotion 视频课生成"为例，展示如何构建一个多 Agent 协作应用：

**第一步：规划 Agent 拓扑**（在同一应用文件夹下组织）

```
apps/video-course/
├── video-course-director/       # 导演Agent（配置pipeline，自身不做具体业务）
├── video-script-creator/        # 脚本创作Agent（生成脚本大纲与场景列表）
├── scene-builder/               # 场景构建Agent（并行：丰富单个场景的视觉设定与规范）
├── remotion-code-generator/     # 代码生成Agent（生成核心文件，推送到E2B进行预检）
├── remotion-scene-coder/        # 场景代码Agent（并行：生成单个Remotion场景代码）
└── video-code-editor/           # 代码编辑Agent（根据E2B预检报错进行修改，并渲染视频）
```

**第二步：导演 Agent 配置 pipeline**

```yaml
# apps/video-course/video-course-director/agent.config.yaml
model: gpt-4o
allowedTools: []                 # 导演不需要工具，pipeline引擎编排子Agent
pipeline:
  steps:
    - name: script
      agent: video-script-creator
    - name: scenes
      agent: scene-builder
      dependsOn: [script]
      parallel: true
      fanOutFrom: script.scenes
      optional: true
    - name: initCode
      agent: remotion-code-generator
      dependsOn: [scenes]
    - name: codeScenes
      agent: remotion-scene-coder
      dependsOn: [initCode]
      parallel: true
      fanOutFrom: script.scenes
      optional: true
    - name: finalEdit
      agent: video-code-editor
      dependsOn: [codeScenes]
metadata:
  domain: video-course
```

**第三步：子 Agent 声明 IO 契约**

```yaml
# apps/video-course/video-script-creator/agent.config.yaml
model: gpt-4o
allowedTools: [knowledge_search, web_search, http_request]
outputFormat:
  type: json
  schema:
    type: object
    required: [scenes, metadata]
    properties:
      scenes: { type: array }
      metadata: { type: object }
retry:
  maxAttempts: 2
  backoffMs: 3000
metadata:
  domain: video-course
```

```yaml
# apps/video-course/remotion-scene-coder/agent.config.yaml
model: gpt-4o
allowedTools: [code_executor, knowledge_search]
outputFormat:
  type: code
  codeLanguage: typescript
retry:
  maxAttempts: 2
  backoffMs: 2000
metadata:
  domain: video-course
```

**第四步：编写业务路由**

```typescript
const DIRECTOR_AGENT = "video-course-director";

app.post("/api/business/video-course/generate", async (request, reply) => {
  const tenantId = getTenantId(request);
  const { topic, duration, style } = request.body;

  const instruction = `生成关于「${topic}」的${duration}秒视频课程，风格：${style}`;

  const result = await agentRuntime.invokeAgent(DIRECTOR_AGENT, instruction, {
    tenantId,
    sessionId: request.body.sessionId,
    context: { businessType: "video-course", topic, duration, style },
  });

  return result;  // 包含 pipeline 各步骤结果
});
```

---

### 现有示例：教学资源生成器

这是一个完整的业务层 Agent 实现，可作为新业务开发的参考蓝本：

**Agent 定义**: `apps/document-generation/`

- IDENTITY.md — 中文身份描述，明确"教学资源生成"角色
- SOUL.md — CORE 包含"骨架忠实""模板忠实""教学有效"等领域价值观
- MISSION.md — 工作流：骨架解读→知识获取→基于 section-writer 并行分发→组装检查
- TOOLS.md — 按优先级排列工具策略：knowledge_search > web_search > http_request
- agent.config.yaml — 声明使用 pipeline 和 parallel fan-out，元数据标记 `domain: document-generation`

**业务路由**: `src/api/routes/business.routes.ts`

- `POST /api/business/document-generation/upload-template` — 上传 docx，解析为 HTML + 骨架
- `POST /api/business/document-generation/generate` — 同步生成教学文稿
- `POST /api/business/document-generation/generate-stream` — SSE 流式生成

**辅助工具**: `src/utils/template-parser.ts`

- DOCX → HTML 转换（mammoth）
- HTML → HAST → 模板骨架提取
- 骨架序列化为 LLM 可读文本

---

## API 参考

### 通用 Agent API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查（公开） |
| `GET` | `/api/agents` | 列出所有 Agent |
| `GET` | `/api/agents/:name` | 获取 Agent 详情 |
| `POST` | `/api/agents/:name/invoke` | 同步调用 Agent |
| `POST` | `/api/agents/:name/invoke-async` | 异步调用（返回 taskId） |
| `POST` | `/api/agents/:name/stream` | SSE 流式调用 |
| `POST` | `/api/agents` | 运行时创建新 Agent |
| `POST` | `/api/agents/:name/reload` | 从磁盘重新加载 Agent |
| `GET` | `/api/agents/:name/memory` | 查询 Agent 记忆 |
| `POST` | `/api/agents/:name/memory` | 写入记忆 |
| `GET` | `/api/agents/:name/evolution` | 查看待审批进化提案 |
| `POST` | `/api/agents/:name/evolution/:id/approve` | 批准提案 |
| `POST` | `/api/agents/:name/evolution/:id/reject` | 拒绝提案 |
| `WS` | `/ws/agents/:name` | WebSocket 双向流式 |

### 任务 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/tasks/:id` | 获取任务状态 |
| `GET` | `/api/tasks` | 任务列表（可按 agent/parent 过滤） |
| `DELETE` | `/api/tasks/:id` | 取消任务 |

### 业务领域 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/business/document-generation/upload-template` | 上传并解析 Word 模板 (.docx) |
| `POST` | `/api/business/document-generation/generate` | 生成教学文稿（阻塞） |
| `POST` | `/api/business/document-generation/generate-stream` | 生成教学文稿（SSE 流式） |
| `POST` | `/api/business/video-course/generate` | 生成视频课程（阻塞） |
| `POST` | `/api/business/video-course/generate-stream` | 生成视频课程（SSE 流式） |
| `POST` | `/api/business/video-course/edit` | 编辑已有视频课程 |
| `POST` | `/api/business/sim-training/create` | 创建 3D 虚拟仿真训练（阻塞） |
| `POST` | `/api/business/sim-training/create-stream` | 创建 3D 虚拟仿真训练（SSE 流式） |
| `GET` | `/api/business/sim-training/list` | 列表已部署的仿真训练 |
| `GET` | `/api/business/sim-training/:id` | 获取仿真详情 |
| `DELETE` | `/api/business/sim-training/:id` | 删除仿真 |
| `POST` | `/api/business/sim-training/rebuild` | 重新构建仿真 |

### 会话与产物 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/sessions/:sessionId/events` | SSE 订阅会话事件流 |
| `GET` | `/api/sessions/:sessionId/artifacts` | 列出会话产物 |
| `GET` | `/api/sessions/:sessionId/artifacts/*` | 下载产物文件（流式） |

### 图床（全局图片库）API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/images/upload` | multipart 上传入库 |
| `GET` | `/api/images` | 条件列表（分页/过滤） |
| `GET` | `/api/images/:id` | 图片元数据 |
| `GET` | `/api/images/:id/file` | 图片二进制流 |
| `PATCH` | `/api/images/:id` | 更新元数据 |
| `DELETE` | `/api/images/:id` | 删除记录与文件 |
| `POST` | `/api/images/from-url` | 从 URL 拉取并入库 |
| `POST` | `/api/images/resolve` | 按章节标题/关键词匹配图片 |

**详细说明（请求体、响应、认证、Resolve 算法）**：见 [docs/图床服务器.md](docs/图床服务器.md)。

### SSE 事件流协议 (v2)

所有的流式接口（`/stream`）均使用统一的 SSE 事件协议。每个事件的数据结构如下：

```json
{"event":"<type>","id":1,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000000.0,"data":{...}}
```

**事件类型 (Event types)**: `task_started` / `task_finished` / `done` / `ping` / `node_started` / `node_finished` / `message` / `message_end` / `tool_started` / `tool_finished` / `agent_started` / `agent_message` / `agent_tool_started` / `agent_tool_finished` / `agent_finished` / `thinking` / `progress` / `error`

**三层 ID 体系**:
- `task_id` — 单次请求的生命周期 ID（每个事件都包含）
- `session_id` — 业务会话 / 工作区 ID（每个事件都包含）
- `thread_id` — 多轮对话的上下文 ID（仅在 `task_started.data` 中提供）

响应头包含: `X-Stream-Protocol: 2.0`, `X-Task-Id`, `X-Session-Id`

详见 `src/core/types.ts` 中的 TypeScript 定义，工厂函数见 `src/core/stream-protocol.ts`，统一写入器见 `src/core/sse-writer.ts`。

### 调用请求体格式

```json
{
  "input": "你的指令文本",
  "threadId": "可选 — 续接对话",
  "sessionId": "可选 — 会话级工作区",
  "context": { "key": "value" },
  "metadata": {}
}
```

---

## 快速上手

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY 等

# 3. 开发模式启动
npm run dev

# 4. 构建并运行
npm run build && npm start

# 5. 测试
npm test
```

---

## 配置说明

### config/default.yaml

```yaml
server:
  port: 3000
  host: 0.0.0.0

agents:
  baseDir: ./apps             # 智能体应用层根目录
  defaults:
    model: gpt-4o
    maxConcurrency: 5
    heartbeat:
      enabled: true
      intervalMs: 3600000
    evolution:
      enabled: true
      requireApproval: true
    timeout: 300000

memory:
  store: file                  # file | postgres
  consolidation:
    enabled: true
    intervalMs: 86400000       # 每日合并

llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
    zhipu:
      apiKey: ${ZHIPU_API_KEY}
```

### .env

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
ZHIPU_API_KEY=...
PORT=3000
MEMORY_STORE=file
LOG_LEVEL=info
```

### 知识库检索配置

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `DIFY_API_BASE_URL` | Dify API 服务端点 | `http://119.45.167.133:5125/v1` |
| `DIFY_DATASET_API_KEY` | Dify 知识库数据集 API Key | — |
| `SILICONFLOW_API_KEY` | 硅基流动 API Key (用于 Rerank 模型) | — |
| `RERANK_ENABLED` | 是否启用外部重排序 (Rerank) | `true` |
| `RERANK_MODEL` | 重排序模型名称 | `BAAI/bge-reranker-v2-m3` |
| `KNOWLEDGE_DEFAULT_SEARCH_METHOD` | 默认搜索策略 | `hybrid_search` |
| `KNOWLEDGE_DEFAULT_TOP_K` | 默认返回结果数量 | `10` |
| `KNOWLEDGE_SCORE_THRESHOLD` | 最低相关性得分阈值 | `0` |
| `KNOWLEDGE_MAX_TOKENS` | 知识结果的 Token 上限 | `8000` |
| `KNOWLEDGE_ALLOW_UNSCOPED_SEARCH` | 是否允许未指定 `datasetIds` / `datasetNames` 时检索 | `false` |
| `KNOWLEDGE_MAX_DATASETS` | 显式启用无范围检索时最多检索的数据集数量 | `20` |
| `KNOWLEDGE_RETRIEVE_CONCURRENCY` | Dify retrieve 并发请求数 | `6` |
| `KNOWLEDGE_DIFY_TOP_K_MAX` | Dify `retrieval_model.top_k` 上限 | `50` |
| `KNOWLEDGE_FALLBACK_SEARCH_METHOD` | Embedding 检索被拒绝时的降级策略 | `keyword_search` |
| `KNOWLEDGE_TIMEOUT` | Dify 请求超时时间（毫秒） | `45000` |

`DIFY_DATASET_API_KEY` 是本服务访问 Dify Knowledge API 的凭证。Dify 内部调用 embedding 模型所需的供应商 Key 在 Dify 后台配置；如果日志出现 `https://api.siliconflow.cn/v1/embeddings` 403，应检查 Dify 的模型供应商配置。这里的 `SILICONFLOW_API_KEY` 只用于本服务可选的外部重排序接口（`/v1/rerank`）。

### config/tenants.yaml

```yaml
tenants:
  - id: tenant-a
    name: "学校A"
    apiKey: "key-xxx-a"
  - id: tenant-b
    name: "学校B"
    apiKey: "key-xxx-b"
```
