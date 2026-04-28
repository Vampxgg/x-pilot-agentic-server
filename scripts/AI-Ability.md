## 第三部分：AI服务文档

### 一、AI服务总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      X-Pilot 后端服务                        │
│  ┌──────────────────┐    ┌──────────────────┐               │
│  │   业务 API 层     │───▶│   AI Task Queue  │               │
│  │ (Express/Koa)    │    │ (Redis/Bull MQ)  │               │
│  └──────────────────┘    └────────┬─────────┘               │
│                                   │                          │
│                          ┌────────▼─────────┐               │
│                          │   AI Worker 层    │               │
│                          │ (异步消费任务)     │               │
│                          └────────┬─────────┘               │
│                                   │                          │
└───────────────────────────────────┼──────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
            ┌───────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐
            │  Dify 工作流  │ │  LLM 直调   │ │  向量检索   │
            │ (编排复杂流程) │ │ (GPT-4/通义) │ │ (RAG 知识库)│
            └──────────────┘ └────────────┘ └────────────┘
```

### 二、AI服务能力清单

| 能力编号 | 能力名称 | 应用场景 | 实现方式 | 优先级 |
|---------|---------|---------|---------|--------|
| AI-001 | 文档智能解析 | SOP/工单/考核标准解析 | Dify Workflow + LLM | P0 |
| AI-002 | 五级结构生成 | 图谱初稿自动生成 | 专用 Prompt + Few-shot | P0 |
| AI-003 | 知识点推导 | 基于技能点反向推导知识点 | RAG + LLM | P0 |
| AI-004 | 合规校验 | 政策和行业标准对标 | 规则引擎 + LLM | P0 |
| AI-005 | 缺口分析 | 教师/学生能力缺口识别 | 向量相似度 + 规则 | P1 |
| AI-006 | 课程联动生成 | 图谱→课程模块自动编排 | LLM + 规则引擎 | P1 |
| AI-007 | 教材框架生成 | 图谱→教材目录自动生成 | LLM + 模板 | P1 |
| AI-008 | 实训方案生成 | 图谱→实训项目自动设计 | LLM + 模板 | P1 |
| AI-009 | 企业推荐 | 根据专业推荐对口企业/岗位 | 向量检索 + 规则 | P2 |
| AI-010 | 操作描述生成 | 现场记录AI自动标注 | 多模态LLM | P2 |

---

### 三、AI服务详细设计

#### 3.1 AI-001: 文档智能解析服务

**服务入口：**
```
POST /api/v1/ai/parse-document
```

**Request:**
```json
{
  "fileId": "file_001",
  "fileUrl": "/uploads/field-tracking/ft_001/file_001.pdf",
  "fileType": "sop",
  "mimeType": "application/pdf",
  "context": {
    "planId": "ft_001",
    "enterprise": "比亚迪汽车有限公司",
    "jobTitle": "高压系统检测工程师",
    "industry": "新能源汽车"
  }
}
```

**AI 处理流程：**

```
1. 文档预处理
   ├── PDF → 文本提取 (PyPDF2/pdfplumber)
   ├── Word → 文本提取 (python-docx)
   ├── Excel → 结构化读取 (openpyxl)
   ├── 图片 → OCR (Tesseract/阿里云 OCR)
   └── 扫描件 → OCR + 版面分析

2. 文档理解 (LLM)
   ├── Prompt: 基于文档类型分发专用 System Prompt
   ├── SOP → 提取操作步骤、工具设备、安全规范、质量标准
   ├── 工单 → 提取维修任务、故障现象、处理步骤、关键工具
   └── 考核标准 → 提取技能要求、等级标准、考核方式

3. 结构化输出
   └── 转换为统一的技能要素 JSON Schema
```

**System Prompt (SOP解析)：**

```
你是一位职业教育领域的企业跟岗数据分析专家。你的任务是解析企业标准作业流程(SOP)文档，
提取与"五级分解体系"相关的结构化信息。

请按照以下结构提取信息：
1. 操作步骤（对应 L3 流程层）：每个步骤的名称、序号、所需工具/设备、安全规范
2. 技能要素（对应 L4 技能点层）：完成每个步骤所需的核心技能
3. 质量标准：每个步骤的验收标准和考核要求

