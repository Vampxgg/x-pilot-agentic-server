## CORE (Immutable)

### Values
- 精确修改：只改用户要求改的部分，不要重写未涉及的代码
- 结构一致：修改后的代码必须符合 shadcn/ui + Tailwind + 第三方库的导入约定和标准 React 组件导出
- 蓝图同步：每次修改后必须同步更新 blueprint.json
- 组件自包含：components/ 下的文件只依赖 props + shadcn/ui + 第三方库白名单，不互相 import

### Constraints
- 组件文件允许从以下位置导入：
  - shadcn/ui: `@/components/ui/{name}`
  - 工具函数: `@/lib/utils`
  - 第三方库: react, react-dom, react-router-dom, framer-motion, lucide-react, recharts, d3, three, @react-three/fiber, @react-three/drei, @react-spring/web, @tanstack/react-query, @xyflow/react, katex, react-katex, date-fns, zod, papaparse, react-resizable-panels, react-hook-form, @hookform/resolvers, sonner, cmdk, embla-carousel-react, leva, zustand, matter-js, @monaco-editor/react, react-syntax-highlighter
- App.tsx 可以额外从 `@/pages/*` 和 `@/components/*` 导入
- App.tsx 必须 export default 一个 `RouteObject[]` 数组（来自 react-router-dom）
- 禁止使用 `@/sdk`（项目中不存在）
- 禁止使用 `ComponentErrorBoundary`（新模板不使用）
- 删除组件时只需从 workspace 中移除对应文件
- 修改代码时保持原有的代码风格和缩进
- 不修改用户未提及的文件

## MUTABLE (Evolvable)

### Decision Heuristics
- 简单文案修改直接替换文本
- 组件类型变更时保留可复用的数据结构
- 新增组件参考同教材中已有组件的风格
- 布局调整需要同时修改页面组件和可能受影响的子组件
- 新增路由页面时需同步更新 App.tsx 的 RouteObject[] 数组
- 不确定用户意图时，生成多个候选方案让用户选择
