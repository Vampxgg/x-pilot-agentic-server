/**
 * Prompt Injection —— 把 DSL schema 真理来源塞进 LLM prompt。
 *
 * 解决的问题：v2 agent prompt 文件里只能描述"思路"，无法把 32 个组件的精确 props
 * 与 7 种 action type 完整字段塞进 markdown 又保持同步。如果 LLM 凭直觉猜，必然出现
 * `props.url`（应该是 `src`）、`type: "mutate"`（应该是 `set_context`）这类错误。
 *
 * 方案：v2 的 start_dsl_pipeline tool 在拼接 brief 时调用 buildSchemaReference()（= 管线专用包），
 * 内含「分阶段」说明，减轻 blueprint（无 scene.ui）与终态 DSL 的矛盾。pipeline-executor 对每步
 * 复用同一条 initialInput，故字典需自洽且尽量紧凑。
 *
 * 维护成本：与 component-manifest.ts 同步即可（注入函数读 manifest 实时生成）。
 */

import { manifestDetailedForPrompt, manifestNamesForPrompt } from "./component-manifest.js";

/** 管线共用 schema 包（start_dsl_pipeline 注入；含分阶段说明 + 中性输出 footer） */
export function buildSchemaReference(): string {
  return buildSchemaReferenceForPipeline();
}

export function buildSchemaReferenceForPipeline(): string {
  return [
    SECTION_HEADER_PIPELINE,
    DSL_PIPELINE_STAGES,
    DSL_TOPLEVEL_REFERENCE,
    ACTION_REFERENCE,
    PLACEHOLDER_REFERENCE,
    NAMING_CONVENTIONS,
    COMPONENTS_HEADER,
    manifestDetailedForPrompt(),
    SECTION_FOOTER_NEUTRAL,
  ].join("\n\n");
}

/** 简短 schema reference（用于 token 紧张的 sub-agent，只列组件名） */
export function buildSchemaReferenceCompact(): string {
  return [
    "## 可用组件名（type 字段必须从此列表中选）",
    manifestNamesForPrompt(),
    "",
    PLACEHOLDER_REFERENCE,
  ].join("\n");
}

/** 供子智能体或脚本按需裁剪 token；管线共用仍用 buildSchemaReference() */
export type SchemaPackRole = "pipeline" | "artifactPlanner" | "compact";

export function buildSchemaPackForRole(role: SchemaPackRole): string {
  if (role === "pipeline") return buildSchemaReferenceForPipeline();
  if (role === "compact") return buildSchemaReferenceCompact();
  return [
    SECTION_HEADER_PIPELINE,
    DSL_PIPELINE_STAGES,
    DSL_TOPLEVEL_REFERENCE,
    PLACEHOLDER_REFERENCE,
    NAMING_CONVENTIONS,
    "## 可用组件名（本步不产出 scene.ui，仅需知晓命名空间）",
    manifestNamesForPrompt(),
    SECTION_FOOTER_NEUTRAL,
  ].join("\n\n");
}

// ─────────────────────────────────────────────────────────
// 各 section 内容
// ─────────────────────────────────────────────────────────

const SECTION_HEADER_PIPELINE = `# 【DSL Schema Reference】（必读 · 真理来源）

> 以下是 v2 DSL 的硬约束。你看到的所有 prompt 描述都基于这份 schema。
> 任何与下文不一致的字段名、类型枚举、组件名都会被 dsl-validator 拒绝。
> **遇到拿不准的字段名/类型时，回到这里查，不要猜。**
>
> **重要**：同一条 initialInput 会出现在 clarify / research / blueprint / scenes 各步；各步产出形态不同，请先读 **「流水线分阶段」** 再写 JSON。`;

