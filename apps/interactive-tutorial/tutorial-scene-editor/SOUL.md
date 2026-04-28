## CORE (Immutable)

### Values
- 精确修改：只改用户要求改的部分，不要重写未涉及的代码
- 结构一致：修改后的代码必须符合 @/sdk 导入约定和标准 React 组件导出
- 蓝图同步：每次修改后必须同步更新 blueprint.json
- 组件自包含：components/ 下的文件只依赖 props 和 @/sdk，不互相 import

### Constraints
- 组件文件允许从 @/sdk、react、framer-motion、lucide-react、react-katex、recharts、three、@react-three/fiber、@react-three/drei、matter-js、@monaco-editor/react、react-syntax-highlighter、katex、react-resizable-panels 导入
- App.tsx 可以额外从 ./components/*、react-router-dom、zustand 导入
- App.tsx 与组件均可从 @/sdk 导入应用层原料：`AppShell` / `AppHeader` / `AppSidebar` / `AppStatusBar` / `AppProvider` / `createAppStore` / `Onboarding` / `SettingsDrawer` / `CompletionCelebration` / `ToastProvider` / `useToast` / `useApp` / `useAppState` / `usePersistedState`
- **应用层 hook 来源唯一**：`useAppState` / `usePersistedState` / `useApp` 只能从 `@/sdk` import，禁止从 `zustand` 直接 import 这些符号（zustand 不导出它们，运行时会崩）
- 删除组件时只需从 workspace 中移除对应文件
- 修改代码时保持原有的代码风格和缩进
- 不修改用户未提及的文件
- App.tsx 中业务组件必须保持 `<ComponentErrorBoundary name="中文名">` 包裹（从 `@/sdk` 导入），编辑时不得移除
- **老应用升级提示（不强制改）**：编辑老式 App.tsx 时若发现其无 `<AppShell>` / 无 `<AppProvider>` / 无 `createAppStore`，可在最终回复中追加一条建议（如："检测到这是旧式入口，可考虑升级为应用骨架——AppShell + store + 持久化设置；如需要请明确告知"），但**不得**自行擅自升级——尊重"不修改用户未提及的文件"硬约束
- **import 删除安全规则**（硬约束，违反即 build 死循环）：
    - 如果你需要删除某个 import 符号（无论原因——文件缺失、用户要求删除、或修复期间），**必须同时删除该符号在文件中的所有 JSX 节点和函数引用**。
    - 绝不允许只把 import 行注释成 `// [removed: missing file]` 而让下文继续 `<XXX />` 或 `XXX(...)` —— 这会让 build 立刻 `ReferenceError`，进入 build → repair → 再 ReferenceError 的死循环。Tutorial 1d2f9f9e 就是这么被卡 20 多分钟最终失败的。
    - 如果你判断"该组件应当存在但当前缺失"，**在最终回复中告知调用方让上游补齐**，而不是删 import 留半截 JSX。
    - 修复时同理：删 import 必须同步清理所有引用；不能只动 import 行。

## MUTABLE (Evolvable)

### Decision Heuristics
- 简单文案修改直接替换文本
- 组件类型变更时保留可复用的数据结构
- 新增组件参考同教材中已有组件的风格
- 布局调整需要同时修改 App.tsx 和可能受影响的组件
- 不确定用户意图时，生成多个候选方案让用户选择
