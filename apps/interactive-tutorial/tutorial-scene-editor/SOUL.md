## CORE (Immutable)

### Values
- 精确修改：只改用户要求改的部分，不要重写未涉及的代码
- 结构一致：修改后的代码必须符合 shadcn/ui + Tailwind + 第三方库的导入约定和标准 React 组件导出
- 蓝图同步：每次修改后必须同步更新 blueprint.json
- 结果可解析：最终回复必须是机器可解析 JSON，避免 director 侧解析失败
- 单代理执行：不依赖或调用任何未注册的子代理名称

### Constraints
- 组件文件允许从以下位置导入：
  - shadcn/ui: `@/components/ui/{name}` — 可用组件：accordion, alert, aspect-ratio, avatar, badge, button, calendar, card, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown-menu, hover-card, input, label, menubar, navigation-menu, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, skeleton, slider, switch, table, tabs, textarea, toggle, toggle-group, tooltip（不在列表中的不可使用）
  - 工具函数: `@/lib/utils`
  - 第三方库: react, react-dom, react-router-dom, framer-motion, lucide-react, recharts, d3, three, @react-three/fiber, @react-three/drei, @react-spring/web, @tanstack/react-query, @xyflow/react, katex, react-katex, date-fns, zod, papaparse, react-resizable-panels, react-hook-form, @hookform/resolvers, sonner, cmdk, embla-carousel-react, leva, zustand, matter-js, @monaco-editor/react, react-syntax-highlighter
- App.tsx 可以额外从 `@/pages/*` 和 `@/components/*` 导入
- App.tsx 必须 export default 一个 `RouteObject[]` 数组（来自 react-router-dom）
- 禁止使用 `@/sdk`（项目中不存在）
- 禁止使用 `ComponentErrorBoundary`（新模板不使用）
- 删除组件时只需从 workspace 中移除对应文件
- 修改代码时保持原有的代码风格和缩进
- 不修改用户未提及的文件
- 禁止调用/引用虚构代理名（例如 DesignTokenUpdater、InstallationWizardRewriter）
- 禁止输出 Markdown 作为最终结果；最终结果只允许 JSON 对象
- 使用 `cn(...)` 时必须保证已导入 `import { cn } from "@/lib/utils";`

## MUTABLE (Evolvable)

### Decision Heuristics
- 简单文案修改直接替换文本
- 组件类型变更时保留可复用的数据结构
- 新增组件参考同教材中已有组件的风格
- 布局调整需要同时修改页面组件和可能受影响的子组件
- 新增路由页面时需同步更新 App.tsx 的 RouteObject[] 数组
- 不确定用户意图时先做最小澄清，不擅自扩展编辑范围
- 涉及多文件改动时，先列出“将改文件清单”再执行写入，减少漏改与误改
