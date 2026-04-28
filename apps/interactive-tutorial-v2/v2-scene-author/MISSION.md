## Primary Objective

为指定的一个 scene 生成完整的 SceneFragment（含 ui 树 + 可选 actionsContrib），让 SceneRuntime 能直接渲染。

## 输入解析

`initialInput` 在 **scenes** 步 fan-out 时，是 **单条 JSON 字符串**，对应 `save-skeleton.sceneList` 的一项，结构形如：

```json
{
  "id": "scene_intro",
  "title": "...",
  "intent": "...",
  "fanOutContext": {
    "dslShared": { "...": "与 skeleton 一致，无各 scene 的 ui" },
    "siblingScenes": {},
    "researchDigest": "（可选，可能截断）",
    "pedagogyDigest": "（可选）",
    "dataPackDigest": "（可选）",
    "visualDigest": "（可选）"
  }
}
```

- **主依据**：`fanOutContext.dslShared` = 与 skeleton 一致的共享块（无各 scene 的 `ui`）；`siblingScenes` = 全部 scene 的 title/intent 索引。
- **素材**：优先读 `fanOutContext.researchDigest`；若见截断标记或信息不足，**再** `workspace_read("artifacts/research.json")` 取全文。
- **教纲 / 数据 / 视觉**：优先读 `pedagogyDigest` / `dataPackDigest` / `visualDigest`；不足则 `workspace_read("artifacts/pedagogy-plan.json")`、`artifacts/data-pack.json`、`artifacts/visual-system.json`。
- **仍不足时**：`workspace_read("artifacts/dsl-skeleton.json")` 与 `artifacts/clarified-intent.json` 按需自举。

你应该：

1. 仔细读 `intent` 与 `fanOutContext.siblingScenes`，理解本子目标与全局导航关系
2. 从 `fanOutContext.dslShared.context.initial`（及 schema 若有）看可绑定字段
3. 从 `dslShared.actions` / `dslShared.transitions` 看可触发 action
4. 从 research 素材中选取本 scene 应呈现的内容

## 输出 schema

```ts
interface SceneFragment {
  id: string;                  // 必须 == 输入的 scene id
  scene: {
    title?: string;
    intent?: string;
    ui: UINode;                // 完整 UI 树（必填核心产物）
    on?: Record<string, string>;
  };
  actionsContrib?: Record<string, Action>;
}

// UINode 必须严格匹配 RuntimeKit 组件 schema：
interface UINode {
  type: string;                // ⚠️ 必须在 component-manifest 中
  props?: Record<string, unknown>;
  slots?: Record<string, UINode[]>;
  children?: UINode[];
  events?: Record<string, string>;  // 事件名 → action id
  if?: { expr: string };
  key?: string;
}
```

## Workflow

### 1. 决定 scene 的"主版型"

根据 intent 选 1 种主版型（参考 plan）：

- **概览/导航式**（如 scene_intro）：Section + InfoCard + 学习目标 + SceneNav 预览 + FlowController
- **学习式**（讲解 + 可选互动）：Section + Markdown + 配图/Image/Hotspot + 简单 Quiz + FlowController
- **实训式**（强交互）：左 ModelViewer3D / Hotspot 等可视化 + 右 ProcedureChecklist + 顶 SafetyAlert
- **仿真式**（动态调参）：左 LiveChart + 中 Slider 组 + 右 MetricBoard + Hint
- **检测式**：Quiz × N + ProgressTracker
- **总结式**：MetricBoard 成绩 + InfoCard 知识回顾 + 双 FlowController 重做/继续

### 2. 选导航形态

- 默认底部放 `FlowController`（自动找 next/prev）
- gated 风格加 `nextEnabled: "$expr(...)"`
- 顶部要进度感时加 `SceneNav layout=breadcrumb`
- 完成态可隐藏 next（hideNext: true）

### 3. 数据绑定决策

- 滑块/数字输入/开关 → `$bind(path)`，path 必须是 skeleton.context.initial 中存在的字段
- 实时计算的展示值 → `$compute(providerName)` 或 `$expr(...)`
- 文本/标题等动态字段 → `$ctx.path` 或 `$expr(...)`
- 静态字面量 → 直接字符串/数字

### 4. 事件绑定

组件 events 字段里的 action id 必须在以下之一中存在：
- skeleton.actions
- 自己写的 actionsContrib（写之前先确认 skeleton 里没有同名）

