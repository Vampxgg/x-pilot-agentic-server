## Preferred Tools

### workspace_write（优先级：高）

唯一的强制工具调用。每次任务**只调用一次**：

```
workspace_write({
  name: "assets/components/{PascalCaseName}.tsx",
  content: "...完整 TSX..."
})
```

`name` 必须以 `assets/components/` 开头，且文件名与组件函数名严格一致。

### workspace_read（优先级：中）

按需补全上下文：

- `workspace_read("artifacts/blueprint.json")` — 读完整蓝图（一般 fan-out 已传入 _item，无需读全量）
- `workspace_read("artifacts/research.json")` — 读研究报告，按需提取本组件相关章节

不要无脑全部读取——尽量在 fan-out 注入的指令中获取信息，需要补充时再读。

## Tool Strategy

1. 默认只调用 `workspace_write` 一次。
2. 仅当 fan-out 指令中数据不足以撑起组件时，再 `workspace_read("artifacts/research.json")`。
3. 工具调用完毕后立即输出 JSON 状态，结束任务。

---

## SDK 组件 API 参考（必须严格遵循）

下表列出常用 SDK 组件，详细 props 见父项目 `tutorial-scene-coder/TOOLS.md`。本 Agent 遵循同样的 API 约定。

### 信息呈现类

- `<InfoCard title description icon? variant? collapsible? />`
- `<BulletPoints title? ordered? items={[{text, detail?}]} />`
- `<StepGuide steps={[{label, content}]} onStepChange? />` — 注意 `label` 不是 `title`
- `<Callout type="tip|warning|note|important" title?>{...}</Callout>`
- `<KeyTakeaway variant? title? points={[...]} />`
- `<LearningObjectives title? objectives={[{text, completed?}]} onToggle? />`
- `<StatCard label value unit? trend? icon? />`
- `<ProgressTracker label current total variant? />`

### 数据可视化类

- `<Chart title? chartType="bar|line|area|pie|gauge|radar|scatter" data={...} />`
- `<DataTable title? columns rows striped? highlightRow? sortable? />`
- `<ComparisonTable title? subjects features={[{name, values}]} />`
- `<Timeline events={[{date, title, description}]} />`
- `<FormulaBlock formula label? description? />`

### 交互类

- `<SliderControl label min max step defaultValue unit? onChange />`
- `<ParameterExplorer title parameters={[...]} compute={(p)=>ReactNode} />`
- `<DragSort items correctOrder question onComplete />`
- `<MatchingPairs pairs question onComplete />`
- `<ClickReveal title hiddenContent />` — 注意 `title` / `hiddenContent`
- `<ToggleReveal label onContent />`
- `<Hotspot src alt hotspots={[{id, x, y, label, description}]} />`
- `<ImageAnnotated src alt annotations={[...]} />`
- `<BeforeAfter mode? before after />`

### 代码 / 终端 / 公式

- `<CodeBlock code language? title? showLineNumbers? files? />`
- `<CodePlayground initialCode? language? readOnly? onRun? />`
- `<TerminalSimulator commands welcomeMessage? prompt? />`

### 高阶（要合理使用）

- `<Flowchart nodes edges />` — 节点 `type: start|process|decision|end`
- `<Mindmap center branches />`
- `<Scene3D title? cameraPosition? orbitControls? background?>{three.js children}</Scene3D>`
- `<PhysicsCanvas width? height? setup={(engine, world)=>void} />` — 需要 `import Matter from 'matter-js'`
- `<VirtualInstrument type value unit range label />` — 需 `import { VirtualInstrument } from '@/sdk/simulation/VirtualInstrument'`
- `<CircuitDiagram components connections />` — 需 `import { CircuitDiagram } from '@/sdk/simulation/CircuitDiagram'`

## Import 模板

文件头部模板（按需裁剪）：

```tsx
import { InfoCard, Chart, /* ...其他 sdk widget */ } from '@/sdk';
import { useState } from 'react';
// 可选第三方：
// import { motion } from 'framer-motion';
// import { Bolt, Cpu } from 'lucide-react';
```

**禁止**：

```tsx
import OtherComponent from './OtherComponent';        // ❌ 组件互引
import { Foo } from '../components/Foo';              // ❌ 同上
import x from '../sdk';                                // ❌ 用 '@/sdk'
import { useAppState } from 'zustand';                 // ❌ zustand 没有这个导出
```

## 应用层 hook 鼓励使用清单

下面三个 hook 让本组件从"展示卡片"升级为"应用视图"。**只能从 `@/sdk` import**，按 Phase 1.5 的判断按需引入。

| Hook | 用途 | 何时用 |
|---|---|---|
| `useAppState<T>(key, defaultValue?)` | 读写应用级共享状态（自动持久化） | 蓝图 `app_meta.persistent_state` 含本视图相关的 key；或本视图要标记 `progress` |
| `usePersistedState<T>(key, defaultValue)` | 组件级持久化状态（语法同 useState） | 视图自身的展开/折叠、排序、Tab、用户输入草稿等需要刷新后保留的本地状态 |
| `useApp()` | 读取 `appId` / `appName` / `theme` / `settings` | 想根据全局主题或字号微调本组件呈现 |

### 示例：标记进度

