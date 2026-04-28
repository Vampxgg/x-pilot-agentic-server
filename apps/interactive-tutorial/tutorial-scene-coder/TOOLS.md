## Preferred Tools

### workspace_read（优先级：高）

读取蓝图与研究报告，例如：

- `artifacts/blueprint.json`
- `artifacts/research.json`

### workspace_write（优先级：高）

写入生成的应用代码：

- **根应用**：`assets/App.tsx`
- **业务组件**：`assets/components/{Name}.tsx`（`Name` 与蓝图中的组件名一致，PascalCase）

每生成一个文件立即调用一次 `workspace_write`，**不得**遗漏。

### workspace_list（优先级：低）

验证 `assets/App.tsx` 与 `assets/components/` 下文件是否已全部写入。

## Tool Strategy

1. `workspace_read` 获取蓝图与研究数据。
2. 按蓝图逐个生成组件，每次 `workspace_write("assets/components/{Name}.tsx", ...)`。
3. 最后生成并 `workspace_write("assets/App.tsx", ...)`。
4. `workspace_list` 确认资产目录完整。

---

## App.tsx 应用骨架契约（不是模板，是底线）

`App.tsx` 是教学应用的入口，**必须**满足下面 8 条契约。槽位里填什么、layout 选哪种、配色与节奏、Sidebar 怎么排——都是自由设计区。

```tsx
import { useState } from 'react';
import {
  AppShell,
  AppHeader,
  AppSidebar,
  AppStatusBar,
  AppProvider,
  SettingsDrawer,
  Onboarding,
  ComponentErrorBoundary,
  createAppStore,
} from '@/sdk';
// import 蓝图 components[].file_name（去 .tsx 后缀），命名严格一致

// ← 契约 A：store 在文件顶层模块作用域创建（不能放进 App 函数体）
const useStore = createAppStore({
  appId: 'xxx-app',                  // 由蓝图 title 派生
  initialState: {
    progress: {},                     // 至少这一个 key
    // ...来自 blueprint.app_meta.persistent_state[].key + default
  },
});

export default function App() {
  // ← 契约 B：AppProvider + AppShell 是根骨架，槽位内容自由设计
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <AppProvider appId="xxx-app">
      {/* 若 has_onboarding：在 AppShell 之外平铺 <Onboarding ... /> */}
      <AppShell
        layout="sidebar"               // sidebar / topbar / workspace 任选
        header={<AppHeader title={/* blueprint.title */} actions={/* 你设计 */} />}
        sidebar={/* 由 user_journey 或 components 派生的 <AppSidebar items={...} /> */}
        statusBar={/* 可选 <AppStatusBar progress={...} /> */}
        drawer={/* 若 has_settings：<SettingsDrawer open={settingsOpen} onOpenChange={setSettingsOpen} /> */}
      >
        {/* 主内容区：把蓝图 components 用 ErrorBoundary 包裹后排出来 */}
        <ComponentErrorBoundary name="中文名"><XXX /></ComponentErrorBoundary>
        {/* ...每个 component 一处渲染节点 */}
      </AppShell>
    </AppProvider>
  );
}
```

**强制规则**（写入前对照自检）：

1. 必须从 `@/sdk` import `AppShell` / `AppProvider` / `ComponentErrorBoundary` / `createAppStore`（其余按需）
2. 必须 `export default function App()`
3. 必须在文件顶层调用 `createAppStore(...)`（**不能**放进 App 函数体——每次渲染都重建 store 会丢状态）
4. 必须用 `<AppProvider appId="...">` 包裹根渲染
5. 必须用 `<AppShell>` 作为根骨架（不允许裸 `<main>` / `<div>`）
6. 蓝图 `components[]` 每一项都对应**一个** import + **一个** `<ComponentErrorBoundary><X /></ComponentErrorBoundary>`
7. 按 `app_meta.app_chrome` 决定是否挂 `<SettingsDrawer>` / `<Onboarding>` / `<AppSidebar>`
8. `useAppState` / `usePersistedState` / `useApp` 只能从 `@/sdk` import，禁止从 `zustand` 直接 import

## 应用层 hook（在 App.tsx 与组件中均可用，但来源仅 `@/sdk`）

| Hook | 用途 |
|---|---|
| `useAppState<T>(key, defaultValue?)` | 应用级共享状态读写（自动持久化）；跨视图通信首选 |
| `usePersistedState<T>(key, defaultValue)` | 组件级 localStorage 持久化（语法同 useState） |
| `useApp()` | 读取 `appId` / `appName` / `theme` / `settings` |

组件之间**不互引**——共享状态全部走 `useAppState('shared.key')`。

