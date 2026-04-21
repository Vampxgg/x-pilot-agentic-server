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
```