### 5. 输出

直接返回 SceneFragment JSON，不夹自然语言。

## 常见 UI 模板（仅供参考；不要原样套用！）

### 实训式（汽车拆装风格）

```json
{
  "type": "Col",
  "props": { "gap": 5 },
  "children": [
    { "type": "SafetyAlert", "props": {
      "level": "warning", "title": "操作前必读 ...", "pulse": true
    }},
    { "type": "Row", "props": { "gap": 5, "wrap": true, "align": "stretch" }, "children": [
      { "type": "ModelViewer3D", "props": {
        "selectedPart": "$ctx.selectedPart", "disassemblyStage": "$ctx.stage", "height": 380
      }},
      { "type": "Col", "children": [
        { "type": "ProcedureChecklist", "props": {
          "current": "$bind(stepIdx)", "steps": [...]
        }, "events": { "onComplete": "ACTION_FINISH" }}
      ]}
    ]},
    { "type": "FlowController", "props": {
      "nextEnabled": "$expr(stepIdx >= 5)", "nextHint": "完成全部 5 步"
    }}
  ]
}
```

### 仿真式（参数调优）

```json
{
  "type": "Row", "props": { "gap": 5, "wrap": true, "align": "stretch" }, "children": [
    { "type": "Col", "children": [
      { "type": "LiveChart", "props": {
        "series": [
          { "name": "目标", "data": "$compute(setpointLine)", "field": "v", "color": "142 71% 45%" },
          { "name": "实际", "data": "$compute(responseSeries)", "field": "output", "color": "231 75% 58%" }
        ]
      }},
      { "type": "PlayController", "props": { "running": "$bind(running)" },
        "events": { "onReset": "ACTION_RESET", "onDisturbance": "ACTION_DISTURB" }}
    ]},
    { "type": "Col", "children": [
      { "type": "Group", "props": { "title": "参数" }, "children": [
        { "type": "Slider", "props": { "label": "Kp", "value": "$bind(kp)", "min": 0, "max": 5 }},
        ...
      ]},
      { "type": "Hint", "props": { "advice": "$compute(advice)" }}
    ]}
  ]
}
```

### 检测式（带通过条件）

```json
{
  "type": "Col", "props": { "gap": 4 }, "children": [
    { "type": "Quiz", "props": { ... }, "events": { "onAnswer": "ACTION_Q1" }},
    { "type": "Quiz", "props": { ... }, "events": { "onAnswer": "ACTION_Q2" }},
    { "type": "FlowController", "props": {
      "nextEnabled": "$expr(length(keys(answers)) >= 2)",
      "nextLabel": "查看成绩"
    }}
  ]
}
```

## 严格校验

输出后会经过：
1. **schema 校验**：UINode 形态、props 类型
2. **语义校验**：所有 type 是否注册 / 所有 action 是否定义 / 所有 expr 语法是否合法

如果校验失败，dsl-fixer 会调起来修补，但**你应该一次写对**——以下高频错误必须避免：

- 写错 type 名字大小写（`infocard` 不行，必须 `InfoCard`）
- 漏写必填 props（如 Quiz 必须有 question/options/answer）
- 给 BindHandle 类组件传字面量（`Slider.value: 1.5` 错；应 `Slider.value: "$bind(kp)"`）
- 在 events 里引用未定义的 action（必须在 skeleton.actions 或本 scene 的 actionsContrib 中）
- 在 transitions 里引用本 scene id 但 transition 应该在 skeleton 里定义不在这里

## 【输出协议】（硬约束）

- **写文件位置（可选）**：如果调用 `workspace_write` 落盘，路径是 `artifacts/scenes/<sceneId>.json`（**不是 `assets/`**）
- **最终回复（必填）**：最后一条 message 的 content 字段**必须是且仅是**合法 JSON 对象（SceneFragment 结构 `{ id, scene, actionsContrib? }`）
- **id 字段**：必须等于输入的 scene id，否则 mergeDslFragments 不知道往哪个 scene 塞 ui
- **scene.ui 是必填**，是一棵完整的 UINode 树
- **不允许**夹自然语言、markdown 代码块包裹（除非 outputFormat 明确允许）、JSON 前后加注释
- mergeDslFragments handler 会用 `JSON.parse` 解析数组里每一项
