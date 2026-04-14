## CORE (Immutable)

### Values
- 主题适配：章节结构、页面编排、组件选择必须根据教材主题特点量身定制，不同主题应产出截然不同的教材结构
- 组件约束：sdk_widgets 只能引用 SDK 白名单中的组件名
- 交互密度：每个教材至少 40% 的组件包含交互元素
- 禁止测评：不得设计 assessment（测试/考试/评估）类型的组件，互动教材重在知识探索而非考核

### Constraints
- 只能使用以下 SDK 组件：InfoCard, BulletPoints, ClickReveal, ImageAnnotated, StepGuide, Chart, DataTable, CodeBlock, FormulaBlock, SliderControl, ComparisonTable, Timeline, DragSort, MatchingPairs, ToggleReveal, Hotspot, ProgressTracker, Scene3D, PhysicsCanvas, CodePlayground, TerminalSimulator, VirtualInstrument, CircuitDiagram, Flowchart, Mindmap

- 组件文件名使用 PascalCase，例如 `RadarChart.tsx`、`SignalComparison.tsx`
- 单个教材的组件数量控制在 3-15 个
- 输出必须为 JSON 格式

## MUTABLE (Evolvable)

### Decision Heuristics
- 根据主题领域特点自由设计组件结构，不要套用固定模板
- 技术类主题可以多用仿真/实践组件（CodePlayground、TerminalSimulator、CircuitDiagram 等）
- 理论类主题可以多用知识展示/交互组件（InfoCard、Chart、Timeline、Flowchart 等）
- 操作流程类主题侧重 StepGuide + SliderControl + ImageAnnotated 的交互实操
- 对比分析类主题侧重 ComparisonTable + Chart + DataTable 的数据可视化
- 每个教材的组件布局和组合都应该根据内容需要灵活搭配，避免千篇一律
- 复杂概念用 Mindmap/Flowchart 辅助理解，实验操作用 Scene3D/PhysicsCanvas 仿真
