# Document Generation 智能体详解

本文档详解 `document-generation` 智能体的调用流程、使用逻辑与数据流向。

---

## 一、整体架构

```
HTTP 请求 → document-generation/code/routes.ts → 校验/归一化 → buildInstruction
         → agentRuntime.invokeAgent/streamAgent
         → LangGraph (Think→Act→Observe 循环) 
         → 并行调度 section-writer 子 Agent
         → 最终组装 (assembleDocument handler) → 输出
```

---

## 二、入口与 API

| 接口 | 方式 | 说明 |
|------|------|------|
| `POST /api/business/document-generation/generate` | 同步 | 阻塞到生成完成，返回最终 Markdown |
| `POST /api/business/document-generation/generate-stream` | SSE 流式 | 实时输出 token / tool_result / done |
| `POST /api/business/document-generation/upload-template` | 文件上传 | 上传 .docx，解析为 HTML + 骨架 |

**必填参数**：`topic` 或 `select_knowledge_unit`，其余均为可选。

---

## 三、调用流程（从请求到输出）

### 3.1 请求层（`apps/document-generation/code/routes.ts`）

```
1. validateGenerateBody(body)
   └─ normalizeRequest()：topic 必填，其他可选
   └─ 兼容 select_knowledge_unit / topic、docTemplate / template 等字段

2. resolveTemplateContent(norm.template)
   └─ html → extractSkeleton() 解析 AST
   └─ markdown → extractSkeletonFromMarkdown()
   └─ 空模板 → 用 { plainText: "" } 得到最小骨架

3. trimForPrompt(rawContent)
   └─ 超过 50_000 字符则截断并标注

4. buildInstruction(norm, skeleton, excerpt, truncated, format)
   └─ 组装系统指令，包含：
      - 核心规则（结构、主题、表格、图片策略）
      - payload（JSON 形式的 select_knowledge_unit、prompt、database_id 等）
      - 模板骨架（skeletonText）
      - 模板原文（可选）
```

### 3.2 运行时层（`agent-runtime.ts`）

```
5. agentRuntime.invokeAgent(RESOURCE_AGENT, instruction, options)
   或 agentRuntime.streamAgent(...)

6. buildGraph(agentDef, threadId, tenantId, userId, sessionId, context)
   └─ getToolsForAgent()：根据 agent.config.allowedTools 组装工具
      - smart_search=false 时排除 web_search
      - sessionId 存在时注入 workspace_write/read/list、emit_event
   └─ buildAgentGraph()：创建 LangGraph
```

### 3.3 LangGraph 执行流程（`agent-graph.ts`）

```
START → perceive → think
                         ├─ 有 tool_calls → act → observe → think（循环，最多 20 轮）
                         └─ 无 tool_calls → reflect → END
```

| 节点 | 作用 |
|------|------|
| **perceive** | 初始化 workingMemory，记录输入 |
| **think** | 调用 LLM，结合 systemPrompt、messages、workingMemory 决策是否用工具 |
| **act** | 并发执行 think 中的 tool_calls，写回 ToolMessage 和 toolCalls |
| **observe** | 更新 workingMemory，决定继续 think 还是 reflect |
| **reflect** | 总结执行，输出 confidence、lessonsLearned，标记 done |

**结束条件**：think 不再返回 tool_calls，或达到 maxIterations（20），或连续 3 次工具失败。

---

## 四、数据流向

### 4.1 输入数据流

```
用户请求 JSON
    │
    ├─ topic / select_knowledge_unit ──────→ instruction 主题
    ├─ prompt / extraPrompt ────────────────→ 补充说明
    ├─ docTemplate / template ─────────────→ resolveTemplateContent
    │      └─ html / markdown / plainText
    │             └─ extractSkeleton → TemplateSkeleton
    │                    └─ sections、tables、images、flatHeadings 等
    ├─ database_id ─────────────────────────→ knowledge_search.datasetIds
    ├─ smart_search ───────────────────────→ 是否启用 web_search
    ├─ sessionId ───────────────────────────→ 注入 emit_event、workspace_*、workspaceManager
    └─ large_text（is_single_file_processing=true 时）──→ 最高优先级知识
```

### 4.2 工具调用与数据来源（按优先级）

```
1. large_text（用户上传）
2. knowledge_search（Dify，可带 database_id）
3. web_search (SearchApi.io, smart_search=true时)
4. knowledgeContext / references（请求体自带）
5. image_generate
6. 占位符 ![待补充](placeholder)
```

### 4.3 输出数据流

```
AgentGraphState
    │
    ├─ messages[-1] (AIMessage) ──→ parseAgentOutput(rawOutput, outputFormat)
    │       └─ outputFormat: { type: "markdown" } → 提取 Markdown 片段
    │
    ├─ toolCalls ─────────────────→ 记录在 taskResult，并用于 skillCrystallizer
    ├─ reflections ───────────────→ confidence≥0.6 时写入 MEMORY.md
    └─ 返回 { threadId, output, taskResult }
```

