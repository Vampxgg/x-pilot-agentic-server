# DSL Schema v1.1（v2 单一可信源）

## Skeleton 与终态 DSL（必读）

- **Blueprint / `save-skeleton` 产物**：`scenes[id]` **仅**含 `title?` 与 `intent`（**不要**写 `ui`）。见 `artifacts/dsl-skeleton.json`。
- **Scene-author fan-out 合并后**：每个 `scenes[id]` **必须**含可渲染的 `ui`（`UINode` 树）。合并结果见 `artifacts/dsl-merged.json` / 发布的 `dsl.json`。
- **运行时校验**以 [`code/dsl/schema.ts`](./code/dsl/schema.ts) 与 `component-manifest` 为准；本文档描述终态形状；流水线早期步请遵守上表。

## Artifact 链与 SceneRuntime 消费（v2 编排）

| 阶段 | Workspace 产物 | SceneRuntime 相关字段（由 blueprint / scene-author 落地） |
|------|------------------|-------------------------------------------------------------|
| research | `artifacts/research.json` | 间接：进入 `scene.intent` 与 UI 文案素材 |
| pedagogy | `artifacts/pedagogy-plan.json` | 教学目标 → `scenes[].intent`、交互深度 |
| data-pack | `artifacts/data-pack.json` | `context.initial`、组件 props（经 `$ctx` / 静态字段） |
| visual | `artifacts/visual-system.json` | `app.shell`、`app.theme` |
| blueprint | `artifacts/dsl-skeleton.json` | `app`（合并 visual）、`context`、`flow`、`actions`、`transitions`、`tick`、`computed`、各 scene 的 `title`/`intent`（无 `ui`） |
| scenes + merge | `artifacts/dsl-merged.json` / `dsl.json` | 补全每 scene 的 `ui`；终态与下文章节「顶层结构」一致 |

`save-skeleton` handler 在 fan-out 项上附带 `fanOutContext`：**`researchDigest`、`pedagogyDigest`、`dataPackDigest`、`visualDigest`**（可能截断）+ `dslShared`；scene-author 应 **`workspace_read`** 上述 artifact 获取全文。

语义校验器（[`code/dsl/validator.ts`](./code/dsl/validator.ts)）在 `semanticRichness: true` 时额外产出 **warning**：浅 UI 树、仅排版壳组件、`context.initial` 字段在 UI 中未见 `$ctx.<field>` 引用等（不阻塞发布，供迭代与 dsl-fixer 参考）。

---

> **本文档是所有 v2 智能体生成 DSL 时的硬约束。** 任何对组件名/props/字段名的更改，必须同步更新：
> - `code/dsl/schema.ts`（Node 端 zod）
> - `code/dsl/component-manifest.ts`（组件清单）
> - `react-code-rander/src/runtime/dsl/schema.ts`（浏览器端 zod）
> - `react-code-rander/src/runtime-kit/**/index.ts`（manifest 注册）
>
> 三者任一不一致，运行时校验会失败。

---

## 顶层结构

```typescript
{
  version: "1.1",
  app: {
    id: string,                 // kebab-case 唯一标识
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
      tokens?: { [cssVarName]: string }   // 局部覆盖 CSS variables
    }
  },
  context: {
    schema?: { [field]: any },   // 字段说明（给 LLM 看）
    initial: { [field]: any }    // 初始值（必填）
  },
  scenes: {
    [sceneId]: {
      title?: string,
      intent?: string,
      ui: UINode,                // 必填
      on?: { [eventName]: actionId }
    }
  },
  actions: {
    [actionId]: ActionOp | { type: "compound", ops: ActionOp[] }
  },
  transitions: [
    { from: sceneId | "*", action: actionId, to: sceneId, condition?: { expr } }
  ],
  flow: { initial: sceneId, completion?: sceneId },
  tick?: { intervalMs: number, action: actionId, autoStart: boolean, runningPath: string },
  computed?: { [name]: { provider: string, description?: string } }
}
```

