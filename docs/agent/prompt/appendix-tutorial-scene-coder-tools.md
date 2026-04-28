# 附录：`tutorial-scene-coder` 的 Tool Usage Guidelines（完整原文）

与 `apps/interactive-tutorial/tutorial-scene-coder/TOOLS.md` 一致，供 `interactive-tutorial-simulated-flow.md` 第 7 节「# Tool Usage Guidelines」对照。

---

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

## App.tsx 编写约定（已升级为应用骨架契约）

> 本附录与 `tutorial-scene-coder/TOOLS.md` 的"App.tsx 应用骨架契约"对齐。详细骨架代码见该文件，本处仅列契约要点，避免漂移。

- `App.tsx` 是教学**应用**入口（不只是网页入口），必须用 `<AppShell>` 作为根骨架，并用 `<AppProvider appId="...">` 包裹。
- 必须在文件顶层调用 `createAppStore({ appId, initialState })` 创建 store hook，`initialState` 至少含 `progress: {}`，其余从 `blueprint.app_meta.persistent_state` 摊平而来。
- 按 `blueprint.app_meta.app_chrome` 决定是否挂 `<AppSidebar>` / `<AppStatusBar>` / `<SettingsDrawer>` / `<Onboarding>`。
- Import 范围：`./components/*`、`@/sdk`（含 `AppShell` / `AppHeader` / `AppSidebar` / `AppStatusBar` / `AppProvider` / `createAppStore` / `Onboarding` / `SettingsDrawer` / `CompletionCelebration` / `ToastProvider` / `useToast` / `useApp` / `useAppState` / `usePersistedState`）、以及 `react`、`react-router-dom`、`zustand` 等 SOUL 中允许的依赖。
- **应用层 hook 来源唯一**：`useAppState` / `usePersistedState` / `useApp` 只能从 `@/sdk` import，禁止从 `zustand` 直接 import 这些符号。
- 根组件须为：`export default function App()`（或等价的 default export）。
- 布局自由：layout 可选 `sidebar` / `topbar` / `workspace`；具体配色、Sidebar 排版、Header actions、StatusBar 内容由你按蓝图 `layout_intent` 与主题情绪自由设计——但骨架（AppShell + AppProvider + store）是必须的。
- 渲染每个业务组件时**必须**包裹 `<ComponentErrorBoundary name="中文名">`（来自 `@/sdk`），编辑时不得移除。

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