### 4.4 会话与工作区（有 sessionId 时）

```
sessionId
    │
    ├─ workspaceManager.ensureExists(tenantId, userId, sessionId)
    │       └─ data/tenants/{tenantId}/users/{userId}/workspaces/{sessionId}/
    │
    ├─ emit_event ─────────────────→ eventBus.emit() → GET /api/sessions/:sessionId/events
    │
    └─ image_generate ─────────────→ 写入 workspaces/{sessionId}/images/*.png
```

---

## 五、智能体配置与 Prompt 组成

### 5.1 `agent.config.yaml` 要点

- `allowedTools`: knowledge_search/list/doc_retrieve、http_request、file_*、workspace_*、spawn_*、image_generate 等
- `timeout`: 600000 ms（10 分钟）
- `outputFormat`: markdown
- `imageModel`: google/gemini-3-pro-image-preview

### 5.2 System Prompt 组成（`buildSystemPrompt`）

```
IDENTITY.md  → 角色
SOUL.md      → 原则
MISSION.md   → 任务、工作流、表格/图片策略
TOOLS.md     → 工具用法
Task Context → context（businessType、businessInput、skeleton 等）
Session      → sessionId 及 workspace 使用说明
Long-term Memory → MEMORY.md（历史 lessons）
```

---

## 六、MISSION 四阶段逻辑（LLM 执行策略）

| 阶段 | 预期行为 |
|------|----------|
| **Phase 1 骨架解读** | 解析 skeleton，emit_event「正在解析模板结构」 |
| **Phase 2 知识获取** | knowledge_search（可带 database_id）、knowledge_list；可选 http_request；emit_event「正在获取相关资料」 |
| **Phase 3 逐章节生成** | 按 skeleton 的 contentTypes（text/table/image/list）生成；可用 spawn_parallel_agents 并行；有 image 时才 image_generate |
| **Phase 4 组装** | 合并 Markdown，检查 skeleton 覆盖情况，输出最终文稿 |

---

## 七、流程图（简化）

```
                    ┌─────────────────────────────────────────┐
                    │  POST /api/business/document-generation/   │
                    │  generate 或 generate-stream             │
                    └────────────────────┬────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │  validateGenerateBody → normalizeRequest │
                    │  resolveTemplateContent → buildInstruction│
                    └────────────────────┬────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │  agentRuntime.invokeAgent/streamAgent    │
                    │  instruction = 文本指令 + payload + skeleton│
                    └────────────────────┬────────────────────┘
                                         │
    ┌────────────────────────────────────▼────────────────────────────────────┐
    │  LangGraph: perceive → think ⇄ act → observe → think … → reflect → END │
    │  think: LLM 决策（是否调用工具）                                          │
    │  act: knowledge_search / image_generate / emit_event / spawn_* 等        │
    └────────────────────────────────────┬────────────────────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │  parseAgentOutput → 提取 Markdown        │
                    │  返回 { agent, threadId, markdown }       │
                    └─────────────────────────────────────────┘
```

---

## 八、LangGraph 层运行机制详解

本节详解 `perceive → think ⇄ act → observe → think … → reflect → END` 的执行机制与流程规范。

### 8.1 图结构定义（`buildAgentGraph`）

```ts
graph
  .addNode("perceive", ...)
  .addNode("think", ...)
  .addNode("act", ...)
  .addNode("observe", ...)
  .addNode("reflect", ...)
  .addEdge(START, "perceive")
  .addEdge("perceive", "think")
  .addConditionalEdges("think", routeAfterThink)   // → act 或 reflect
  .addEdge("act", "observe")
  .addConditionalEdges("observe", routeAfterObserve) // → think 或 reflect
  .addEdge("reflect", END);
```

### 8.2 全局状态（AgentState）

所有节点共享同一状态，通过 Reducer 合并更新：

| 字段 | 类型 | Reducer | 说明 |
|------|------|---------|------|
| messages | BaseMessage[] | 追加 | 对话历史（Human、AI、Tool、System） |
| workingMemory | WorkingMemory | 覆盖 | 短期记忆（facts、context、shortTermLog） |
| toolCalls | ToolCallRecord[] | 追加 | 本会话已执行工具调用记录 |
| reflections | Reflection[] | 追加 | 反思结果 |
| iteration | number | | 当前 think 轮次（从 1 起）覆盖  |
| maxIterations | number | 覆盖 | 最大轮次，默认 20 |
| done | boolean | 覆盖 | 是否已结束 |
| systemPrompt | string | 覆盖 | 系统提示（Identity + Mission + Tools 等） |