## UINode

```typescript
{
  type: string,              // ⚠️ 必须在组件清单中（详见下文）
  props?: { [k]: any },      // 支持占位符 $ctx / $expr / $bind / $compute
  slots?: { [name]: UINode[] },
  children?: UINode[],
  events?: { [eventName]: actionId },
  if?: { expr: string },     // 条件渲染
  key?: string               // 列表/diff 稳定 key
}
```

## 占位符（仅当 prop 字面值为字符串且匹配下列正则时生效）

| 占位符 | 语义 | 例 |
|---|---|---|
| `$ctx.path` | 读 context 路径（只读） | `"$ctx.score"` |
| `$expr(...)` | 受限表达式求值（只读） | `"$expr(score >= 60 ? 'success' : 'warning')"` |
| `$bind(path)` | 双向绑定 BindHandle（仿真控件用） | `"$bind(kp)"` |
| `$compute(name)` | 调用注册的派生计算 provider | `"$compute(pidSeries)"` |

## Action Ops

```typescript
type ActionOp =
  | { type: "set_context", path: string, value: any }
  | { type: "navigate", to: sceneId }
  | { type: "emit", event: string, payload?: object }
  | { type: "api_call", url: string, method?, body?, onSuccess?, onError? }
  | { type: "custom_widget", target: string, method: string, args?: any[] }
  | { type: "compute_step", provider: string, description? }   // 仿真 step
```

## ExpressionVM 支持的表达式语法

- 字面量：数字 / 字符串 / true / false / null / undefined
- 标识符路径：`context.score` / `event.value` / `scene.id`（点路径 + 可选 `?.`）
- 二元运算：`==` `!=` `===` `!==` `<` `<=` `>` `>=` `&&` `||` `+` `-` `*` `/` `%`
- 一元：`!x` `-x` `+x`
- 三元：`a ? b : c`
- 内置函数（白名单）：`max` `min` `round` `floor` `ceil` `abs` `length` `some` `every` `includes` `keys` `values`
- 数组/对象字面量

**禁用**：任意函数定义、`=>`、模板字符串、正则、`new`、`this`、`window`、`document`、`prototype`、`constructor`

---

## 32 个可用组件（component-manifest 摘要）

> **完整规范见 [code/dsl/component-manifest.ts](./code/dsl/component-manifest.ts)**

### 容器（layout / containers）

`Section` `Container` `Row` `Col` `Group` `Tabs` `Canvas` `SplitPane` `Floating` `Layer` `Spacer` `Divider`

### 内容/反馈（display / guide）

`InfoCard` `Callout` `SafetyAlert` `StepGuide` `MetricBoard` `Hint` `Markdown` `CodeBlock` `Formula` `DataTable` `Timeline`

### 交互（interaction）

`Selection` `Quiz` `ToggleReveal` `NumberInput` `Dial` `Slider` `MatchingPairs` `DragSort`

### 媒体（media）

`Image` `Hotspot` `Video` `LiveChart` `Schematic` `CircuitDiagram` `ModelViewer3D`

### 汽车专业（auto）

`PartTree` `ProcedureChecklist` `DiagPanel`

### 仿真控制 / 导航（sim / nav）

`PlayController` `FlowController` `SceneNav`

---

## 完整示例（PID 调参单 scene 仿真）