---

## SDK 组件 API 参考（必须严格遵循）

### InfoCard

```tsx
<InfoCard
  title="标题"
  description="描述文本或JSX"
  icon={<SomeIcon />}         // 可选
  variant="default|info|success|warning|danger"  // 可选
  collapsible={true}          // 可选，为 true 时可点击折叠/展开描述区
/>
```

### BulletPoints

```tsx
<BulletPoints
  title="标题"                // 可选
  ordered={true}             // 可选，是否编号
  items={[
    { text: '要点文字', detail: '补充说明' },  // detail 可选
    { text: '第二点' },
  ]}
/>
```

### StepGuide

```tsx
<StepGuide
  steps={[
    { label: '步骤名', content: '步骤描述文字或JSX' },
    { label: '步骤二', content: '...' },
  ]}
  onStepChange={(index) => {}}  // 可选，步骤切换时回调
/>
```

注意：steps 中用 **label** 不是 title！内置"上一步/下一步"导航按钮。

### ClickReveal

```tsx
<ClickReveal
  title="点击查看答案"
  hiddenContent={<p>被隐藏的内容</p>}
/>
```

注意：用 **title** 和 **hiddenContent**，不是 buttonText/revealContent！

### SliderControl

```tsx
<SliderControl
  label="滑块标签"
  min={0} max={100} step={1}
  defaultValue={50}
  unit="V"
  onChange={(value) => setValue(value)}
/>
```

### Chart

```tsx
// 柱状/折线/面积图
<Chart title="图表标题" chartType="bar|line|area"
  data={[{ name: 'A', value1: 10, value2: 20 }]} />

// 饼图
<Chart chartType="pie" data={[{ name: 'A', value: 30 }]} />

// 仪表盘
<Chart chartType="gauge" data={{ value: 72, min: 0, max: 100, unit: '%' }} />

// 雷达图（数据格式同 bar/line）
<Chart chartType="radar"
  data={[{ name: '指标A', 系列1: 80, 系列2: 65 }]} />

// 散点图
<Chart chartType="scatter"
  data={[{ x: 10, y: 20 }, { x: 30, y: 40, z: 100 }]} />
```

chartType 支持：`bar`、`line`、`area`、`pie`、`gauge`、`radar`、`scatter`。

### DataTable

```tsx
<DataTable
  title="表格标题"
  columns={[
    { key: 'col1', label: '列名', align: 'left|center|right' },
  ]}
  rows={[
    { col1: '数据', col2: 123 },
  ]}
  striped={true}
  highlightRow={0}  // 可选，高亮行索引
  sortable={true}   // 可选，启用列排序（点击表头循环 asc→desc→none）
/>
```

### ImageAnnotated

```tsx
<ImageAnnotated
  src="图片URL"
  alt="描述"
  annotations={[
    { id: '1', x: 30, y: 50, label: '标注名', description: '说明' },
  ]}
/>
```

### CodeBlock

```tsx
// 单文件模式
<CodeBlock
  code={'const x = 1;'}
  language="javascript"
  title="文件名"
  showLineNumbers={true}
/>

// 多文件标签页模式
<CodeBlock
  code=""
  files={[
    { name: 'index.ts', code: 'import ...', language: 'typescript' },
    { name: 'style.css', code: '.btn { ... }', language: 'css' },
  ]}
/>
```

### FormulaBlock

```tsx
<FormulaBlock
  formula="E = mc^2"
  label="质能方程"
  description="描述文字"
/>
```

### DragSort

```tsx
<DragSort
  items={[{ id: '1', text: '项目1' }, { id: '2', text: '项目2' }]}
  correctOrder={['1', '2']}
  question="请排列正确顺序"
  onComplete={(isCorrect) => {}}
/>
```

### MatchingPairs

```tsx
<MatchingPairs
  pairs={[
    { left: '左侧项', right: '右侧匹配项' },
  ]}
  question="连线配对"
  onComplete={(allCorrect) => {}}
/>
```

### ComparisonTable

```tsx
<ComparisonTable
  title="对比表"
  subjects={['A', 'B', 'C']}
  features={[
    { name: '特征名', values: ['值A', true, 123] },
  ]}
/>
```

### Timeline

```tsx
<Timeline events={[
  { date: '2024', title: '事件标题', description: '描述' },
]} />
```

### ToggleReveal

```tsx
<ToggleReveal
  label="显示/隐藏内容"
  onContent={<div>可折叠的详细内容</div>}
/>
```

### Hotspot

```tsx
<Hotspot
  src="图片URL"
  alt="描述"
  hotspots={[
    { id: '1', x: 30, y: 40, label: '热点名', description: '点击后显示的内容' },
  ]}
/>
```

