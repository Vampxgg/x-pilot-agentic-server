## Core Values

- **代码可靠性**：交付物必须能通过 Vite 构建；类型与 import 路径正确，避免运行时明显错误。
- **SDK 纯度**：预置 UI/教学组件一律从 `@/sdk` 引入，不把业务组件当作共享库互相引用。
- **数据真实性**：数字、事实、引用以研究报告为准；可合理概括表述，但不编造来源与数据。
- **版式多样性**：不同主题采用不同的布局与视觉气质，避免千篇一律的模板感。
- **不做测评**：不生成测试页、考试页、成绩评定类页面（无 assessment 导向的整页结构）。

## Constraints

- 组件使用标准 React 导出：`export default` 或命名 `export` 均可，与 `App.tsx` 的 import 方式一致即可。
- **组件**允许 import：`@/sdk`、`react`、`framer-motion`、`lucide-react`、`react-katex`、`recharts`、`three`、`@react-three/fiber`、`@react-three/drei`、`matter-js`、`@monaco-editor/react`、`react-syntax-highlighter`、`katex`、`react-resizable-panels`。
- **App.tsx** 额外允许：`./components/*`、`react-router-dom`、`zustand`。
- 组件**不得** import 其他 `components/` 下的文件（自包含）。
- App.tsx 中渲染业务组件时**必须**用 `<ComponentErrorBoundary name="中文名">` 包裹（从 `@/sdk` 导入），确保单个组件出错不会导致整个页面崩溃。
- 禁止使用 `require()` 与动态 `import()`。
- JSX 中的中文引号须写成 `{"「」"}` / `{"“”"}` 等形式，避免直接在属性字符串里写未转义中文引号导致解析错误。
- 单个组件文件建议 **30–200** 行；`App.tsx` 建议 **50–500** 行。
- 每个组件自行负责内边距与局部布局（padding、间距），避免零边距贴死父级。

## Mutable Decision Heuristics

- 布局方式自由：单页滚动、分栏、卡片栅格、全屏章节等均可。
- 使用 **Tailwind CSS** 做层次、色彩与动效，按内容调性变化。
- 动效随内容风格变化（科技风偏克制、人文风可更柔和）。
- **科技/技术类**：可偏暗色、代码感、信息密度适中。
- **自然/人文类**：暖色、图文混排、留白与阅读节奏优先。
- **工程/运维类**：步骤化、仪表盘式、流程清晰。
- 适当使用 **lucide-react** 图标增强可读性与导航提示。
