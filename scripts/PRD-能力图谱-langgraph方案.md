# 能力图谱生成智能体 · LangGraph 底座方案

> 配套文档：
> - 产品需求：`scripts/PRD-能力图谱.pdf`
> - 对照参考（Dify 版）：`scripts/AI-Ability.md`
>
> 本方案基于本仓库的 LangGraph + Agent-Folder 底座，等价覆盖 `AI-Ability.md` 中
> 的 AI-001 ~ AI-010 全部能力，并按本仓库现有约定（`apps/<app>/<agent>/` + `IDENTITY/SOUL/MISSION/TOOLS.md` + `agent.config.yaml` + Pipeline DSL）落地。

---

## 0. TL;DR

- 在 `apps/` 下新增一个业务域 **`competency-map`**，内含 1 个主编排 Agent + 10 个职责专一的 Sub-Agent。
- 主编排 **`competency-map-director`** 用 **Pipeline DSL** 串接 6 个阶段（解析→融合→五级生成→知识推导→合规校验→联动产出），其中：
  - **解析阶段** 通过 `spawn_parallel_agents` 对 N 份 SOP/工单/考核标准做 fan-out 并行；
  - **五级生成阶段** 是强顺序 sub-pipeline（L1→L2→L3→L4→L5），由 `map-architect` 内部 5 个 step 组成；
  - **联动产出阶段**（课程/教材/实训）三个 Sub-Agent 并发执行。
- 数据契约 **完全沿用** `AI-Ability.md` 中已设计的 JSON Schema（项目→任务→流程→技能点→知识点 + confidence + sourceType），保证跟前端、跟旧 Dify 路径互兼容。
- 会话产物（解析中间件、五级 JSON、合规报告、联动文档）全部走 `workspace_*` 工具写入 `data/tenants/<id>/users/<id>/workspaces/<sessionId>/`，前端通过 SSE 增量订阅。

---

## 1. 为什么用 LangGraph 底座（而不是直接抄 Dify 方案）

| 维度 | Dify 方案（现状） | LangGraph 底座（本方案） | 收益 |
|---|---|---|---|
| 编排 | 11 条独立 Workflow，跨流程靠业务侧 SDK 串 | 1 个 Director + Pipeline DSL，依赖关系声明在 yaml | 跨步骤共享上下文/产物，省掉业务侧粘合代码 |
| 并发 | Dify 单流内串行，N 份 SOP 要业务侧自己起 N 个 task | `spawn_parallel_agents` + `fanOutFrom` 原生 fan-out | 一份跟岗 5 份文档解析从串行 5×T 降到 1×T |
| 流式 | Dify SSE 协议自定义 | 已有 `stream-protocol v2` 统一事件 + 三层 ID（task/session/thread） | 前端只接一套 SSE，合规校验/联动产出复用进度推送 |
| 记忆 | 每次调用无状态 | 3 层 Memory（working/daily/long-term）+ 反思与技能结晶 | 院校/专业级模板复用、Few-shot 自学习 |
| 工具 | Dify 节点工具 | 已有 `knowledge_*`（Dify 检索）+ `workspace_*` + `web_search` + `code_executor` | 复用所有底座工具，零重复造轮子 |
| 评测/回放 | 依赖 Dify 后台 | 任务级 `taskResult`、Workspace 全量产物、可重放 | 合规/置信度可审计 |