### ProgressTracker

```tsx
<ProgressTracker
  label="学习进度"
  current={3}
  total={10}
  variant="success"  // 可选：default | success | info
/>
```

### Callout

语义提示框，比 InfoCard 更轻量。

```tsx
<Callout type="tip" title="小技巧">
  <p>这里是提示内容，支持任意 JSX。</p>
</Callout>
```

type 支持：`tip`（绿）、`warning`（琥珀）、`note`（蓝）、`important`（红）。

### StatCard

大数字统计卡片。

```tsx
<StatCard
  label="月活用户"
  value={12500}
  unit="人"
  trend={{ direction: 'up', label: '+12.3%' }}
  icon={<Users />}  // 可选
/>
```

trend.direction 支持：`up`（绿）、`down`（红）、`flat`（灰）。

### ParameterExplorer

多参数滑块 + 实时计算结果，适合"调参观察效果"的教学场景。

```tsx
<ParameterExplorer
  title="欧姆定律探索"
  parameters={[
    { key: 'voltage', label: '电压', min: 0, max: 24, step: 0.1, defaultValue: 12, unit: 'V' },
    { key: 'resistance', label: '电阻', min: 1, max: 100, step: 1, defaultValue: 10, unit: 'Ω' },
  ]}
  compute={(params) => (
    <p>电流 = {(params.voltage / params.resistance).toFixed(2)} A</p>
  )}
/>
```

注意：`compute` 返回 ReactNode，每次滑块变化都会重新调用。

### BeforeAfter

前后对比组件，支持三种模式。

```tsx
// 左右并排（默认）
<BeforeAfter
  before={{ label: '优化前', content: <p>旧内容</p> }}
  after={{ label: '优化后', content: <p>新内容</p> }}
/>

// 开关切换
<BeforeAfter mode="toggle"
  before={{ label: '原始数据', content: <DataTable ... /> }}
  after={{ label: '处理后', content: <DataTable ... /> }}
/>

// 滑块拖拽（拖拽中间分割线）
<BeforeAfter mode="slider"
  before={{ label: '处理前', content: <img src="..." /> }}
  after={{ label: '处理后', content: <img src="..." /> }}
/>
```

mode 支持：`side-by-side`（默认）、`toggle`、`slider`。

### LearningObjectives

学习目标清单，带勾选和进度统计。

```tsx
<LearningObjectives
  title="学习目标"             // 可选，默认"学习目标"
  objectives={[
    { text: '理解欧姆定律的基本原理', completed: true },
    { text: '能计算简单电路的电流' },
    { text: '了解电阻与温度的关系' },
  ]}
  onToggle={(index) => {}}    // 可选，点击勾选时回调
/>
```

### KeyTakeaway

课程总结/关键要点卡片。

```tsx
<KeyTakeaway
  variant="summary"           // 可选：summary | conclusion | remember
  title="本节小结"             // 可选，各 variant 有默认标题
  points={[
    '电压 = 电流 × 电阻',
    '电阻与导体长度成正比',
    '超导体在临界温度下电阻为零',
  ]}
/>
```

variant 样式：`summary`（蓝，📖）、`conclusion`（绿，✅）、`remember`（琥珀，⭐）。

### Flowchart

节点坐标 x, y 可选——省略时自动布局（dagre 从上到下排列）。

```tsx
<Flowchart
  nodes={[
    { id: '1', text: '开始', type: 'start' },
    { id: '2', text: '处理步骤', type: 'process' },
    { id: '3', text: '判断', type: 'decision' },
    { id: '4', text: '结束', type: 'end' },
  ]}
  edges={[
    { from: '1', to: '2' },
    { from: '2', to: '3' },
    { from: '3', to: '4', label: '是' },
  ]}
/>
```

### Mindmap

```tsx
<Mindmap
  center="中心主题"
  branches={[
    { label: '分支1', children: [{ label: '子节点' }] },
    { label: '分支2' },
  ]}
/>
```

### Scene3D

React Three Fiber 3D 场景容器，内置光照、地面网格和轨道控制器。children 接收 Three.js 的 mesh/group 等 3D 元素。

```tsx
<Scene3D
  title="3D 模型展示"              // 可选，卡片顶部标题
  cameraPosition={[0, 2, 5]}      // 可选，相机位置 [x, y, z]
  orbitControls={true}             // 可选，是否启用鼠标旋转控制
  background="#0f172a"             // 可选，场景背景色
>
  <mesh position={[0, 0.5, 0]}>
    <boxGeometry args={[1, 1, 1]} />
    <meshStandardMaterial color="orange" />
  </mesh>
</Scene3D>
```

