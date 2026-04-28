## Primary Objective

输出完整的 DSL skeleton（version + app + context + scenes 仅含 title/intent + actions + transitions + flow + tick + computed），存为 artifacts/dsl-skeleton.json。

scenes 字段中每个 scene 必须含且仅含：`{ title, intent }`；`ui` 字段省略不写——scene-author 后续会 fan-out 填充。

## 输出 schema（必须严格遵守）

```ts
interface DslSkeleton {
  version: "1.1";
  app: {
    id: string;       // kebab-case，如 "engine-principle-training"
    name: string;
    description?: string;
    shell?: {
      layout?: "centered" | "full" | "plain" | "workspace";
      header?: boolean | { brand?: boolean | object; progress?: boolean | object };
      maxWidth?: "narrow" | "normal" | "wide" | "full" | string;
      padding?: "none" | "sm" | "md" | "lg";
    };
    theme?: {
      preset: "edu-light" | "tech-blue" | "notion-warm" | "industrial" | "kid-vivid" | "academic" | "minimal";
      tokens?: Record<string, string>;
    };
  };
  context: {
    schema?: Record<string, unknown>;  // 字段说明给 LLM 看
    initial: Record<string, unknown>;  // 初始值
  };
  scenes: Record<string, {
    title?: string;
    intent: string;   // 关键！描述这个 scene 教什么 + 用 ResearchPack 哪些素材 + 期望什么交互
  }>;
  actions: Record<string, ActionOrCompound>;
  transitions: Array<{ from: string; action: string; to: string; condition?: { expr: string } }>;
  flow: { initial: string; completion?: string };
  tick?: { intervalMs: number; action: string; autoStart: boolean; runningPath: string };
  computed?: Record<string, { provider: string; description?: string }>;
}
```

## Workflow

1. 读 workspace：`artifacts/clarified-intent.json`（若有）、`artifacts/research.json`、**`artifacts/pedagogy-plan.json`**、**`artifacts/data-pack.json`**、**`artifacts/visual-system.json`**
2. **合并 visual**：把 `visual-system.json` 的 `shell` 与 `theme` 并入输出的 `app.shell` / `app.theme`（blueprint 的 `app` 以 visual 为权威；可补充 `description` / `id` / `name`）
3. **教纲与数据**：`scene.intent` 必须体现 `pedagogy-plan` 模块顺序与 `learningEvidence`；在 intent 中点名将使用的 **`data-pack` 条目 id**（便于 scene-author `workspace_read`）
4. **决策 1：scene 数量**
   - 仿真类（PID/电路）→ 1-2 个 scene 就够
   - 通识知识检测 → 3-5 个
   - 完整章节（汽车/物理/编程）→ 5-8 个
5. **决策 2：每个 scene 的目标**
   - 在 scene.intent 里写清楚：「这个 scene 用 ResearchPack 中的 X/Y/Z 素材，让用户做 A/B 交互，达成 C 目标」
   - intent 是 scene-author 的"任务说明书"
6. **决策 3：theme 与 shell**（若与 `visual-system.json` 冲突，以 **visual-system** 为准并仅在 intent 中说明取舍）
   - 查 SOUL 里的题材→theme 映射
   - 是否需要 maxWidth wide / full / narrow（仪表盘类 wide / 通识 normal / 文档 narrow）
   - 是否需要 header（沉浸式仿真可关 header）
7. **决策 4：context 字段**
   - 跨 scene 持久什么？常见：currentStep / score / userInputs / progress / selectedItem
   - 仿真类：必有 running / series / simState / 各参数
8. **决策 5：actions 与 transitions**
   - 为关键事件定义 action（如 ACTION_NEXT / ACTION_SCORE_UPDATE / ACTION_TICK）
   - transitions 只写"非线性"跳转（条件分支、跳过、回头）；线性下一步用 FlowController 自动处理
9. **决策 6：tick / computed**
   - 仿真应用必须有 tick + 一个 step provider（如 pidStepProvider / 自定义）
   - LiveChart / MetricBoard 等组件依赖的派生数据通过 computed 声明

## 命名约定

- app.id: kebab-case，唯一
- scene id: snake_case，前缀 `scene_`（如 scene_intro / scene_explore / scene_quiz）
- action id: SCREAMING_SNAKE_CASE，前缀 ACTION_（如 ACTION_NEXT / ACTION_SUBMIT）
- context 字段: camelCase（如 stepIdx / userScore / running）

## 【输出协议】（硬约束）

- **写文件位置**：调用 `workspace_write` 写到 **`artifacts/dsl-skeleton.json`**（不是 `assets/`）
- **最终回复**：最后一条 message 的 content 字段**必须是且仅是**合法 JSON 对象（DslSkeleton 结构）。不允许：
  - 夹任何自然语言（如「我已经设计了 5 个 scene」）
  - 用 markdown 代码块（除非 outputFormat 明确允许）
  - 在 JSON 前后加注释
- **scenes 字段必须是对象**（`{[sceneId]: {title, intent}}`），**不是数组**
- saveDslSkeleton handler 会用 `JSON.parse` 解析；下游 fan-out 用 sceneList 数组（handler 自动产生）
