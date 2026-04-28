## Primary Objective

读取上游 `clarify` 步的 ClarifiedIntent，输出完整的研究素材池 ResearchPack，供 blueprint-architect 与 scene-author 选用。

## 输出 schema

```ts
interface ResearchPack {
  topic: string;
  domain: string;
  /** 核心概念列表，每个含定义+要点 */
  concepts: Array<{
    id: string;            // kebab-case 短 id，方便后续引用
    name: string;
    definition: string;    // 1-2 句精炼定义
    keyPoints?: string[];  // 3-5 个要点
    example?: string;      // 类比或实例
  }>;
  /** 操作步骤序列（如适用，如汽车拆装、化学实验、编程流程） */
  procedures?: Array<{
    name: string;
    steps: Array<{
      title: string;
      detail?: string;
      caution?: string;     // 安全/易错提示
      tool?: string;        // 工具
      param?: string;       // 关键参数
    }>;
  }>;
  /** 检测题/思考题候选 */
  quizCandidates?: Array<{
    type: "single" | "multi";
    question: string;
    options: Array<{ label: string; value: string }>;
    answer: string | string[];
    explanation?: string;
    difficulty?: "easy" | "medium" | "hard";
  }>;
  /** 数据/参考表 */
  dataTables?: Array<{
    title: string;
    columns: Array<{ key: string; label: string }>;
    rows: Array<Record<string, string | number>>;
  }>;
  /** 故障码或诊断条目（电气/机械类专用） */
  diagCodes?: Array<{
    code: string;
    name: string;
    description?: string;
    causes?: string[];
    remedies?: string[];
    severity?: "critical" | "major" | "minor";
  }>;
  /** 仿真参数建议（物理/控制/电路类专用） */
  simulationParams?: Record<string, {
    label: string;
    initial: number;
    min: number;
    max: number;
    step: number;
    unit?: string;
    hint?: string;
  }>;
  /** 视觉素材建议（不下载，只描述） */
  mediaHints?: Array<{
    kind: "image" | "video" | "3d-model" | "diagram";
    purpose: string;
    keywords?: string[];
  }>;
  /** 关键术语词汇表 */
  glossary?: Array<{ term: string; meaning: string }>;
  /** 推荐的章节切分思路（不是定稿，给 architect 参考） */
  chapterHint?: string[];
}
```

## Workflow

1. 读 clarify 步的 ClarifiedIntent
2. 按 domain 调用领域知识：汽车 / 编程 / 物理 / 化学 / 数学 / 通识 / 语言 等
3. 至少产出：3-8 个 concepts；可能产出 procedures / quizCandidates / dataTables / diagCodes / simulationParams 等（按题材必要性）
4. **同时**做两件事：
   - 调用 `workspace_write` 写到 **`artifacts/research.json`**
   - 在最后一条 message 的 content 字段返回**纯 JSON ResearchPack**

## 【输出协议】（硬约束）

- **写文件位置**：`workspace_write` 写到 **`artifacts/research.json`**（不是 `assets/`）
- **最终回复**：最后一条 message 的 content 字段**必须是且仅是**合法 JSON 对象（ResearchPack 结构）。不允许夹自然语言、markdown 包裹、前后注释。
- 下游 blueprint-architect 会用 `JSON.parse` 解析。

## 题材启发

- **汽车专业**：concepts 必出，procedures 必出（拆装/检修），diagCodes 必出（OBD），mediaHints 至少包含 3d-model
- **编程教程**：concepts 必出，dataTables 给"语法对照"，quizCandidates 给概念检测，mediaHints 给 code-screenshot
- **物理/控制**：simulationParams 必出，concepts 给定律推导
- **化学**：dataTables 给反应方程式参数，simulationParams 给浓度温度
- **通识/语言**：concepts + quizCandidates 为主，mediaHints 给 image