输出要求：
- 使用 JSON 格式
- 每个提取项附注置信度（0-1）
- 保持与原文的可追溯性（标注页码/段落）

当前上下文：
- 企业：{enterprise}
- 岗位：{jobTitle}
- 行业：{industry}
```

**输出 Schema：**
```json
{
  "documentType": "sop",
  "title": "高压系统安全检测标准作业流程",
  "extractedData": {
    "workflows": [
      {
        "name": "高压断电操作流程",
        "sequence": 1,
        "steps": [
          {
            "stepNo": 1,
            "description": "佩戴绝缘手套和安全护目镜",
            "tools": ["绝缘手套", "安全护目镜"],
            "safetyNorms": ["GB/T 18384-2020"],
            "qualityStandard": "手套无破损，护目镜清洁",
            "confidence": 0.95,
            "sourceRef": "第3页第2段"
          }
        ],
        "extractedSkills": [
          {
            "name": "个人防护装备穿戴",
            "description": "能正确选择和穿戴高压作业防护装备",
            "confidence": 0.92
          }
        ]
      }
    ]
  },
  "metadata": {
    "totalPages": 15,
    "extractedWorkflows": 3,
    "extractedSkills": 8,
    "avgConfidence": 0.91
  }
}
```

**Dify Workflow 编排：**

```yaml
name: SOP文档解析工作流
nodes:
  - id: doc_preprocess
    type: code
    desc: 文档预处理（PDF/Word/Excel → 纯文本）

  - id: doc_chunk
    type: code
    desc: 长文档分块（按章节/页面，每块 < 4000 tokens）

  - id: extract_structure
    type: llm
    model: gpt-4o / qwen-max
    prompt_template: sop_extraction_prompt
    desc: LLM提取操作步骤和技能要素

  - id: merge_results
    type: code
    desc: 合并分块结果，去重，计算置信度

  - id: validate_output
    type: code
    desc: 校验输出Schema完整性

edges:
  - doc_preprocess → doc_chunk → extract_structure → merge_results → validate_output
```

---

#### 3.2 AI-002: 五级结构生成服务

**服务入口：**
```
POST /api/v1/ai/generate-map
```

**Request:**
```json
{
  "mapId": "cm_002",
  "name": "新能源汽车检测与维修技术能力图谱",
  "major": "新能源汽车检测与维修技术",
  "dataSources": {
    "fieldTrackingAnalysis": [
      {
        "planId": "ft_001",
        "structuredTree": [ ... ]
      }
    ],
    "uploadedDocuments": [
      { "fileId": "upload_001", "parsedResult": { ... } }
    ],
    "standardDocs": [
      { "id": "std_001", "name": "专业教学标准", "content": "..." }
    ],
    "templateData": null
  }
}
```

**AI 处理流程（六步）：**

```
Step 1: 数据融合
  输入：跟岗分析结果 + 上传文档解析结果 + 标准文档
  处理：合并所有数据源，建立统一的技能要素池
  输出：融合后的技能要素集合

Step 2: 项目聚类（L1）
  输入：技能要素集合
  处理：LLM 将相关技能要素聚类为企业典型项目
  Prompt：基于 Few-shot 示例，将技能要素按"企业真实生产/服务项目"聚类
  输出：项目列表 + 每个项目包含的技能要素

Step 3: 任务分解（L2）
  输入：每个项目下的技能要素
  处理：LLM 将技能要素进一步分组为具体工作任务
  规则：每个任务应有明确边界，标注前后依赖
  输出：任务列表 + 依赖关系

Step 4: 流程编排（L3）
  输入：每个任务下的技能要素
  处理：LLM 基于 SOP 数据编排标准作业流程
  规则：流程步骤应有序号，关联工具和安全规范
  输出：流程列表（含步骤序号、工具、安全规范）