注意：children 中使用的 Three.js 元素需要 import `three`、`@react-three/fiber` 或 `@react-three/drei`。

### PhysicsCanvas

Matter.js 2D 物理仿真画布，挂载时自动创建 Engine/Render/Runner。

```tsx
import Matter from 'matter-js';

<PhysicsCanvas
  width={600}                      // 可选，画布宽度
  height={400}                     // 可选，画布高度
  setup={(engine, world) => {      // 可选，初始化回调
    const ball = Matter.Bodies.circle(300, 50, 20, { restitution: 0.8 });
    const ground = Matter.Bodies.rectangle(300, 390, 600, 20, { isStatic: true });
    Matter.Composite.add(world, [ball, ground]);
  }}
/>
```

注意：setup 回调接收 `(engine: Engine, world: World)`，用于添加刚体和约束。需要 `import Matter from 'matter-js'`。

### CodePlayground

Monaco 代码编辑器 + 运行区，内置 JS/TS 执行器，也支持自定义 onRun。

```tsx
<CodePlayground
  initialCode={'console.log("Hello");'}  // 可选，初始代码
  language="javascript"                   // 可选，编辑器语言
  readOnly={false}                        // 可选，是否只读
  onRun={(code) => '自定义输出'}          // 可选，自定义运行逻辑，返回输出字符串
/>
```

### TerminalSimulator

模拟终端，支持自定义命令映射。内置 help 和 clear 命令。

```tsx
<TerminalSimulator
  commands={{
    'ls': '文件列表：index.html  style.css  app.js',
    'pwd': '/home/user/project',
    'echo': (args) => args,            // 函数形式，接收参数字符串
    'date': () => new Date().toLocaleString(),
  }}
  welcomeMessage="欢迎使用模拟终端"     // 可选
  prompt="$ "                          // 可选，命令提示符
/>
```

注意：commands 的 value 可以是固定字符串或 `(args: string) => string` 函数。

### VirtualInstrument（按需导入）

需要单独导入：`import { VirtualInstrument } from '@/sdk/simulation/VirtualInstrument'`

SVG 虚拟仪表，支持万用表、示波器和通用表盘三种样式。仅在电子/仪器相关主题时使用。

```tsx
<VirtualInstrument
  type="multimeter|oscilloscope|generic"
  value={3.14}
  unit="V"
  range={{ min: 0, max: 10 }}
  label="直流电压"
/>
```

### CircuitDiagram（按需导入）

需要单独导入：`import { CircuitDiagram } from '@/sdk/simulation/CircuitDiagram'`

电路示意图，仅在电路相关主题时使用。

```tsx
<CircuitDiagram
  components={[
    { id: 'bat', type: 'battery', x: 100, y: 200, label: '电源', value: '9V' },
    { id: 'r1', type: 'resistor', x: 300, y: 100, label: 'R1', value: '1kΩ' },
  ]}
  connections={[{ from: 'bat', to: 'r1' }]}
/>
```

元件 type：`resistor`、`battery`、`switch`、`led`、`ground`。

---

## App.tsx 应用层 SDK 速查（致命）

> 本节专门防 `App.tsx` 在状态层与应用骨架上写错——已经有 4 个教程在这里崩过。
> 同源全文：[`apps/interactive-tutorial/SDK-API-CHEATSHEET.md`](../SDK-API-CHEATSHEET.md)
>
> 本 agent 走 **fallback 路径**（同时产出组件 + App.tsx），所以**两类速查都要看**：上面那一大段是组件级 SDK widget；这一节是 App.tsx 的应用层符号。

### 状态层（4 个）

**`createAppStore({ appId, initialState?, version?, ephemeral? })`** —— 返回 selector hook + zustand store。

```ts
interface AppStoreApi {
  state: AppState;                   // ← 你存的 key 都在 s.state 里，不是 s.xxx
  set: (key, value) => void;
  get: <T>(key) => T | undefined;
  patch: (partial) => void;
  reset: () => void;
}
```

```tsx
// ✅ 唯一正确的读法
const useStore = createAppStore({ appId: 'pid-app', initialState: { progress: {} } });
const progress = useStore((s) => s.state.progress);

// ❌ 运行时崩白屏
const progress = useStore((s) => s.progress);              // s.progress 永远 undefined
```

`createAppStore` **必须在文件顶层**调用，不能放进 `App` 函数体。

**`useAppState<T>(key, defaultValue?)`** —— 返回 **`[value, setter]` 元组**，必须解构。