> **关键决策**：仍然**保留**对 Dify 知识库的访问（通过 `knowledge_search`/`knowledge_doc_retrieve`/`knowledge_list` 工具），让教学标准库、行业标准库、图谱模板库继续在 Dify 端维护，不重复建索引。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  Fastify API 层  /api/business/competency-map/*                      │
│  - generate-stream  /  generate                                      │
│  - parse-document   (单独入口，给跟岗工作台轻量使用)                 │
│  - linkage/{course|textbook|training}                                │
│  - compliance-check                                                  │
└──────────────┬──────────────────────────────────────────────────────┘
               │ invokeAgent / streamAgent
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  competency-map-director  (Pipeline 主编排)                          │
│                                                                      │
│  Step 1: parse_docs   ──fan-out──▶  doc-parser  × N (并行)           │
│            │                                                         │
│  Step 2: fuse_data    ──handler──▶  纯函数：合并去重/打 source 标签  │
│            │                                                         │
│  Step 3: generate_map ──agent────▶  map-architect (内部 5 阶段)      │
│            │                       L1 项目聚类 → L2 任务分解         │
│            │                       → L3 流程编排 → L4 技能提炼       │
│            │                       → L5 知识占位                      │
│            │                                                         │
│  Step 4: deduce_kp    ──fan-out──▶  knowledge-deducer × M (并行)     │
│            │                       (M = L4 技能点数)                 │
│            │                                                         │
│  Step 5: compliance   ──agent────▶  compliance-checker               │
│            │                                                         │
│  Step 6: linkage      ──fan-out──▶  course-generator                 │
│                                     textbook-generator               │
│                                     training-generator               │
└─────────────────────────────────────────────────────────────────────┘

辅助 Agent（独立 API 入口，不强制走主 Pipeline）：
  - gap-analyzer            (AI-005，给教师/学生模块按需调用)
  - enterprise-recommender  (AI-009，给跟岗计划创建步骤按需调用)
  - record-annotator        (AI-010，给现场记录上传时实时调用)
```

**关键事件流（SSE）**：
- `task_started` → 携带 `sessionId`/`threadId`
- 每个 Pipeline Step → `node_started` / `node_finished`
- 每个并行 Sub-Agent → `agent_started` / `agent_message` / `agent_finished`
- 关键里程碑 → `progress` 事件（前端用于"L1 项目聚类完成 ✓"这种进度条）
- 最终 → `done` + `task_finished`（前端拿到完整五级 JSON + 合规报告 + 联动产物清单）

---

## 3. 核心数据契约（TypeScript）

> 与 `AI-Ability.md` JSON Schema 100% 对齐。所有 Agent 的 `outputFormat.schema` 都引用此契约，由底座的 `output-parser` 自动校验。

```ts
// src/services/competency-map/types.ts

export type SourceType = "field_tracking" | "standard" | "ai_deduced";
export type Priority = "core" | "supporting";
export type BloomLevel =
  | "remembering" | "understanding" | "application"
  | "analysis"   | "synthesis"     | "evaluation";

export interface KnowledgePoint {
  id: string;
  name: string;
  priority: Priority;
  bloomLevel: BloomLevel;
  subjectArea?: string;
  reference?: string;        // 来源标准/文献，例 "GB/T 18384-2020 第5章"
  reason?: string;           // 推导理由（给审核用）
  confidence: number;        // 0-1
}

export interface SkillPoint {
  id: string;
  name: string;
  description: string;
  proficiencyLevel: 1 | 2 | 3 | 4 | 5;
  assessmentCriteria: string;
  tools: string[];
  safetyNorms?: string[];
  sourceType: SourceType;
  sourceRef?: string;         // 跟岗记录 ID 或标准条款号
  confidence: number;
  knowledgePoints: KnowledgePoint[];
}

export interface Workflow {
  id: string; name: string;
  sequence: number;
  tools: string[];
  safetyNorms: string[];
  qualityStandards?: string[];
  confidence: number;
  skillPoints: SkillPoint[];
}

export interface Task {
  id: string; name: string;
  description?: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  prerequisites: string[];    // 前置 task id
  confidence: number;
  workflows: Workflow[];
}

export interface Project {
  id: string; name: string;
  source: string;             // 来源企业
  industry?: string;
  cycle?: string;
  confidence: number;
  tasks: Task[];
}

export interface CompetencyMap {
  id: string;
  name: string;
  major: string;
  version: string;
  status: "draft" | "reviewing" | "published";
  projects: Project[];
  metadata: {
    sourceFieldTrackingIds: string[];
    sourceDocumentIds: string[];
    avgConfidence: number;
    generatedAt: string;
    generatedBy: string;       // agent name@version
  };
}

export interface ComplianceReport {
  mapId: string;
  passed: boolean;
  score: number;               // 0-100
  issues: Array<{
    ruleId: string;            // STRUCT_001 / SOURCE_002 / GRAIN_001 ...
    severity: "error" | "warning" | "info";
    path: string;              // JSON pointer，定位到节点
    message: string;
    suggestion?: string;
  }>;
}
```

---

## 4. Agent 矩阵（AI-001 ~ AI-010 → 本方案 Agent 映射）

| Dify 编号 | Dify 名称 | 本方案 Agent | 调用方式 | 编排位置 |
|---|---|---|---|---|
| AI-001 | 文档智能解析 | `doc-parser` | Sub-Agent (fan-out) | Director Step 1 / 也支持独立 API |
| AI-002 | 五级结构生成 | `map-architect` | Sub-Agent (内部 sub-pipeline) | Director Step 3 |
| AI-003 | 知识点推导 | `knowledge-deducer` | Sub-Agent (fan-out per skill) | Director Step 4 |
| AI-004 | 合规校验 | `compliance-checker` | Sub-Agent | Director Step 5 / 也支持独立 API |
| AI-005 | 缺口分析 | `gap-analyzer` | 独立 Agent | 教师/学生业务路由触发 |
| AI-006 | 课程联动 | `course-generator` | Sub-Agent | Director Step 6 (并行) / 独立 API |
| AI-007 | 教材框架 | `textbook-generator` | Sub-Agent | Director Step 6 (并行) / 独立 API |
| AI-008 | 实训方案 | `training-generator` | Sub-Agent | Director Step 6 (并行) / 独立 API |
| AI-009 | 企业推荐 | `enterprise-recommender` | 独立 Agent | 跟岗计划创建时触发 |
| AI-010 | 现场记录标注 | `record-annotator` | 独立 Agent | 记录上传时实时触发 |

> 设计原则：**并行场景用 Sub-Agent**（doc-parser、knowledge-deducer、联动三件套），**强顺序场景用 Pipeline Step**（五级分解），**独立调用场景独立 Agent**（gap/recommend/annotate）。

---

## 5. 目录结构（落地形态）

```
apps/competency-map/
├── code/                                     # Fastify 路由（自动加载）
│   ├── routes.ts                             # /api/business/competency-map/*
│   ├── handlers/
│   │   ├── generate.ts                       # 主流程入口
│   │   ├── parse-document.ts                 # 单文档解析
│   │   ├── linkage.ts                        # 课程/教材/实训
│   │   ├── compliance.ts                     # 合规校验单独入口
│   │   ├── gap-analysis.ts                   # 缺口分析
│   │   └── annotate-record.ts                # 现场记录标注
│   └── pipelines/
│       └── data-fusion.handler.ts            # Pipeline 自定义 handler（纯函数 step）
│
├── _shared/
│   ├── schemas/                              # 复用的 outputFormat JSON Schema
│   │   ├── competency-map.schema.json
│   │   ├── parsed-document.schema.json
│   │   ├── compliance-report.schema.json
│   │   └── linkage-output.schema.json
│   └── prompts/                              # 跨 agent 复用的 Prompt 片段
│       ├── five-level-rules.md
│       └── few-shot/
│           ├── nev-automotive.md
│           └── industrial-robotics.md
│
├── competency-map-director/
│   ├── IDENTITY.md
│   ├── SOUL.md
│   ├── MISSION.md
│   ├── TOOLS.md
│   └── agent.config.yaml                     # ← 包含 pipeline 定义
│
├── doc-parser/                               # AI-001
├── map-architect/                            # AI-002 (内部 sub-pipeline)
├── knowledge-deducer/                        # AI-003
├── compliance-checker/                       # AI-004
├── gap-analyzer/                             # AI-005
├── course-generator/                         # AI-006
├── textbook-generator/                       # AI-007
├── training-generator/                       # AI-008
├── enterprise-recommender/                   # AI-009
└── record-annotator/                         # AI-010
```

---

## 6. 主编排：`competency-map-director`

### 6.1 `agent.config.yaml`

```yaml
model: gpt-4o
workerModel: gpt-4o-mini          # Worker 用于内部短决策（如 fan-out 输入裁剪）
maxConcurrency: 6                  # fan-out 并发上限
maxTokens: 8000
timeout: 1800000                   # 30 分钟（覆盖大型图谱）

allowedTools:
  - workspace_write
  - workspace_read
  - workspace_list
  - knowledge_search                # 教学/职业/行业标准 RAG
  - knowledge_doc_retrieve
  - spawn_sub_agent
  - spawn_parallel_agents
  - event_emit                      # 进度上报

heartbeat: { enabled: false, intervalMs: 0 }
evolution: { enabled: true, requireApproval: true }
streamMode: stream
hideThinkOutput: true

outputFormat:
  type: json
  schema: { $ref: "../_shared/schemas/competency-map.schema.json" }

pipeline:
  steps:
    - name: parse_docs
      agent: doc-parser
      parallel: true
      fanOutFrom: "input.dataSources.uploadedDocuments"
      inputMapping:
        fileId:   "$item.fileId"
        fileUrl:  "$item.fileUrl"
        fileType: "$item.fileType"
        context:  "$input.context"
      retry: { maxAttempts: 2, backoffMs: 3000 }

    - name: fuse_data
      handler: data-fusion              # 走 code/pipelines/data-fusion.handler.ts
      dependsOn: [parse_docs]

    - name: generate_map
      agent: map-architect
      dependsOn: [fuse_data]
      inputMapping:
        major:        "$input.major"
        fusedData:    "$results.fuse_data"
        templateData: "$input.dataSources.templateData"

    - name: deduce_kp
      agent: knowledge-deducer
      parallel: true
      fanOutFrom: "$results.generate_map.flatSkillPoints"  # map-architect 输出时打平
      dependsOn: [generate_map]
      inputMapping:
        skillPoint: "$item"
        context:
          major: "$input.major"
          projectName: "$item.__projectName"
          workflowName: "$item.__workflowName"

    - name: compliance
      agent: compliance-checker
      dependsOn: [deduce_kp]
      inputMapping:
        map:        "$results.generate_map"
        kpResults:  "$results.deduce_kp"
        checkItems: ["structure","source","granularity","bloom","redundancy"]

    - name: linkage
      parallel: true
      dependsOn: [compliance]
      # parallel 子步骤集合（无 fanOutFrom 时表示固定并行集）
      steps:
        - { name: course,   agent: course-generator,   inputMapping: { map: "$results.generate_map" } }
        - { name: textbook, agent: textbook-generator, inputMapping: { map: "$results.generate_map" } }
        - { name: training, agent: training-generator, inputMapping: { map: "$results.generate_map" } }
      optional: true                    # 用户可在 API 入参里 disableLinkage:true 跳过
```

### 6.2 SOUL.md（节选）

```markdown
## CORE
- 我是能力图谱生产线的总指挥。我**不亲自做**任何一级分解、不写任何知识点；
  我只负责选择数据源、调度专家 Agent、监督质量门、聚合最终产物。
- 五级分解的顺序是**不可妥协**的强约束：L1→L2→L3→L4→L5，禁止跳级或回填。
- 政策第一，AI 第二：任何与 1 号文五级分解体系冲突的产物，宁可标 error 也不放行。

## MUTABLE
- 当 fan-out 子任务失败率 > 30% 时，自动降级到串行重试。
- 当上游 doc-parser 平均 confidence < 0.7 时，主动在 SSE 推送 `warning` 事件，
  提示用户补充更多跟岗一手材料。
```

### 6.3 TOOLS.md（节选）

```markdown
## 工具使用规则
- `workspace_write`：每个 Pipeline Step 结束都写一份产物快照到
  `workspaces/<sessionId>/<step-name>.json`，便于断点重放与审核回看。
- `event_emit`：在每个里程碑（解析完成 / 五级生成完成 / 合规通过）
  emit `progress` 事件，前端进度条直接消费。
- `knowledge_search`：仅用于"主题级"检索（例如 `major=新能源汽车`+`industry=新能源`），
  细粒度的"按技能点检索"由 knowledge-deducer 负责，避免我消耗过多 token。
```

---

## 7. AI-001 · `doc-parser`（文档智能解析）

### 7.1 职责
对一份 SOP / 工单 / 考核标准，抽取符合五级分解 L3-L4-L5 雏形的结构化要素。

### 7.2 关键设计
- 文件预处理走底座 `code_executor` + Python 子进程（PyPDF2 / pdfplumber / python-docx / openpyxl / Tesseract OCR）。
- 长文档分块策略：按章节/页面切，每块 ≤ 4000 tokens；分块结果在 Agent 内部串行抽取，最后一次 LLM 合并去重。
- 输出强制 JSON Schema 校验，失败自动重试 1 次。

### 7.3 `agent.config.yaml`

```yaml
model: gpt-4o                     # 文档理解强需求
workerModel: gpt-4o-mini          # 用于分块合并
maxConcurrency: 1                 # 单文档单线程，并发由上层 fan-out 控制
maxTokens: 4096
timeout: 300000

allowedTools:
  - file_read
  - code_executor                 # 跑预处理脚本
  - workspace_write               # 落临时分块结果
  - event_emit

outputFormat:
  type: json
  schema: { $ref: "../_shared/schemas/parsed-document.schema.json" }

retry: { maxAttempts: 2, backoffMs: 5000 }
```

### 7.4 System Prompt 关键片段

```
你是职业教育领域的"企业跟岗一手材料解析专家"。当前文档类型：{fileType}（sop|workorder|assessment）。

你的输出**必须**满足以下要求：
1. 严格 JSON，遵循给定 Schema；任何超出 Schema 的字段一律丢弃。
2. 每个抽取项标注 confidence ∈ [0,1]，原则：
   - 文档原文显式写出 → ≥ 0.9
   - 文档隐含/需推断 → 0.6~0.85
   - 跨文档脑补 → ≤ 0.5（并在 reason 中说明理由）
3. 每个抽取项标注 sourceRef，格式 "p<页码>:<段落起始>" 或 "table:<表名>:<行号>"。
4. SOP 的"操作步骤"对应 L3 流程层；"完成步骤所需技能"对应 L4 技能点雏形；
   不要在本阶段产出 L5 知识点（那是 knowledge-deducer 的职责）。

当前上下文：
- 企业：{context.enterprise}
- 岗位：{context.jobTitle}
- 行业：{context.industry}

【few-shot】
（按 industry 注入 _shared/prompts/few-shot/{industry}.md）
```

---

## 8. AI-002 · `map-architect`（五级结构生成）

> **本方案最复杂的 Agent**。内部用 **sub-pipeline** 把一次性大 Prompt 拆成 5 个可审计的小 Step，每步只做一件事，每步都有独立 schema 和 confidence 阈值。

### 8.1 内部 sub-pipeline

```yaml
# apps/competency-map/map-architect/agent.config.yaml
model: gpt-4o
workerModel: gpt-4o
maxTokens: 8000
maxConcurrency: 1
timeout: 600000

allowedTools:
  - knowledge_search
  - workspace_write
  - workspace_read
  - event_emit

outputFormat:
  type: json
  schema: { $ref: "../_shared/schemas/competency-map.schema.json" }

pipeline:
  steps:
    - { name: l1_project_clustering, handler: l1-cluster }       # LLM 调用包在 handler 内
    - { name: l2_task_decomposition, handler: l2-decompose, dependsOn: [l1_project_clustering] }
    - { name: l3_workflow_layout,    handler: l3-layout,    dependsOn: [l2_task_decomposition] }
    - { name: l4_skill_refinement,   handler: l4-refine,    dependsOn: [l3_workflow_layout] }
    - { name: l5_knowledge_stub,     handler: l5-stub,      dependsOn: [l4_skill_refinement] }
    # 注意：L5 只放占位，真正的知识点推导在 Director 的 Step 4 fan-out 完成
```

### 8.2 各 Step 关键约束

| Step | 关键 Prompt 约束 | 失败回退 |
|---|---|---|
| L1 项目聚类 | 必须有 `source=企业名`；同主题超过 5 个 → 强制再聚一层 | confidence<0.7 → 标记 needs_review，不阻断 |
| L2 任务分解 | 每任务必须给 `prerequisites`；任务名不允许出现"理论""学习"等学院化词 | 检测到学院化词 → 同句重写 |
| L3 流程编排 | 必须 `sequence` 连续无空洞；`tools`/`safetyNorms` 至少 1 项 | 缺失 → 从 doc-parser 原始抽取里回填 |
| L4 技能提炼 | `proficiencyLevel ∈ [1,5]`，`assessmentCriteria` 必须含可测量动词（"独立完成"/"准确率 ≥ 95%"等） | 不含可测量动词 → 单点重生成 |
| L5 知识占位 | 仅产出"知识领域"占位（subjectArea），**不**写具体知识点 | — |

### 8.3 SOUL.md（节选）

```markdown
## CORE
- 我是能力图谱的"结构总建筑师"，对**结构合规性**负全责。
- "项目"必须来源于企业真实生产/服务项目；任何"教学法/课程论"概念禁止上 L1。
- 技能点颗粒度：能在 2-4 课时内完成教学闭环为合格；过粗 → 拆，过细 → 合并。

## MUTABLE
- 行业差异：制造业偏重 SOP，软件业偏重交付物 + 验收清单 → 自动加载对应 few-shot。
- 当 fusedData.skillCount < 8 时，自动启用 knowledge_search 拉行业职业标准补足，
  并把这部分 skillPoint.sourceType 标为 "standard"。
```

---

## 9. AI-003 · `knowledge-deducer`（知识点推导）

### 9.1 调用模式
Director Step 4 对 `generate_map.flatSkillPoints` 做 fan-out，**每个 L4 技能点起一个 knowledge-deducer 实例**，并发上限由 `competency-map-director.maxConcurrency=6` 控制。

### 9.2 处理流程
```
1. RAG 检索（knowledge_search）
   query = `${skillPoint.name} ${skillPoint.tools.join(" ")} ${context.major}`
   top_k = 8, score_threshold = 0.4
   datasets = [教学标准库, 职业标准库, 行业标准库]

2. LLM 推导
   - 输入：技能点描述 + RAG top_k 段落
   - 输出：知识点候选列表（含 priority/bloomLevel/reference/reason/confidence）
   - 强制：core 知识点 ≤ 5 个，supporting 知识点 ≤ 8 个；超出必须合并

3. 冗余自检
   - 在 Agent Memory 里维护本次 sessionId 内已产出的知识点指纹（name+subjectArea）
   - 命中 → 复用同一 knowledgePoint.id，避免不同 skillPoint 重复创建
```

### 9.3 `agent.config.yaml`

```yaml
model: gpt-4o-mini                # 此场景对推理深度需求中等，用轻量模型省成本
workerModel: gpt-4o-mini
maxTokens: 2048
maxConcurrency: 1
timeout: 60000

allowedTools:
  - knowledge_search
  - knowledge_doc_retrieve
  - workspace_read                # 读取本次 session 已产出的 kp 指纹
  - workspace_write
  - event_emit

outputFormat:
  type: json
  schema:
    type: object
    properties:
      knowledgePoints: { type: array, items: { $ref: "knowledge-point.schema.json" } }
    required: [knowledgePoints]
```

---

## 10. AI-004 · `compliance-checker`（合规校验）

### 10.1 设计
**规则引擎为主 + LLM 兜底**。规则引擎用纯 TS 实现（不消耗 LLM token），覆盖 80% 校验项；只有 `useAI: true` 的规则（颗粒度判断、语义合规）才进入 LLM。

### 10.2 规则配置（声明在 `_shared/schemas/compliance-rules.yaml`）

```yaml
rules:
  - { id: STRUCT_001, severity: error,   useAI: false, jsonpath: "$.projects[*].tasks", min: 1 }
  - { id: STRUCT_002, severity: error,   useAI: false, jsonpath: "$.projects[*].tasks[*].workflows[*].skillPoints", min: 1 }
  - { id: STRUCT_003, severity: warning, useAI: false, jsonpath: "$..skillPoints[*].knowledgePoints", min: 1 }
  - { id: SOURCE_001, severity: error,   useAI: false, jsonpath: "$.projects[*].source", notEmpty: true }
  - { id: SOURCE_002, severity: warning, useAI: false, jsonpath: "$..skillPoints[*].sourceType", in: [field_tracking, standard] }
  - { id: GRAIN_001,  severity: info,    useAI: true,  prompt: "判断该技能点是否可在 2-4 课时内掌握" }
  - { id: BLOOM_001,  severity: warning, useAI: false, jsonpath: "$..knowledgePoints[*].bloomLevel", notEmpty: true }
  - { id: REDUN_001,  severity: info,    useAI: false, custom: "detect-orphan-knowledge-points" }
  - { id: NAMING_001, severity: warning, useAI: true,  prompt: "项目/任务名称是否避免了学院化用语" }
```

### 10.3 输出
完整 `ComplianceReport`，并在 Workspace 写一份 `compliance-report.md`（人类可读）便于教师/企业专家审核。

---

## 11. AI-005 · `gap-analyzer`（缺口分析，独立 Agent）

### 11.1 触发
教师/学生模块业务路由按需调用，不在主 Pipeline 内。

### 11.2 处理
```
1. 读取目标 CompetencyMap.flatSkillPoints
2. 读取用户档案：teacher.competencies / student.assessments
3. 向量相似度对齐（skillPoint.name + description vs user.skill.name + level）
   - 用 knowledge_search 复用 Dify 的 embedding，避免再建一套
4. gap = required.proficiencyLevel - matched.currentLevel
5. LLM 生成培训建议（method/duration/enterprise）
   - 教师方向：推荐企业研修岗位（调用 enterprise-recommender 子 Agent）
   - 学生方向：推荐学习路径（按依赖关系拓扑排序 L4 技能点）
```

### 11.3 输出 Schema 节选
```json
{
  "userId": "...",
  "mapId": "...",
  "profile": { "totalRequired": 56, "matched": 32, "gap": 24, "coverageRate": 0.57 },
  "gaps": [
    { "skillPointId": "sp_001", "requiredLevel": 4, "currentLevel": 2, "gap": 2,
      "suggestion": { "method": "enterprise_internship", "duration": "2 weeks",
                      "enterpriseRecommendation": ["比亚迪","蔚来"] } }
  ]
}
```

---

## 12. AI-006/007/008 · 联动产出三件套

三个 Agent 结构高度同构，共用同一份 `_shared/prompts/linkage-base.md`，差异在输出 schema：

| Agent | 输入 | 输出 schema 关键字段 | 特殊约束 |
|---|---|---|---|
| `course-generator` (AI-006) | CompetencyMap | `courses[]`：`{ name, prerequisites, hours.{practice,theory}, mappedWorkflowIds, mappedSkillPointIds }` | **实践先行**：每门课先实践后理论；prerequisites 必须满足 task 依赖拓扑 |
| `textbook-generator` (AI-007) | CompetencyMap | `chapters[]`：`{ title, sections[].{title, knowledgePointIds, caseRefs } }` | 每章节知识点 100% 可追溯；冗余知识点必须告警 |
| `training-generator` (AI-008) | CompetencyMap | `projects[]`：`{ name, scenario, equipment[], assessmentCriteria, mappedTaskId }` | 实训项目必须 1:1 对应 L1/L2；考核标准直接复用 L4 |

### 12.1 共用 `agent.config.yaml`（差异部分）

```yaml
model: gpt-4o
workerModel: gpt-4o-mini
maxTokens: 6000
maxConcurrency: 1
timeout: 180000

allowedTools:
  - workspace_write
  - workspace_read
  - knowledge_search       # 教材生成时检索国规教材目录做对照
  - event_emit
```

### 12.2 SOUL.md 共同 CORE
```
- 我是图谱→<课程|教材|实训>的转译器，不允许"创造"图谱里没有的技能/知识。
- 任何输出条目必须能反向追溯到至少 1 个 skillPointId 或 taskId，
  否则该条目必须丢弃。
```

---

## 13. AI-009 · `enterprise-recommender`（企业推荐，独立 Agent）

### 13.1 触发
- 跟岗计划创建步骤：根据 `major` 推荐对口企业 + 岗位列表。
- `gap-analyzer` 内部调用：根据"教师能力缺口"推荐对口研修企业。

### 13.2 处理
```
1. knowledge_search(dataset="企业数据库") with query=`${major} ${region} ${techStack}`
2. 按行业匹配度 + 地理就近 + 历史合作深度 三维度打分
3. LLM 生成推荐理由（用于前端展示，含合作切入点建议）
```

> 不消耗 LLM 进行打分，全靠 RAG + 规则；LLM 只负责"理由文本生成"，配 `gpt-4o-mini` 即可。

---

## 14. AI-010 · `record-annotator`（现场记录标注，独立 Agent）

### 14.1 触发
教师在跟岗工作台上传图文/视频时，前端实时调用 `/api/business/competency-map/annotate-record`。

### 14.2 处理
```
1. 多模态识别（图片/视频帧）
   - 走 image_generate 同源的多模态 LLM (gpt-4o vision)
2. 文字描述结构化
3. 自动技能点标注：
   - 若 record.context 已关联 mapId，则 knowledge_search 该 map 内的 skillPoints 取相似 top_k
   - 否则纯 LLM 推断 + 标低 confidence
4. 返回 operationDesc + skillPoints + suggestedTags + confidence
```

### 14.3 `agent.config.yaml`

```yaml
model: gpt-4o                # 多模态需求
maxTokens: 1024
maxConcurrency: 1
timeout: 30000               # 短链路，给前端实时反馈

allowedTools:
  - file_read                # 读上传图片
  - knowledge_search
  - workspace_write
```

---

## 15. API 设计（新增）

> 全部挂在 `/api/business/competency-map/` 下，遵循已有 `route-registry` 自动加载规约。

| Method | Path | 说明 | 对应 Agent |
|---|---|---|---|
| POST | `/generate` | 主流程，blocking | competency-map-director |
| POST | `/generate-stream` | 主流程，SSE | competency-map-director |
| POST | `/parse-document` | 单文档解析（跟岗工作台轻量调用） | doc-parser |
| POST | `/parse-document-stream` | 单文档解析，SSE | doc-parser |
| POST | `/compliance-check` | 对已有图谱跑合规校验 | compliance-checker |
| POST | `/deduce-knowledge` | 对单个 skillPoint 推导知识点（编辑器内"AI 建议"按钮） | knowledge-deducer |
| POST | `/linkage/course` | 单独触发课程联动 | course-generator |
| POST | `/linkage/textbook` | 单独触发教材联动 | textbook-generator |
| POST | `/linkage/training` | 单独触发实训联动 | training-generator |
| POST | `/gap-analysis/teacher` | 教师能力缺口分析 | gap-analyzer |
| POST | `/gap-analysis/student` | 学生能力达成度分析 | gap-analyzer |
| POST | `/enterprise/recommend` | 企业/岗位推荐 | enterprise-recommender |
| POST | `/annotate-record` | 现场记录 AI 标注 | record-annotator |
| GET | `/sessions/:sessionId/artifacts` | 取本次 session 全部产物清单 | workspace_list |
| GET | `/sessions/:sessionId/artifacts/:name` | 取单个产物 | workspace_read |

### 15.1 主入口请求示例

```json
POST /api/business/competency-map/generate-stream
{
  "mapId": "cm_002",
  "name": "新能源汽车检测与维修技术能力图谱",
  "major": "新能源汽车检测与维修技术",
  "context": {
    "enterprise": "比亚迪汽车有限公司",
    "industry": "新能源汽车",
    "region": "深圳"
  },
  "dataSources": {
    "fieldTrackingAnalysis": [
      { "planId": "ft_001", "structuredTree": [ /* ... */ ] }
    ],
    "uploadedDocuments": [
      { "fileId": "upload_001", "fileUrl": "/uploads/...", "fileType": "sop" },
      { "fileId": "upload_002", "fileUrl": "/uploads/...", "fileType": "workorder" }
    ],
    "templateData": null
  },
  "options": {
    "disableLinkage": false,
    "complianceStrict": true,
    "fewShotIndustry": "nev-automotive"
  }
}
```

### 15.2 SSE 事件流（关键节点）

```
event: task_started     {sessionId, threadId, task_id}
event: node_started     {step:"parse_docs"}
event: agent_started    {agent:"doc-parser", instance:1, file:"upload_001"}
event: agent_started    {agent:"doc-parser", instance:2, file:"upload_002"}  # 并行
event: agent_finished   {agent:"doc-parser", instance:1, confidence:0.91}
event: agent_finished   {agent:"doc-parser", instance:2, confidence:0.86}
event: node_finished    {step:"parse_docs", duration:42000}
event: progress         {milestone:"docs_parsed", count:2}
event: node_started     {step:"fuse_data"}
event: node_finished    {step:"fuse_data", duration:1200}
event: node_started     {step:"generate_map"}
event: agent_message    {agent:"map-architect", subStep:"l1_project_clustering"}
event: agent_message    {agent:"map-architect", subStep:"l2_task_decomposition"}
event: agent_message    {agent:"map-architect", subStep:"l3_workflow_layout"}
event: agent_message    {agent:"map-architect", subStep:"l4_skill_refinement"}
event: agent_message    {agent:"map-architect", subStep:"l5_knowledge_stub"}
event: node_finished    {step:"generate_map", projects:3, tasks:8, skills:45}
event: progress         {milestone:"map_skeleton_ready"}
event: node_started     {step:"deduce_kp"}
event: agent_started    {agent:"knowledge-deducer", instance:1, skill:"高压互锁系统检测"}
... (45 个并发，按 maxConcurrency=6 分批)
event: node_finished    {step:"deduce_kp", totalKnowledgePoints:178}
event: node_started     {step:"compliance"}
event: node_finished    {step:"compliance", passed:true, score:94, issues:3}
event: node_started     {step:"linkage"}
event: agent_finished   {agent:"course-generator",   courses:7}
event: agent_finished   {agent:"textbook-generator", chapters:12}
event: agent_finished   {agent:"training-generator", projects:5}
event: node_finished    {step:"linkage"}
event: done             {sessionId, artifacts:["competency-map.json","compliance-report.md","linkage/*"]}
event: task_finished
```

---

## 16. RAG 知识库策略（沿用 Dify，不重建）

| 知识库 | 用法 | 调用方 |
|---|---|---|
| 教学标准库 | knowledge_search 主题级检索 | map-architect, knowledge-deducer |
| 职业标准库 | knowledge_search 技能点级检索 | knowledge-deducer, compliance-checker |
| 行业标准库 | knowledge_doc_retrieve 取标准条款全文 | knowledge-deducer, doc-parser（safetyNorms 校验） |
| 图谱模板库 | knowledge_search 取相似图谱做 few-shot | map-architect (启动阶段) |
| 企业数据库 | knowledge_search 推荐对口企业 | enterprise-recommender |

> **配置入口**：均走仓库现有 `KNOWLEDGE_*` 环境变量，无需新增 client。

---

## 17. Workspace 产物结构

```
data/tenants/<tenantId>/users/<userId>/workspaces/<sessionId>/
├── input.json                              # 入参快照
├── parse_docs/
│   ├── upload_001.parsed.json
│   └── upload_002.parsed.json
├── fuse_data.json                          # 融合后的统一技能要素池
├── generate_map/
│   ├── l1_project_clustering.json
│   ├── l2_task_decomposition.json
│   ├── l3_workflow_layout.json
│   ├── l4_skill_refinement.json
│   └── l5_knowledge_stub.json
├── deduce_kp/
│   ├── sp_001.json
│   ├── sp_002.json
│   └── ...
├── competency-map.json                     # ★ 最终五级图谱
├── compliance-report.json
├── compliance-report.md                    # 人类可读
└── linkage/
    ├── courses.json
    ├── textbook.json
    └── training.json