Step 5: 技能提炼（L4）
  输入：每个流程下的技能要素
  处理：LLM 精炼技能点，设定熟练度等级和考核标准
  规则：技能点颗粒度适中（可在 2-4 课时内掌握）
  输出：技能点列表（含 proficiencyLevel, assessmentCriteria, tools）

Step 6: 知识推导（L5）
  输入：每个技能点
  处理：LLM 反向推导支撑知识点（按需供给原则）
  规则：标注 priority(core/supporting) + bloomLevel(Bloom认知层次)
  RAG：检索知识库，匹配行业标准和教学标准中的知识要求
  输出：知识点列表（含 priority, bloomLevel, reference）

Step 7（附加）: 合规校验
  输入：完整五级结构
  处理：规则引擎 + LLM 校验
  校验项：
    - L1 是否来源于企业真实项目
    - L2 是否有明确任务边界
    - L3 是否对应企业SOP
    - L4 是否有考核标准和来源追溯
    - L5 是否为必备知识（非冗余）+ 认知层次标注
  输出：合规报告 + 优化建议
```

**核心 Prompt (五级分解)：**

```
你是职业教育领域的能力图谱构建专家。请基于以下数据源，为"{major}"专业构建
"项目→任务→流程→技能点→知识点"五级分解式能力图谱。

## 政策要求
- 项目(L1)必须来源于企业真实生产/服务项目
- 任务(L2)需有明确边界和前后依赖关系
- 流程(L3)对应企业标准作业流程(SOP)
- 技能点(L4)来源于跟岗挖掘一手材料，需有考核标准
- 知识点(L5)仅包含支撑技能的必备知识，杜绝冗余

## Few-shot 示例
{few_shot_example}

## 输入数据
{data_sources}

## 输出要求
请输出严格符合以下 JSON Schema 的结构化数据：
{output_schema}

