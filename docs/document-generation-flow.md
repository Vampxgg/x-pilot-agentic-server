# Document Generation 完整运行流程

以 `POST /api/business/document-generation/generate-stream` 为例，详细说明基于主从架构（Master/Sub-agent）的教学文稿生成全生命周期。

---

## 一、请求示例 Payload

当用户在前端提交生成需求时，系统会接收到如下格式的 JSON Payload：

```json
{
  "select_knowledge_unit": "电子电工原理及故障诊断实训指导书",
  "prompt": "图片不少于10张，加入3个案例，字数1万字左右。",
  "database_id": "d3ac63e1-1d64-4e17-a44b-6c588bb71e96",
  "docCategory": "teachingMaterials",
  "docTemplate": "# \\[任务一 ：任务名称\\]\n\n**\\[项目一 ：项目名称\\]**\n\n## **一、任务引入**\n\n...",
  "is_single_file_processing": 0,
  "large_text": "",
  "smart_search": 1,
  "sessionId": "test10"
}
```

---

## 二、架构总览与入口转译

### 2.1 架构设计
文稿生成功能采用了**编排者-工作者（Orchestrator-Worker）**模式：
1. **主智能体 (`document-generator`)**：负责全局规划、任务拆发、进度推送和最终文档组装。**绝对禁止直接输出正文**。
2. **子智能体 (`section-writer`)**：被主智能体并行唤醒，负责钻研具体的单一章节，进行知识检索、联网搜索和 Markdown 编写。

### 2.2 请求转译 (routes.ts)
在 API 路由层，上述 JSON 不会直接喂给底层模型，而是由 `buildInstruction` 函数转译为一段结构化的高级 Prompt：

> "你是一位资深职业教育文稿生成编排专家。你的任务不是直接写文稿，而是严格按照以下 5 个阶段执行工作流：
> 【任务主题】电子电工原理及故障诊断实训指导书
> 【用户具体要求】图片不少于10张，加入3个案例，字数1万字左右。
> 【文稿类别】teachingMaterials
> 【知识库检索配置】数据集ID：d3ac63e1... 联网搜索：已启用（本地+联网混合检索）
> 【Workspace 上下文】Session ID：test10 ...
> 【参考文档模板】# \\[任务一 ：任务名称\\] ... "

这段指令被作为 `HumanMessage` 传给 `document-generator`，由此启动 LangGraph 状态机。

---

## 三、五阶段工作流执行流转

`document-generator` 启动后，会在 LangGraph 的 `think` 与 `act` 节点间循环，严格执行定义在 `MISSION.md` 中的 5 个阶段。

### 阶段 1：理解结构与需求确认
**目标**：理解传入的文档骨架，向用户确认任务。
- **背景**：文档模板在进入 Agent 之前，已经在 API 路由层的 `/api/business/document-generation/upload-template` 被解析为包含 ID (如 `group-01`) 的结构化数据 (Components)。
- **用户反馈**：主智能体大模型根据解析结果，输出一条欢迎消息到流中，例如：“非常棒，我收到了你关于「电子电工原理及故障诊断实训指导书」的文稿需求！正在根据已解析的 20 个章节规划生成内容...”。

### 阶段 2：知识预检索与蓝图规划
**目标**：获取全局背景知识，规划每章写什么，保存蓝图。
- **调用工具**：`knowledge_search` (可能外加 `web_search`)、`workspace_write`、`event_emit`
- **执行过程**：
  1. 主智能体调用 `knowledge_search`，使用传入的 `database_id`，检索“电子电工原理及故障诊断”的全局核心知识。
  2. 根据 `prompt` 里的“图片不少于10张，3个案例，字数1万字左右”，主智能体在内部推理（`think`）将这些需求均摊到第一步解析出的章节上，为每个章节生成具体的 `generation_instruction`（包含这节写什么、要不要图/表/案例）。
  3. 调用 `workspace_write`，将包含所有信息的规划保存到 `assets/intermediate/blueprint.json`。
- **用户反馈**：调用 `event_emit`，向前端推送进度事件：“规划完成！预计图片：10 张。即将开始并行生成...”。

### 阶段 3：并行章节生成 (最核心的高并发段)
**目标**：启动多个 `section-writer` 子智能体，并行撰写所有章节。
- **调用工具**：`spawn_parallel_agents`
- **执行过程**：
  1. 主智能体将阶段 2 中规划好的几十个章节指令打包成一个庞大的 JSON payload。
  2. 调用 `spawn_parallel_agents` 工具，传入这些任务。
  3. **底层引擎干预**：系统的 `SubAgentManager` 和 `TaskExecutor` 接管请求。根据系统的最大并发配置（如 `maxConcurrency: 10`），同时唤醒多个 `section-writer` 智能体实例。
  
