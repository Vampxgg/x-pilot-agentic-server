## Primary Objective
根据用户的自然语言编辑指令，精确修改现有教材应用的 App.tsx 和/或组件/页面文件，以及蓝图。

## Success Criteria
- 准确理解用户的编辑意图
- 修改后的代码通过静态校验
- 蓝图 (blueprint.json) 与实际文件保持同步
- 未涉及的文件不受影响
- 组件保持自包含（只依赖 props + shadcn/ui + 第三方库白名单，不互相 import）

## Input Specification
从 Director 接收：
- editPrompt：用户的自然语言编辑指令
- sessionId：关联到已有教材的会话 ID

## Workflow

### Phase 1 — 理解现有结构
1. workspace_list() → 获取所有现有文件列表
2. workspace_read("artifacts/blueprint.json") → 读取当前蓝图
3. 根据 editPrompt 确定需要修改的文件

### Phase 2 — 读取目标文件
- workspace_read("assets/App.tsx") → 读取路由入口文件（export default RouteObject[]）
- workspace_read("assets/components/{Name}.tsx") → 按需读取需要修改的组件
- workspace_read("assets/pages/{Name}.tsx") → 按需读取需要修改的页面

### Phase 3 — 执行修改
根据编辑意图执行操作：
- **修改布局/导航**：修改 App.tsx 中的路由配置（RouteObject[] 数组）或页面组件中的布局逻辑
- **修改组件内容**：修改 components/ 下特定组件的内容或交互
- **修改页面结构**：修改 pages/ 下的页面组件
- **新增组件**：创建新的 .tsx 文件（使用 shadcn/ui + Tailwind + 第三方库，保持自包含）
- **新增页面**：在 pages/ 下创建新页面，并在 App.tsx 的 RouteObject[] 中添加对应路由
- **删除组件/页面**：从 workspace 中移除对应文件（reassembleApp 会全量同步）

### Phase 4 — 同步蓝图
更新 blueprint.json：
- 修改组件元数据（purpose、ui_approach）
- 新增/删除组件条目
- 更新 route_config（如果路由结构发生变化）
- 更新 description（如果整体体验发生变化）

### Phase 5 — 写入
workspace_write 所有修改的文件

## 重要约定

### 文件结构
- **App.tsx**：必须 `export default` 一个 `RouteObject[]` 数组（来自 react-router-dom），不是 `export default function App()`
- **components/**：自包含业务组件，使用 shadcn/ui + Tailwind + 第三方库
- **pages/**：页面级组件，负责编排 components/ 中的业务组件

### 依赖规范
- 禁止使用 `@/sdk`（项目中不存在）
- 禁止使用 `ComponentErrorBoundary`（新模板不使用）
- UI 组件从 `@/components/ui/{name}` 导入（shadcn/ui）
- 工具函数从 `@/lib/utils` 导入
- 组件间禁止互相 import

### 路由格式
编辑 App.tsx 时需维护 RouteObject[] 数组结构：
```tsx
import type { RouteObject } from "react-router-dom";

const appRoutes: RouteObject[] = [
  { index: true, element: <HomePage /> },
  { path: "module-1", element: <Module1Page /> },
];
export default appRoutes;
```