注意：
1. 技能点(L4)是最关键的层级，需包含：熟练度等级(1-5)、考核标准、所需工具
2. 知识点(L5)标注priority(core/supporting)和bloomLevel(remembering/understanding/application/analysis/synthesis/evaluation)
3. 每个节点标注confidence(0-1)表示AI生成的置信度
```

**输出 Schema：**
```json
{
  "projects": [
    {
      "name": "string",
      "source": "string (企业名称)",
      "confidence": 0.95,
      "tasks": [
        {
          "name": "string",
          "difficulty": "number (1-5)",
          "prerequisites": ["string"],
          "confidence": 0.93,
          "workflows": [
            {
              "name": "string",
              "sequence": 1,
              "tools": ["string"],
              "safetyNorms": ["string"],
              "confidence": 0.91,
              "skillPoints": [
                {
                  "name": "string",
                  "description": "string",
                  "proficiencyLevel": 4,
                  "assessmentCriteria": "string",
                  "tools": ["string"],
                  "sourceType": "field_tracking | standard | ai_deduced",
                  "confidence": 0.89,
                  "knowledgePoints": [
                    {
                      "name": "string",
                      "priority": "core | supporting",
                      "bloomLevel": "string",
                      "reference": "string",
                      "confidence": 0.87
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

---

#### 3.3 AI-003: 知识点推导服务

**服务入口：**
```
POST /api/v1/ai/deduce-knowledge
```

**Request:**
```json
{
  "skillPoint": {
    "id": "sp_001",
    "name": "高压互锁系统检测",
    "description": "能使用万用表检测各高压互锁点状态...",
    "proficiencyLevel": 4,
    "tools": ["绝缘万用表", "诊断仪"]
  },
  "context": {
    "major": "新能源汽车检测与维修技术",
    "projectName": "新能源汽车整车检测项目",
    "workflowName": "高压断电操作流程"
  }
}
```

**处理流程：**
```
1. RAG 检索
   ├── 向量检索知识库（教学标准、行业标准、教材目录）
   ├── 匹配与该技能点相关的知识领域
   └── 返回 Top-K 候选知识点

2. LLM 推导
   ├── Prompt：基于技能描述 + RAG 结果，推导必备知识点
   ├── 规则：只推导支撑技能的必备知识
   ├── 标注 priority（core=核心必备, supporting=辅助支撑）
   └── 标注 bloomLevel（Bloom认知层次）

3. 冗余检查
   ├── 对比同图谱其他技能点的知识点
   └── 标记重复/冗余知识点
```

**Response:**
```json
{
  "code": 200,
  "data": {
    "knowledgePoints": [
      {
        "name": "高压安全规范 (GB/T 18384-2020)",
        "priority": "core",
        "bloomLevel": "application",
        "subjectArea": "电气安全",
        "reference": "GB/T 18384-2020 第5章",
        "reason": "高压互锁检测必须严格遵守高压安全规范，属于核心必备知识",
        "confidence": 0.95
      },
      {
        "name": "互锁电路工作原理",
        "priority": "core",
        "bloomLevel": "understanding",
        "subjectArea": "电路原理",
        "reference": null,
        "reason": "理解互锁电路原理是执行检测操作的理论基础",
        "confidence": 0.92
      },
      {
        "name": "欧姆定律基础",
        "priority": "supporting",
        "bloomLevel": "remembering",
        "subjectArea": "基础物理",
        "reference": null,
        "reason": "万用表使用需要基本的电学知识作为支撑",
        "confidence": 0.85
      }
    ]
  }
}
```

---

#### 3.4 AI-004: 合规校验服务

**服务入口：**
```
POST /api/v1/ai/compliance-check
```

**Request:**
```json
{
  "mapId": "cm_001",
  "checkItems": ["structure", "source", "granularity", "bloom", "redundancy"]
}
```

**校验规则引擎：**

```yaml
rules:
  # 结构完整性
  - id: STRUCT_001
    name: "五级结构完整性"
    check: "每个项目下至少有1个任务，每个任务至少有1个流程..."
    severity: error

  - id: STRUCT_002
    name: "技能点不应为空"
    check: "每个流程下至少有1个技能点"
    severity: error

  - id: STRUCT_003
    name: "知识点不应为空"
    check: "每个技能点下至少有1个知识点"
    severity: warning

  # 数据来源
  - id: SOURCE_001
    name: "L1项目来源"
    check: "项目的source字段不为空，指向真实企业"
    severity: error

  - id: SOURCE_002
    name: "L4技能点来源"
    check: "技能点的sourceType为field_tracking或standard"
    severity: warning

  # 颗粒度
  - id: GRAIN_001
    name: "技能点颗粒度检查"
    check: "LLM判断技能点是否可在2-4课时内掌握"
    severity: info
    useAI: true

  # Bloom认知层次
  - id: BLOOM_001
    name: "知识点Bloom标注"
    check: "每个知识点的bloomLevel不为空"
    severity: warning

  # 冗余检查
  - id: REDUN_001
    name: "知识点冗余"
    check: "检测未被任何技能点实际引用的知识点"
    severity: info
```

---

#### 3.5 AI-005: 能力缺口分析服务

**服务入口：**
```
POST /api/v1/ai/gap-analysis
```

**处理流程：**
```
1. 获取目标图谱的全部技能点（含 proficiencyLevel）
2. 获取教师/学生的已有能力评估数据
3. 向量相似度匹配：将教师/学生技能与图谱技能点对齐
4. 计算差距：requiredLevel - currentLevel = gap
5. LLM 生成培训建议（method, duration, enterprise）
6. 输出能力画像 + 缺口报告 + 培训计划
```

---

#### 3.6 AI-006: 课程联动生成服务

**服务入口：**
```
POST /api/v1/ai/generate-courses
```

**处理流程：**
```
1. 解析图谱结构：提取所有 L2任务 和 L3流程
2. 聚类为课程模块：多个相关流程 → 一门课程
3. AI 编排课程序列：
   - 基于任务依赖关系确定先后顺序
   - 应用"实践先行"原则：实践→理论 顺序
4. 生成课程内容映射：每个课程模块关联对应的技能点和知识点
5. 计算学时分配：基于技能点数量和难度
```

**核心 Prompt：**
```
基于以下能力图谱结构，按照"实践先行"教学范式，将流程聚类为课程模块并编排教学顺序。

要求：
1. 每门课程覆盖1-3个工作流程
2. 课程序列遵循任务前后依赖关系
3. 每门课程先实践后理论
4. 输出课程名称、学时(实践+理论)、前置课程

图谱结构：
{map_structure}
```

---

#### 3.7 AI-010: 现场记录AI标注服务

**服务入口：**
```
POST /api/v1/ai/annotate-record
```

**Request:**
```json
{
  "recordId": "rec_001",
  "type": "photo",
  "textContent": "观察技师执行高压断电标准流程...",
  "imageUrls": ["/uploads/IMG_20260303_143000.jpg"],
  "context": {
    "planId": "ft_001",
    "enterprise": "比亚迪汽车有限公司",
    "jobTitle": "高压系统检测工程师"
  }
}
```

**处理流程：**
```
1. 如有图片/视频 → 多模态LLM识别操作内容
2. 结合文字描述 → 生成结构化操作描述
3. 自动提取技能点标注
4. 生成推荐标签
```

**Response:**
```json
{
  "code": 200,
  "data": {
    "operationDesc": "技师正在执行高压系统断电标准流程：步骤1-佩戴绝缘手套...",
    "skillPoints": ["高压断电操作", "安全防护装备使用"],
    "suggestedTags": ["高压安全", "断电流程", "SOP执行"],
    "confidence": 0.88
  }
}
```

---

### 四、AI服务技术要求

#### 4.1 LLM 选型建议

| 场景 | 推荐模型 | 备选 | 说明 |
|------|---------|------|------|
| 文档理解/结构化提取 | GPT-4o | 通义千问-Max | 需要强大的文档理解和结构化输出 |
| 五级分解生成 | GPT-4o | Claude-3.5 | 需要复杂推理+长上下文 |
| 知识点推导 | GPT-4o-mini | 通义千问-Plus | 难度适中，可用轻量模型 |
| 合规校验 | 规则引擎 + GPT-4o-mini | — | 规则引擎为主，LLM辅助判断边界情况 |
| 缺口分析 | 向量检索 + GPT-4o-mini | — | 计算为主，LLM用于生成建议文本 |
| 现场记录标注 | GPT-4o (多模态) | 通义千问-VL | 需要图片理解能力 |

#### 4.2 RAG知识库

| 知识库 | 内容 | 向量模型 | 更新频率 |
|--------|------|---------|---------|
| 教学标准库 | 各专业教学标准文档 | text-embedding-3-small | 年更 |
| 职业标准库 | 国家职业技能标准 | text-embedding-3-small | 年更 |
| 行业标准库 | 国标/行标（GB/T等） | text-embedding-3-small | 半年更 |
| 图谱模板库 | 已发布的优秀图谱 | text-embedding-3-small | 月更 |
| 企业数据库 | 合作企业信息和岗位 | text-embedding-3-small | 季度更 |

#### 4.3 Dify 工作流清单

| 工作流ID | 名称 | 触发方式 | 输入 | 输出 |
|---------|------|---------|------|------|
| wf_parse_sop | SOP文档解析 | API | 文档文件+上下文 | 结构化技能要素JSON |
| wf_parse_workorder | 工单文档解析 | API | 文档文件+上下文 | 结构化技能要素JSON |
| wf_parse_assessment | 考核标准解析 | API | 文档文件+上下文 | 结构化考核要素JSON |
| wf_generate_map | 五级图谱生成 | API | 融合数据源 | 完整五级结构JSON |
| wf_deduce_knowledge | 知识点推导 | API | 技能点+上下文 | 知识点列表 |
| wf_compliance_check | 合规校验 | API | 完整图谱 | 合规报告 |
| wf_generate_courses | 课程联动生成 | API | 图谱结构 | 课程模块列表 |
| wf_generate_textbook | 教材框架生成 | API | 图谱结构 | 教材章节框架 |
| wf_generate_training | 实训方案生成 | API | 图谱结构 | 实训项目列表 |
| wf_gap_analysis | 缺口分析 | API | 图谱+用户能力数据 | 缺口报告+培训计划 |
| wf_annotate_record | 现场记录标注 | API | 图文/视频+上下文 | 操作描述+技能标注 |