### 8.3 各节点执行逻辑

#### 8.3.1 perceive（入口，只执行一次）

- **输入**：初态（含 messages、systemPrompt 等）
- **输出**：`{ workingMemory }`
- **行为**：
  - 更新短期记忆记录
  - 准备必要的业务上下文
- **后续**：固定进入 `think`

#### 8.3.2 think（LLM 决策）

- **输入**：当前 state（含 systemPrompt、messages、workingMemory）
- **输出**：`{ messages: [AIMessage], iteration: iteration + 1 }`
- **行为**：
  1. 构建 `messagesToSend = [SystemMessage(systemPrompt), WorkingMemory, ...messages]`
  2. 调用 `modelWithTools.invoke(messagesToSend)`（模型已 bindTools）
  3. LLM 返回 AIMessage，可能包含 `tool_calls`
- **后续**：由 `routeAfterThink` 决定
  - 有 `tool_calls` 且非空 → `act`
  - 无 `tool_calls` → `reflect`（任务结束）

#### 8.3.3 act（工具执行）

- **输入**：state，依赖 `messages[-1]` 为 AIMessage 且有 `tool_calls`
- **输出**：`{ messages: [ToolMessage,...], toolCalls: [record,...], workingMemory }`
- **行为**：
  1. 读取 lastMessage.tool_calls，按 `toolMap` 解析工具
  2. 使用 `Promise.all` 并发执行所有 tool_calls
  3. 成功：构建 ToolMessage 和 ToolCallRecord（含 duration、output）
  4. 失败：记录 error，仍返回 ToolMessage 供 LLM 继续推理
  5. 更新 workingMemory
- **后续**：固定进入 `observe`

#### 8.3.4 observe（观察与路由）

- **输入**：state
- **输出**：`{ workingMemory }`
- **行为**：
  - 更新短期记忆，观察刚刚工具执行的结果
- **后续**：由 `routeAfterObserve` 决定
  - `iteration >= maxIterations` → `reflect`（强制结束）
  - 最近 3 次 toolCalls 全失败 → `reflect`（异常退出）
  - 否则 → `think`（继续下一轮）

#### 8.3.5 reflect（反思与收尾）

- **输入**：state
- **输出**：`{ reflections: [Reflection], done: true }`
- **行为**：
  1. 用单独 LLM 调用做反思：输入 execution summary、tool call 详情、最近 messages
  2. 期望返回 JSON：`summary`、`lessonsLearned`、`suggestedImprovements`、`confidence`
  3. 解析失败时使用默认 Reflection（confidence=0.3）
- **后续**：固定进入 END

### 8.4 路由规则汇总

| 路由点 | 函数 | 条件 | 目标 |
|--------|------|------|------|
| think 后 | routeAfterThink | lastMessage 有 tool_calls 且非空 | act |
| think 后 | routeAfterThink | 否则 | reflect |
| observe 后 | routeAfterObserve | iteration >= maxIterations | reflect |
| observe 后 | routeAfterObserve | 最近 3 次 toolCalls 全失败 | reflect |
| observe 后 | routeAfterObserve | 否则 | think |

### 8.5 执行流程规范

1. **单次执行路径**：perceive → think → reflect（无工具调用时）
2. **多轮工具路径**：perceive → think → act → observe → think → … → reflect
3. **轮次上限**：`iteration` 每次 think 后 +1，达到 `maxIterations` 后强制 reflect
4. **工具失败容错**：连续 3 次工具失败后进入 reflect，防止死循环
5. **工具重试**：act 中每工具最多重试 1 次，退避 1s、2s
6. **并发执行**：同一轮 think 的多个 tool_calls 在 act 中通过 `Promise.all` 并发执行

### 8.6 流式输出（streamAgent）

- 使用 `streamMode: "updates"`
- 每轮更新按 `{ nodeName: partialState }` 输出
- 对外映射为：
  - `think` 中 AIMessage 的 content → `token`
  - `act` 中的 toolCalls → `tool_result` 或 `error`
  - `reflect` 中的 reflections → `reflection`
- 图结束后额外产出 `done` 事件

---

## 九、关键文件映射

| 职责 | 文件路径 |
|------|----------|
| 业务入口、校验、instruction 构建 | `apps/document-generation/code/routes.ts` |
| 模板解析（docx→html→skeleton） | `src/utils/template-parser.ts` |
| 智能体运行时、图构建、invoke/stream | `src/core/agent-runtime.ts` |
| LangGraph 定义（think/act/reflect） | `src/core/agent-graph.ts` |
| 智能体配置 | `apps/document-generation/document-generation/agent.config.yaml` |
| 任务定义与工作流 | `apps/document-generation/document-generation/MISSION.md` |
| 工具使用说明 | `apps/document-generation/document-generation/TOOLS.md` |