> **子智能体 (`section-writer`) 的内部循环**：
> 1. **检索**：调用 `knowledge_search` 或 `web_search` 获取当前特定章节的精细知识。
> 2. **生成**：大模型结合检索内容，输出带合理格式和结构的 Markdown 正文。
> 3. **保存**：调用 `workspace_write`，将结果保存在 `assets/intermediate/sections/group-{id}.json`，包含内容和图片提示词等。

### 阶段 4：等待与验证
**目标**：等待所有子任务返回，确认文件写入。
- **调用工具**：`workspace_list`
- **执行过程**：主智能体在 `spawn_parallel_agents` 工具返回（即所有子智能体运行结束或超时）后，调用 `workspace_list` 读取当前 session 工作区。它会检查 `assets/intermediate/sections/` 目录下是否已存在预期的所有 Markdown 片段。

### 阶段 5：最终组装与交付
**目标**：合并片段，重排图片编号，输出最终成果。
- **调用机制**：不使用 LLM，通过业务代码直接在 Handler 中完成最终组装
- **执行过程**：
  1. 系统监听到主智能体执行完毕。
  2. 自动调用业务处理函数（在 `apps/document-generation/code/handlers.ts` 的 `assembleDocument` 中）。
  3. 按照骨架顺序，读取 `group-xx.json` 和对应的图片资产，组装为全局 Markdown。
  4. 为所有插图生成并赋予唯一的图片地址。
  5. 将合并后的全文保存至 `artifacts/document.md`。
- **返回结果**：系统返回包含完整 `artifacts/document.md` 内容和提取出的大纲结构给客户端。

---

## 四、核心工具（Tools）一览

| 阶段 | 工具名称 | 调用者 | 功能简述 |
|---|---|---|---|
| Phase 1 | `upload-template` API | `Client` | 纯代码扫描 Docx/Markdown，识别标题层级，返回结构化组件。 |
| Phase 2 | `knowledge_search` | `document-generator` / `section-writer` | 查询 Dify 知识库，获取全局/局部背景知识。 |
| Phase 2 | `web_search` | `document-generator` / `section-writer` | 从互联网获取信息，结合 SearchApi.io。 |
| Phase 2 | `workspace_write` | `document-generator` / `section-writer` | 将蓝图 (`blueprint.json`) 或正文片段写入工作区。 |
| Phase 2 | `event_emit` | `document-generator` | 向前端实时推送规划完成等进度信息。 |
| Phase 3 | `spawn_parallel_agents`| `document-generator` | 批量调度生成子智能体，由底层的任务队列管理并发执行。 |
| Phase 4 | `workspace_list` | `document-generator` | 验证工作区目录下的子文件是否均已就绪。 |
| Phase 5 | `assembleDocument` Handler | 业务系统 | 纯代码读取所有片段，生成配图，重排标号，拼接最终 `document.md`。 |

---

## 五、关键底层机制：LangGraph 与 ReAct 模式

整个主智能体的状态机严格遵循 **Perceive -> Think -> Act -> Observe -> Reflect** 的 LangGraph 路由逻辑：

1. **Think 节点**：将当前的上下文（包括系统 Prompt、工作记忆、工具描述）喂给大模型（如 Gemini 3.1 Pro）。模型如果认为需要执行某个动作，就会在输出中附带 `tool_calls`。
2. **路由 (routeAfterThink)**：若存在 `tool_calls`，跳转到 `Act` 节点；否则进入 `Reflect` 节点。
3. **Act 节点**：执行实际的 TypeScript 函数（如查询数据库、写入文件）。将工具的返回值打包成 `ToolMessage`。
4. **路由 (routeAfterObserve)**：判断是否到达最大迭代次数。未达上限则回到 `Think` 节点，模型结合上一步工具的返回值决定下一步动作。

这解释了为什么**绝不能在对话中停顿**：一旦大模型仅仅输出了自然语言聊天（如“好的，我马上去查”），而没有附带工具调用，`routeAfterThink` 会立刻将状态路由到 `Reflect`，导致任务异常提前终止。这也是 `document-generator` 的 `MISSION.md` 中反复强调必须在同一回复中立刻调用下一步工具的原因。