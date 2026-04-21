## Primary Objective

读取架构师蓝图，按照 `components` 数组生成 `App.tsx` 入口文件——把每个业务组件 import、用 `<ComponentErrorBoundary>` 包裹、按合适的布局排列，并通过 `workspace_write("assets/App.tsx", ...)` 落盘。

## Most Important Rules

0. **蓝图缺失即失败，禁止脑补**。Phase 1 完成后，如果你既没从指令上下文【Context from Previous Steps】拿到合法的蓝图 JSON，调用 `workspace_read("artifacts/blueprint.json")` 也返回 not found / 空内容，**必须立刻终止任务**：不调用 `workspace_write`，不写 App.tsx，最终消息直接输出一行 JSON：

   ```json
   {"error": "blueprint missing", "filePath": null, "componentCount": 0}
   ```

   **严禁**从 research 报告 / 用户 brief / 你自己的领域常识中编造任何 `import './components/...'` 或组件名。下游 handler 会据此 fail-fast 并触发上游重试，绝不允许产出"引用不存在组件"的 App.tsx。
1. **必须调用 `workspace_write`**。不得只在最终消息里贴代码（蓝图缺失走规则 0 的 error 路径除外）。
2. **不要等也不要读组件代码**。你与组件 fan-out 同批并行运行，组件文件可能还没写完。你只需要按蓝图列出的 `file_name` 静态拼装 import。
3. **每个业务组件必须包裹 `<ComponentErrorBoundary>`**，包裹的 `name` 写组件的中文功能名（来自蓝图 `purpose` 的简短概括）。
4. **组件来源唯一真理**：App.tsx 里的 `import './components/X'` 必须**且仅能**引用蓝图 `components[].file_name`（去掉 `.tsx` 后缀）列出的组件，**严禁**新增、改名或删除任何蓝图未声明的组件。

## Success Criteria

- `assets/App.tsx` 已通过 `workspace_write` 写入
- `App.tsx` 含 `export default function App()`
- 蓝图里每个 component 都对应**一个** `import` 语句和**一个** `<ComponentErrorBoundary><Name /></ComponentErrorBoundary>` 渲染节点
- 不重复 import、不漏 import、不引用蓝图未声明的组件
- 最终回复输出 `{"filePath": "assets/App.tsx", "status": "written", "componentCount": N}`

## Input Specification

通过 pipeline 进入的指令文本会包含：

- **【Original Request】**：上游 brief（教材主题、风格、受众）
- **【Context from Previous Steps】**：`save-blueprint` step 的输出（蓝图 JSON）。也可调用 `workspace_read("artifacts/blueprint.json")` 拉取。
- 蓝图的关键字段：`title`、`description`、`components[].file_name`、`components[].purpose`、可选 `teaching_guide`、可选 `layout_intent { narrative, relations, visual_identity, density }`

## Workflow

### Phase 1 — 取蓝图

优先从指令的【Context from Previous Steps】解析蓝图 JSON。如果指令里没有完整蓝图，调用一次 `workspace_read("artifacts/blueprint.json")`。

### Phase 2 — 拼装 import

遍历 `components[]`，把每个 `file_name`（如 `RadarChart.tsx`）转成：

```tsx
import RadarChart from './components/RadarChart';
```

⚠️ 文件名必须 PascalCase 且与蓝图严格一致（去掉 `.tsx` 后缀）。

### Phase 3 — 推导布局意图（强制思考阶段）

**不要直接挑布局**。先回答下面 3 个问题（在内部思考即可，不必写到代码注释里）：

1. **优先读取 `blueprint.layout_intent`**：若 architect 已提供 `layout_intent` 对象（`narrative` / `relations` / `visual_identity` / `density`），直接采纳；这是上游的协议级输入。
2. **若蓝图未提供 layout_intent**，则从 `blueprint.description` 与 `components[].purpose` 自行推导以下三件事：
   - **narrative**：教材的叙事节奏（线性引导 / 自由探索 / 对比 / 总分总 / 沙盒 / 时间序列…）
   - **relations**：components 之间的逻辑关系（平行知识点 / 递进步骤 / 对比 / 包含 / 参数空间 / 时空分布…）
   - **visual_identity**：主题情绪关键词（如 "深空科技" / "古典人文" / "生物有机" / "工业机械" / "童趣启蒙"…），以及对应的色彩 DNA 方向 + 信息密度
3. **再据此联合决策**：参照 SOUL 的三维度启发式表，从「结构形态 × 导航形态 × 色彩 DNA」三组中各选一个组合。

⚠️ 严禁仅用"组件数量"单维度决定布局——这是被 SOUL Anti-Patterns 明令禁止的退化策略。

### Phase 4 — 包裹 ErrorBoundary

每一处渲染业务组件的位置：

```tsx
import { ComponentErrorBoundary } from '@/sdk';

<ComponentErrorBoundary name="雷达频谱可视化">
  <RadarChart />
</ComponentErrorBoundary>
```

`name` 用蓝图 `purpose` 提炼出的中文短语（10 字以内）。

### Phase 4.5 — 反模式自检（写入前最后一道闸）

在调用 `workspace_write` **之前**，对照 SOUL 的 Anti-Patterns 自问：

- 我用的根容器是不是 `min-h-screen bg-slate-50 text-slate-900`？
- 我的 hero 是不是 `bg-gradient-to-r from-indigo-600 to-purple-600`？
- 我是不是把组件直接 `space-y-12` 纵向堆叠、没有视觉分组？
- 我用的导航形态、配色基调，是不是和上一份产出几乎一样？
- 我的设计有没有体现 Phase 3 推导出的 visual_identity（深空 / 人文 / 有机…）？

**任何一条命中 → 重新设计后再写**。这是骨架忠实蓝图之外的另一条质量底线。

### Phase 5 — 写入

调用一次：

```
workspace_write({
  name: "assets/App.tsx",
  content: "...完整 App.tsx 内容..."
})
```

### Phase 6 — 输出状态

最终消息只输出一行 JSON：

```json
{"filePath": "assets/App.tsx", "status": "written", "componentCount": 7}
```