const DSL_PIPELINE_STAGES = `## 流水线分阶段（必读）

| 阶段 | 你的任务 | scenes 字段 |
|------|----------|-------------|
| **clarify** | 输出 ClarifiedIntent JSON | 不涉及 |
| **research** | 输出 ResearchPack JSON → \`artifacts/research.json\` | 不涉及 |
| **pedagogy** | 输出 PedagogyPlan JSON → \`artifacts/pedagogy-plan.json\` | 不涉及 |
| **data-pack** | 输出 DataPack JSON → \`artifacts/data-pack.json\`（每条含 \`useInScenes\`） | 不涉及 |
| **visual** | 输出 VisualSystem JSON → \`artifacts/visual-system.json\`（\`shell\` + \`theme\` + \`layoutRationale\`） | 不涉及 |
| **blueprint** | 输出 DslSkeleton JSON：合并 visual 到 \`app\`；含 \`context\` / \`flow\` / \`actions\` / \`transitions\` / \`tick?\` / \`computed?\`；读 pedagogy + data-pack；\`scenes[id]\` **只能**含 \`title?\` 与 **必填** \`intent\`，**禁止** \`ui\` | 仅 title + intent |
| **scenes（fan-out）** | 输出 SceneFragment：为本 scene 写 **\`scene.ui\` 树**；\`fanOutContext\` 含 research/pedagogy/data/visual **digest** | 仅在本 fragment 里填 ui |
| **merge 之后** | 完整 DSL 每个 scene **必须**含合法 \`ui\` | 终态 |

blueprint 若写出 \`scene.ui\` 会导致后续合并与校验混乱，**视为错误**。scene-author 只输出 \`{ id, scene: { ui, ... }, actionsContrib? }\`。`;

const DSL_TOPLEVEL_REFERENCE = `## DSL 顶层结构

\`\`\`ts
{
  version: "1.1",
  app: {
    id: string,                     // kebab-case 唯一
    name: string,
    description?: string,
    shell?: {
      layout?: "centered" | "full" | "plain" | "workspace",
      header?: boolean | { brand?, progress? },
      maxWidth?: "narrow" | "normal" | "wide" | "full" | string,
      padding?: "none" | "sm" | "md" | "lg",
    },
    theme?: {
      preset: "edu-light" | "tech-blue" | "notion-warm" | "industrial" | "kid-vivid" | "academic" | "minimal",
      tokens?: { [cssVar]: string }
    }
  },
  context: {
    schema?: { [field]: any },     // 字段说明
    initial: { [field]: any }      // 初始值（必填）
  },
  scenes: {
    [sceneId]: {
      title?: string,
      intent?: string,             // 设计意图（给下游 scene-author）
      // blueprint 阶段：不要写 ui。scene-author 完成后：每个 scene 必须有 ui（UINode）
      ui?: UINode,
      on?: { [event]: actionId }
    }
  },
  actions: { [actionId]: Action },
  transitions: [
    { from: sceneId | "*", action: actionId, to: sceneId, condition?: { expr } }
  ],
  flow: { initial: sceneId, completion?: sceneId },
  tick?: { intervalMs: number, action: actionId, autoStart: boolean, runningPath: string },
  computed?: { [name]: { provider: string, description?: string } }
}
\`\`\`

## UINode（scene.ui 的递归节点）

\`\`\`ts
{
  type: string,                    // ⚠️ 必须在下方 32 个组件名中
  props?: { [k]: any },            // 字段名与组件 manifest 严格一致；支持占位符
  slots?: { [name]: UINode[] },    // 命名插槽
  children?: UINode[],             // 子节点
  events?: { [eventName]: actionId }, // 必须在 actions 中存在
  if?: { expr: string },           // 条件渲染
  key?: string                     // diff 稳定 key
}
\`\`\``;

const ACTION_REFERENCE = `## Action 完整规范

> ⚠️ \`type\` **只能**是这 7 种，**禁止**自创 \`mutate\` / \`updateContext\` / \`update\` 等。

### 1. set_context
更新 context 路径。**所有"修改 context 字段"的语义都用这个**（不是 mutate / updateContext）。
\`\`\`json
{ "type": "set_context", "path": "score", "value": 100 }
{ "type": "set_context", "path": "answers.q1", "value": true }
{ "type": "set_context", "path": "score", "value": "$expr(score + 10)" }
\`\`\`

### 2. navigate
切换 scene。**字段是 \`to\` 不是 \`transition\` / \`scene\` / \`target\`。**
\`\`\`json
{ "type": "navigate", "to": "scene_quiz" }
\`\`\`

### 3. emit
发学习行为埋点（progress / score / attempt）。
\`\`\`json
{ "type": "emit", "event": "quiz_answered", "payload": { "correct": true } }
\`\`\`

### 4. api_call
调用宿主 API（评测、AI 解析、检索）。
\`\`\`json
{ "type": "api_call", "url": "/api/score", "method": "POST", "body": {...},
  "onSuccess": "ACTION_OK", "onError": "ACTION_FAIL" }
\`\`\`

### 5. custom_widget
触发某个组件实例的命令式方法。
\`\`\`json
{ "type": "custom_widget", "target": "physicsCanvas", "method": "reset", "args": [] }
\`\`\`

### 6. compute_step
执行一帧仿真步进（pid / 物理 / 自定义）。配合 \`tick\` 使用。
\`\`\`json
{ "type": "compute_step", "provider": "pidStepProvider" }
\`\`\`

### 7. compound
顺序执行多个 op（最常用，几乎所有"多步动作"都是 compound）。
\`\`\`json
{
  "type": "compound",
  "ops": [
    { "type": "set_context", "path": "score", "value": "$expr(score + 10)" },
    { "type": "navigate", "to": "scene_done" }
  ]
}
\`\`\`

**Action 设计模式**：用户答题这种"多步副作用"，几乎都用 compound 包一组 set_context + navigate / emit。`;

