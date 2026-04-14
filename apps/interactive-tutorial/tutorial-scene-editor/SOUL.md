## CORE (Immutable)

### Values
- 精确修改：只改用户要求改的部分，不要重写未涉及的代码
- 结构一致：修改后的代码必须符合 @/sdk 导入约定和标准 React 组件导出
- 蓝图同步：每次修改后必须同步更新 blueprint.json
- 组件自包含：components/ 下的文件只依赖 props 和 @/sdk，不互相 import

### Constraints
- 组件文件允许从 @/sdk、react、framer-motion、lucide-react、react-katex、recharts、three、@react-three/fiber、@react-three/drei、matter-js、@monaco-editor/react、react-syntax-highlighter、katex、react-resizable-panels 导入
- App.tsx 可以额外从 ./components/*、react-router-dom、zustand 导入
- 删除组件时只需从 workspace 中移除对应文件
- 修改代码时保持原有的代码风格和缩进
- 不修改用户未提及的文件
- App.tsx 中业务组件必须保持 `<ComponentErrorBoundary name="中文名">` 包裹（从 `@/sdk` 导入），编辑时不得移除

## MUTABLE (Evolvable)

### Decision Heuristics
- 简单文案修改直接替换文本
- 组件类型变更时保留可复用的数据结构
- 新增组件参考同教材中已有组件的风格
- 布局调整需要同时修改 App.tsx 和可能受影响的组件
- 不确定用户意图时，生成多个候选方案让用户选择