```json
{
  "version": "1.1",
  "app": {
    "id": "pid-workbench",
    "name": "PID 调参工作台",
    "shell": { "layout": "centered", "maxWidth": "wide", "header": { "brand": { "icon": "📈" }, "progress": false } },
    "theme": { "preset": "tech-blue" }
  },
  "context": {
    "initial": {
      "kp": 1.2, "ki": 0.0, "kd": 0.0, "setpoint": 1.0,
      "running": false, "disturbance": 0,
      "series": [],
      "simState": { "output": 0, "integral": 0, "prevError": 0, "time": 0, "control": 0, "error": 0 }
    }
  },
  "tick": {
    "intervalMs": 50, "action": "ACTION_TICK",
    "autoStart": false, "runningPath": "running"
  },
  "scenes": {
    "scene_lab": {
      "title": "调参实验台",
      "intent": "用户调 P/I/D 三个参数实时看响应曲线",
      "ui": {
        "type": "Row", "props": { "gap": 5, "wrap": true, "align": "stretch" },
        "children": [
          { "type": "Col", "children": [
            { "type": "LiveChart", "props": {
              "title": "系统响应", "windowSec": 12, "yMin": -0.3, "yMax": 1.8, "height": 280,
              "series": [
                { "name": "目标", "data": "$compute(pidSetpointLine)", "field": "v", "color": "142 71% 45%", "dashed": true },
                { "name": "实际", "data": "$compute(pidSeries)", "field": "output", "color": "231 75% 58%" }
              ]
            }},
            { "type": "PlayController", "props": { "running": "$bind(running)", "elapsed": "$expr(round(simState.time * 10) / 10)" },
              "events": { "onReset": "ACTION_RESET", "onDisturbance": "ACTION_DISTURB" }},
            { "type": "MetricBoard", "props": { "metrics": "$compute(pidMetricsBoard)", "columns": 4 } }
          ]},
          { "type": "Col", "children": [
            { "type": "Group", "props": { "title": "PID 参数" }, "children": [
              { "type": "Slider", "props": { "label": "Kp", "value": "$bind(kp)", "min": 0, "max": 5, "step": 0.05 }},
              { "type": "Slider", "props": { "label": "Ki", "value": "$bind(ki)", "min": 0, "max": 3, "step": 0.02 }},
              { "type": "Slider", "props": { "label": "Kd", "value": "$bind(kd)", "min": 0, "max": 1, "step": 0.01 }}
            ]},
            { "type": "Hint", "props": { "advice": "$compute(pidAdvice)" }}
          ]}
        ]
      }
    }
  },
  "actions": {
    "ACTION_TICK": { "type": "compute_step", "provider": "pidStepProvider" },
    "ACTION_RESET": { "type": "compound", "ops": [
      { "type": "set_context", "path": "running", "value": false },
      { "type": "set_context", "path": "series", "value": [] },
      { "type": "set_context", "path": "simState", "value": {
        "output": 0, "integral": 0, "prevError": 0, "time": 0, "control": 0, "error": 0
      } }
    ]},
    "ACTION_DISTURB": { "type": "set_context", "path": "disturbance", "value": "$expr(disturbance == 0 ? -0.5 : 0)" }
  },
  "transitions": [],
  "flow": { "initial": "scene_lab" }
}
```

## 校验规则（dsl-validator 实现）

- ✅ schema 形态（zod）
- ✅ flow.initial 必须是已存在 scene
- ✅ transitions.from / to 必须存在（"*" 通配除外）
- ✅ transitions.action 必须在 actions 中（warning）
- ✅ scene.on / events 引用的 action 必须存在（warning）
- ✅ action.navigate.to 必须是已存在 scene
- ✅ 所有 UINode.type 必须在 component-manifest 中
- ✅ 所有 expression 必须语法合法（括号匹配 + 不含禁用字符）
- ✅ 所有 scene 应可达（warning，不强制）

## 命名约定（智能体生成时遵循）

- `app.id`：kebab-case（`engine-disassembly-training`）
- `scene id`：snake_case + `scene_` 前缀（`scene_intro`、`scene_quiz`）
- `action id`：SCREAMING_SNAKE_CASE + `ACTION_` 前缀（`ACTION_NEXT`、`ACTION_SUBMIT_QUIZ`）
- `context 字段`：camelCase（`stepIdx`、`userScore`、`running`）
- `computed provider`：camelCase（`pidSeries`、`ohmCurrent`、`pidAdvice`）