const PLACEHOLDER_REFERENCE = `## 占位符语法

仅当 prop 字面值为字符串且匹配下列模式时，PropResolver 会做特殊处理：

| 占位符 | 语义 | 例 |
|---|---|---|
| \`"$ctx.path"\` | 读 context 路径（只读） | \`"$ctx.score"\` |
| \`"$expr(...)"\` | 受限表达式求值（只读） | \`"$expr(score >= 60 ? 'success' : 'warning')"\` |
| \`"$bind(path)"\` | **双向绑定** BindHandle（仿真控件用） | \`"$bind(kp)"\` |
| \`"$compute(name)"\` | 调用注册的派生计算 provider | \`"$compute(pidSeries)"\` |

### 关键规则

- **数字 / 布尔等非字符串**直接写字面量，不需要占位符：\`"min": 0\` \`"hidePrev": true\`
- **静态字符串**直接写：\`"title": "PID 调参"\`
- **动态读取 context 字段**用 \`"$ctx.path"\` 或 \`"$expr(path)"\`
- **可拖动的输入控件**（Slider / NumberInput / Dial / PlayController.running / PartTree.selected / ProcedureChecklist.current）的核心 value 字段**必须**用 \`"$bind(path)"\`
- **派生数据**（图表 series、指标面板、AI 反馈）用 \`"$compute(providerName)"\`

### ExpressionVM 支持的语法

字面量、点路径（\`a.b.c\` \`a?.b\`）、二元运算（\`==\` \`!=\` \`<\` \`>=\` \`&&\` \`||\` \`+\` \`-\` \`*\` \`/\` \`%\`）、一元（\`!x\` \`-x\`）、三元（\`a ? b : c\`）、内置函数白名单（\`max min round floor ceil abs length some every includes keys values\`）、数组与对象字面量。

**禁用**：任意函数定义、\`=>\`、模板字符串、正则、\`new\`、\`this\`、\`window\`、\`document\`。`;

const NAMING_CONVENTIONS = `## 命名约定

- \`app.id\`：kebab-case（\`engine-disassembly-training\`）
- \`scene id\`：snake_case + \`scene_\` 前缀（\`scene_intro\`、\`scene_quiz\`）
- \`action id\`：SCREAMING_SNAKE_CASE + \`ACTION_\` 前缀（\`ACTION_NEXT\`、\`ACTION_SUBMIT_QUIZ\`）
- \`context 字段\`：camelCase（\`stepIdx\`、\`userScore\`、\`running\`）
- \`computed provider\`：camelCase（\`pidSeries\`、\`ohmCurrent\`、\`pidAdvice\`）`;

const COMPONENTS_HEADER = `## 32 个可用组件（type 与 props **必须严格匹配**）

> 下面是每个组件的精确签名。**写 \`type\` 必须用名字**（包括大小写）。
> **写 \`props\` 必须用下文列出的字段名**——任何编造的字段会被 schema 校验拒绝。
> 高频错误警示：
> - \`Image\` 的字段是 \`src\` 不是 \`url\`，\`fit\` 不是 \`objectFit\`
> - \`InfoCard\` 的字段是 \`intent\` 不是 \`variant\`
> - \`Quiz\` 的 \`answer\` 是 \`string\` 或 \`string[]\`，**不是数字下标**
> - \`MetricBoard\` 的字段是 \`metrics\` 不是 \`items\`
> - \`Section\` **没有** \`icon\` / \`level\` 字段`;

const SECTION_FOOTER_NEUTRAL = `---

## 输出强约束

- 你的最后一条 message 的 content 字段必须是**纯 JSON**，不夹自然语言、不包 markdown 代码块、不加注释
- **若你拥有 \`workspace_write\` 工具**：需持久化的结构化结果写到 \`artifacts/\`（**不要写 \`assets/\`**）
- **若你没有任何写盘工具**：不要声称已写入 workspace；仅输出纯 JSON 即可
- 组件名/props 拿不准时回到上文 manifest 查，不要猜`;
