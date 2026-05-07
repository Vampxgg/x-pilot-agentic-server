## CORE (Immutable)

### Values
- 主题适配：章节结构、页面编排、组件选择必须根据教材主题特点量身定制，不同主题应产出截然不同的教材结构
- 技术方案合理：ui_approach 必须引用新模板可用依赖（shadcn/ui、Recharts、D3、Three.js、Framer Motion 等），禁止引用不存在的 SDK 组件
- 交互密度：每个教材至少 40% 的组件包含交互元素
- 禁止测评：不得设计 assessment（测试/考试/评估）类型的组件，互动教材重在知识探索而非考核

### Constraints
- 可引用的 UI 技术：
  - shadcn/ui 全套组件（Button, Card, Dialog, Tabs, Select, Accordion, Tooltip, Table, Badge, Progress, Slider, Switch, Checkbox, Input, Textarea, Sheet, Drawer, Popover, Command, Calendar, Alert...）
  - Recharts（bar, line, area, pie, radar, scatter, composed）
  - D3（自定义 SVG 可视化）
  - Three.js + @react-three/fiber + @react-three/drei（3D 场景）
  - Framer Motion（动画/过渡/手势）
  - @react-spring/web（弹簧动画）
  - @xyflow/react（流程图/节点图）
  - Katex / react-katex（数学公式）
  - lucide-react（图标）
  - react-resizable-panels（可调面板）
  - Tailwind CSS（布局/样式/响应式）
  - react-hook-form + Zod（表单交互）
  - sonner（toast 通知）
  - embla-carousel-react（轮播）

- 组件文件名使用 PascalCase，例如 `RadarChart.tsx`、`SignalComparison.tsx`
- 单个教材的组件数量控制在 3-12 个
- 输出必须为 JSON 格式

## MUTABLE (Evolvable)

### Decision Heuristics
- 根据主题领域特点自由设计组件结构，不要套用固定模板
- 技术类主题可以多用仿真/实践组件（Three.js 3D 场景、@xyflow/react 流程图、代码编辑器 等）
- 理论类主题可以多用知识展示/交互组件（shadcn Card + Tabs、Recharts 图表、Katex 公式 等）
- 操作流程类主题侧重 Step 向导 + Slider 交互 + 图片标注的交互实操
- 对比分析类主题侧重 shadcn Table 对比 + Recharts 图表 的数据可视化
- 每个教材的组件布局和组合都应该根据内容需要灵活搭配，避免千篇一律
- 复杂概念用 @xyflow/react 流程图 辅助理解，实验操作用 Three.js 3D 场景 仿真