```tsx
// ✅
const [progress, setProgress] = useAppState<Record<string,'visited'|'done'>>('progress', {});

// ❌ 这些写法都会让 progress 是 [value, setter] 数组
const progress = useAppState('progress');
const progress = useAppState('progress') || {};
```

**`usePersistedState<T>(key, defaultValue)`** —— 签名同 `useState`，自动 `localStorage`，**组件级**用途。

**`useApp()`** —— 返回 `{ appId, appName, appStore, theme, settings, setSettings, resetProgress }`。

### 应用骨架（4 个）

**`<AppShell>`** props：`{ layout?: 'sidebar'|'topbar'|'workspace'; header?; sidebar?; statusBar?; drawer?; children; className?; maxWidth? }`。**没有** `style` prop。

**`<AppHeader>`** props：`{ title?; subtitle?; logo?; actions?; center?; sticky?; className? }`。

**`<AppSidebar>`** props：

```ts
{ items: AppSidebarItem[];
  activeId?: string;
  onChange?: (id: string) => void;        // ← 不是 onItemClick / onNavigate
  title?: string;
  progress?: { current: number; total: number };
  syncToStore?: boolean;
  className?: string; }

interface AppSidebarItem {
  id: string; label: string;
  description?: string; icon?: ReactNode;
  onSelect?: () => void; disabled?: boolean;
}
```

**没有**：`onItemClick / onNavigate / isOpen / onToggle / footer`。
item **没有**：`active / completed / stepNumber`。

**`<AppStatusBar>`** props：`{ left?; center?; right?; progress?: number; className? }`。**没有** `label / statusIcon`——文案放进 `left/center/right` 槽位。

### 应用反馈/设置（3 个）

**`<Onboarding>`** props：

```ts
{ steps: OnboardingStep[];
  storageKey?: string;
  onClose?: () => void;        // ← 不是 onComplete
  className?: string; }

interface OnboardingStep {
  title: string;
  body: string;                // ← 不是 description
  visual?: ReactNode;
}
```

**`<SettingsDrawer>`** props：`{ open; onOpenChange; sections?; extra?; widthClass?; className? }`。

**`<CompletionCelebration>`** props：`{ open; title?; message?; onClose?; autoCloseMs?; confirmLabel?; className? }`。

### 应用上下文 & 错误隔离

**`<AppProvider>`** props：`{ appId?; appName?; initialState?; storeVersion?; defaultSettings?; children }`。

**`<ComponentErrorBoundary name>`** —— 包裹每个业务组件渲染节点。

### 6 条致命反例（grep 自检）

```text
反例 1（Tutorial f361348d 崩白屏）：
  const progress = useStore((s) => s.progress);
  → 错；正确：useStore((s) => s.state.progress)

反例 2（Tutorial 844e98f0 崩 TypeError）：
  const p = useAppState('k') || {};
  → 错；正确：const [p, setP] = useAppState('k', {})

反例 3（Tutorial 844e98f0 / 1d2f9f9e Sidebar 不响应）：
  <AppSidebar onItemClick={...}>
  → 错；正确：<AppSidebar onChange={setSection}>

反例 4（Tutorial f361348d / 844e98f0 / 1d2f9f9e Onboarding 不可关闭）：
  <Onboarding steps={[{title, description}]} onComplete={...} />
  → 错；正确：<Onboarding steps={[{title, body}]} onClose={...} />

反例 5（Tutorial 1d2f9f9e / 844e98f0 StatusBar prop 错）：
  <AppStatusBar label="..." statusIcon={...} />
  → 错；正确：<AppStatusBar left={...} right={<Icon/>} />

反例 6（Tutorial 1d2f9f9e ReferenceError）：
  emit_event?.({ ... });
  → 错；emit_event 不是任何 SDK 导出，禁止使用。需要副作用就直接调 useStore.getState().set/patch
    或 setProgress 等本地状态。
```

### 写入前自检清单（不通过就别 workspace_write App.tsx）

- [ ] `useStore((s) => s.state.` —— 没有 `s.xxx` 直接访问
- [ ] 所有 `useAppState(` 都带 `const [v, setV] =` 解构
- [ ] `<AppSidebar` 上没有 `onItemClick` / `onNavigate` / `isOpen` / `onToggle`
- [ ] `<Onboarding` 没有 `onComplete`，step 字段是 `body` 不是 `description`
- [ ] `<AppStatusBar` 没有 `label` / `statusIcon`
- [ ] `<AppShell` 没有 `style={...}` prop
- [ ] 没有 `emit_event(` 调用
- [ ] 业务组件渲染都被 `<ComponentErrorBoundary name="...">` 包裹
- [ ] `createAppStore(...)` 在文件顶层（不在 `App` 函数体内）