```tsx
import { useEffect } from 'react';
import { useAppState, InfoCard } from '@/sdk';

export default function PIDPlayground() {
  const [progress, setProgress] = useAppState<Record<string, 'visited' | 'done'>>('progress', {});
  useEffect(() => {
    setProgress((p) => ({ ...p, 'PIDPlayground.tsx': p['PIDPlayground.tsx'] === 'done' ? 'done' : 'visited' }));
  }, [setProgress]);
  return <InfoCard title="参数实验" description="..." />;
}
```

### 示例：跨视图共享参数

```tsx
import { useAppState, SliderControl } from '@/sdk';

export default function PIDControls() {
  const [params, setParams] = useAppState('sim.params', { kp: 1, ki: 0, kd: 0 });
  return (
    <SliderControl
      label="Kp"
      min={0}
      max={5}
      step={0.1}
      defaultValue={params.kp}
      onChange={(v) => setParams({ ...params, kp: v })}
    />
  );
}
// 另一个视图（PIDWaveform）只需要 const [params] = useAppState('sim.params'); 即可订阅
```

**重要**：上面三个 hook 只在你 Phase 1.5 判断需要时才用，不要无脑给每个组件都套上。**误用比不用更有害**——把本来该用 `useState` 的内部状态写到 `useAppState` 里会污染应用全局状态。

---

## 应用层 hook API 速查（致命）

> 同源全文：[`apps/interactive-tutorial/SDK-API-CHEATSHEET.md`](../SDK-API-CHEATSHEET.md)
>
> 本 agent 只产出**业务组件**，所以应用层只关心 3 个 hook + `<ComponentErrorBoundary>`。已经线上崩过的写法都标在反例里，**写完 grep 自检**。

### `useAppState<T>(key, defaultValue?)`

返回 **`[value, setter]` 元组**——必须解构。语义同 `useState`，但状态来自 `<AppProvider>` 内部 store 并自动持久化。

```tsx
// ✅
const [progress, setProgress] = useAppState<Record<string,'visited'|'done'>>('progress', {});
setProgress((p) => ({ ...p, [name]: 'done' }));

const [params, setParams] = useAppState('sim.params', { kp: 1, ki: 0, kd: 0 });
setParams({ ...params, kp: 2 });

// ❌ 全是真实崩过的写法
const progress = useAppState('progress');           // progress = [value, setter] 数组
const progress = useAppState('progress') || {};     // 同上，数组永远 truthy
const v = useAppState('alignment');
const yawOk = Math.abs(v.yaw) <= 0.5;                // TypeError: Cannot read properties of undefined
```

不要把组件**自身**的展开/折叠/Tab/草稿这种 UI state 写进 `useAppState`——会污染应用全局 state。那种用 `usePersistedState` 或 `useState`。

### `usePersistedState<T>(key, defaultValue)`

签名同 `useState`，自动 `localStorage`，独立于 `createAppStore`。组件级局部状态首选。

```tsx
const [open, setOpen] = usePersistedState<boolean>('parameter-explorer.open', false);
```

### `useApp()`

返回 `{ appId, appName, appStore, theme, settings, setSettings, resetProgress }`。**永不抛错**——无 Provider 时给兜底值。

```tsx
const { theme, settings } = useApp();
return <div className={settings.fontSize === 'lg' ? 'text-lg' : 'text-base'}>...</div>;
```

需要直接读 store 而不是订阅式 hook 时：

```tsx
const { appStore } = useApp();
appStore.getState().set('progress', { ...prev, foo: 'done' });   // 命令式写
```

注意：`appStore.getState()` 返回的 `AppStoreApi` 有 `state / set / get / patch / reset`。所有 key 都在 `s.state` 下。

### `<ComponentErrorBoundary name>`

业务组件**自己**通常不直接用——上层 App.tsx 已经把每个组件包了。但你的组件**内部**做大块条件渲染（如 3D 子树）想再隔离时可以再嵌一层：

```tsx
<ComponentErrorBoundary name="3D 子场景">
  <Scene3D>{/* ... */}</Scene3D>
</ComponentErrorBoundary>
```

---

### 致命反例（grep 自检）

```text
反例 1（Tutorial f361348d 崩白屏，背景）：
  const progress = useStore((s) => s.progress);
  → 错；正确：useStore((s) => s.state.progress)
  注：组件内一般不用 useStore，但若你借 useApp().appStore 做 selector，
     state 路径同样在 s.state.xxx，不是 s.xxx。

反例 2（Tutorial 844e98f0 崩 TypeError）：
  const p = useAppState('k') || {};
  → 错；正确：const [p, setP] = useAppState('k', {})

反例 6（Tutorial 1d2f9f9e ReferenceError）：
  emit_event?.({ ... });
  → 错；emit_event 不是任何 SDK 导出，禁止使用。要触发应用副作用就调用
    setProgress / appStore.getState().set / appStore.getState().patch。
```

### 写入前自检清单

- [ ] 所有 `useAppState(` 都带 `const [v, setV] =` 解构，且第 2 参数给了 `defaultValue`
- [ ] 没有把组件自身 UI 状态写进 `useAppState`（应该用 `useState` 或 `usePersistedState`）
- [ ] 没有 `emit_event(` 调用
- [ ] 没有从 `zustand` / `react` / `./*` 直接 import `useAppState` / `usePersistedState` / `useApp`——只能从 `@/sdk`
- [ ] 没有 `from './OtherComponent'` 之类的组件互引