```

> 这套布局让"重放/局部重生成"非常容易：例如教师在编辑器里改了某个 L4 技能点，只需要重跑 `deduce_kp/<spId>` + `compliance` + `linkage`，前 3 个 step 完全不动。

---

## 18. 与现有底座能力的复用清单

| 底座能力 | 本方案如何复用 |
|---|---|
| Pipeline DSL + 拓扑排序 | 主编排 + map-architect 内部 sub-pipeline |
| `spawn_parallel_agents` + `fanOutFrom` | doc-parser × N、knowledge-deducer × M、联动三件套 |
| 3 层 Memory + Skill Crystallization | 院校/专业级 few-shot 沉淀；高频"误判模式"结晶为校验规则 |
| `knowledge_*` 工具家族 | 不再单独写 RAG 客户端，直接复用 |
| `workspace_*` 工具 | 全产物落盘 + 断点重放 |
| `output-parser` + JSON Schema | 强契约输出，schema 集中放在 `_shared/schemas/` |
| `stream-protocol v2` SSE | 前端进度条/审核协作零成本接入 |
| `event-bus` | 跨步骤里程碑广播（合规未通过时可触发企业专家通知 webhook） |
| `evolution + reflection` | 每次大图谱生成后做反思，把"低 confidence 模式"沉淀进 Memory |

---

## 19. 实施路线图（与 PRD Phase 对齐）

| Phase | 周次 | 本方案交付 | 与 PRD 对应 |
|---|---|---|---|
| Phase 1 | W1-2 | 数据契约 (`_shared/schemas/*`) + Director 骨架 + doc-parser 落地 | PRD Phase1 W1-2 |
| Phase 1 | W3-4 | map-architect 内部 5-step + Workspace 产物布局 + 单元测试覆盖 80% | PRD Phase1 W3-4 |
| Phase 1 | W5-6 | knowledge-deducer + compliance-checker + 主流程 SSE 事件流通 | PRD Phase1 W5-6 |
| Phase 1 | W7-8 | 编辑器内"局部重生成" API（`/deduce-knowledge` 单点调用） | PRD Phase1 W7-8 |
| Phase 2 | W9-10 | course-generator + 与课程模块业务的对接 | PRD Phase2 W9-10 |
| Phase 2 | W11-12 | textbook-generator + training-generator | PRD Phase2 W11-12 |
| Phase 2 | W13-14 | gap-analyzer (教师/学生双形态) + enterprise-recommender | PRD Phase2 W13-14 |
| Phase 3 | W15-16 | record-annotator + 大屏数据聚合 API | PRD Phase3 W15-16 |
| Phase 3 | W17-18 | 反思 / 模板沉淀 / 跨院校 few-shot 共享机制 | PRD Phase3 W17-18 |

---

## 20. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 大图谱时 token 爆炸（1 图谱 200+ 技能点 × 5 知识点 = 1000+ LLM 调用） | knowledge-deducer 用 gpt-4o-mini；同 session 知识点指纹去重；fan-out 并发上限 6 兼顾速度与配额 |
| LLM 输出违反 JSON Schema | output-parser 自动重试 + map-architect 内每个 sub-step 独立校验，定位到出错的某一级 |
| 跟岗数据极少时图谱质量差 | doc-parser 平均 confidence < 0.7 时 SSE 推 warning；map-architect 自动从职业标准库补足，并标 sourceType=standard |
| 合规规则随政策更新 | 规则配置外置 `_shared/schemas/compliance-rules.yaml`，热加载，不动代码 |
| 跨院校模板复用涉及数据隔离 | tenantId 隔离已由底座保证；模板库走只读 RAG，不暴露源租户数据 |
| **开放**：是否需要为"图谱版本对比/分支"另建专用 Agent？ | Phase 2 决策，倾向于纯后端 diff 工具 + 前端可视化，不消耗 LLM |
| **开放**：现场记录的视频帧抽样策略 | 待与前端协商：客户端抽帧 vs 服务端 ffmpeg 抽帧 |

---

## 21. 与 README 的同步项（落地时必改）

按 `.cursor/rules/documentation-sync.mdc` 要求，本方案落地时需同步更新 `README.md`：

1. **Project Structure** 章节：在 `apps/` 下新增 `competency-map/` 条目并展开 11 个子 Agent。
2. **Business Domain API** 章节：新增 §15 中列出的 15 条路由。
3. **Key Capabilities** 章节：在"Declarative Pipeline + Adaptive Routing"或"Parallel Execution"小节示例里加一句"能力图谱五级生成是该模式的典型应用"。
4. （无新增内置工具，无需改 Built-in Tools 表。）

---

## 22. 附录 · 与 `AI-Ability.md` 字段一致性核对表

| AI-Ability.md 字段 | 本方案对应 | 一致性 |
|---|---|---|
| `documentType / extractedData / metadata` | `parsed-document.schema.json` | ✅ 完全一致 |
| `projects[].source` | `Project.source` | ✅ |
| `skillPoints[].proficiencyLevel` 1-5 | `SkillPoint.proficiencyLevel` 1-5 | ✅ |
| `skillPoints[].sourceType` (field_tracking/standard/ai_deduced) | 同 | ✅ |
| `knowledgePoints[].priority` (core/supporting) | 同 | ✅ |
| `knowledgePoints[].bloomLevel` 6 级 | 同 | ✅ |
| 各节点 `confidence` ∈ [0,1] | 同 | ✅ |
| `ComplianceReport.issues[].ruleId/severity` | 同 | ✅，规则 ID 沿用 STRUCT/SOURCE/GRAIN/BLOOM/REDUN 命名空间 |

> 结论：本方案 **不破坏** Dify 版输出契约，前端与既有业务层无需改动；区别只在于编排引擎从 Dify 切换到本仓库 LangGraph 底座。
