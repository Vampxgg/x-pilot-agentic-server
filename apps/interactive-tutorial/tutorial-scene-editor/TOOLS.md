## Preferred Tools

### workspace_list（优先级：高）
列出当前教材的所有文件
- 首先调用，了解教材完整结构

### workspace_read（优先级：高）
读取蓝图和应用代码
- artifacts/blueprint.json — 必读
- assets/App.tsx — 按需读取
- assets/components/**/*.tsx — 按需读取需要修改的组件

### workspace_write（优先级：高）
写入修改后的文件
- 修改后的 App.tsx 和/或组件 .tsx 文件
- 更新后的 blueprint.json

## Tool Strategy
1. workspace_list → 了解全局
2. workspace_read → 读取蓝图 + 目标文件
3. 推理 → 确定修改方案
4. workspace_write → 写入所有变更

## 编辑老式 App.tsx 的升级提示（启发式行为）

当用户的编辑指令涉及 App.tsx，且当前 App.tsx 满足以下任一条件——

- 没有 `import { AppShell } from '@/sdk'`
- 没有 `<AppProvider>` 包裹
- 没有 `createAppStore({...})` 调用
- 根容器是裸 `<main>` / `<div className="min-h-screen ...">`

——这表明它是按旧范式生成的"网页式"入口。可以在**完成用户明确请求的修改之后**，在最终回复中追加一条**建议性**短句：

> "检测到这是旧式应用入口（无 AppShell / 无 AppProvider / 无 createAppStore），可考虑升级为应用骨架以获得持久化进度、设置抽屉与统一导航；如需要请明确告知。"

**绝不**主动改写 App.tsx 的整体结构——除非用户在指令中明确要求"升级到应用骨架"或类似措辞。这是"不修改用户未提及的文件"硬约束的延伸：未明示授权 = 不动整体结构。

---

## SDK API 速查（致命）

> 同源全文：[`apps/interactive-tutorial/SDK-API-CHEATSHEET.md`](../SDK-API-CHEATSHEET.md)
>
> 你做的是**编辑老应用**，最容易踩两类雷：
> 1. 用户让你"加个 store / 加个 sidebar"，你按直觉写出错误 prop —— 直接看下面表格。
> 2. 用户让你"删除某个组件"，你只删了 import 但留下了 JSX 引用 —— 看下面 *import 删除安全规则*。

### 状态层（4 个）

**`createAppStore({ appId, initialState?, version?, ephemeral? })`** —— 返回 selector hook + zustand store。

```ts
interface AppStoreApi {
  state: AppState;                   // ← 你存的 key 都在 s.state 里，不是 s.xxx
  set: (key, value) => void;
  get: <T>(key) => T | undefined;
  patch: (partial) => void;
  reset: () => void;
}
```

```tsx
// ✅ 正确读法
const useStore = createAppStore({ appId: 'pid-app', initialState: { progress: {} } });
const progress = useStore((s) => s.state.progress);

// ❌ 运行时崩白屏
const progress = useStore((s) => s.progress);
```

`createAppStore` 必须在文件顶层，不能放进函数体。

**`useAppState<T>(key, defaultValue?)`** —— 返回 **`[value, setter]` 元组**，必须解构。

```tsx
const [progress, setProgress] = useAppState<Record<string,'visited'|'done'>>('progress', {});  // ✅
const progress = useAppState('progress');                                                       // ❌
```

**`usePersistedState<T>(key, defaultValue)`** —— 签名同 `useState`，组件级 `localStorage`。

**`useApp()`** —— 返回 `{ appId, appName, appStore, theme, settings, setSettings, resetProgress }`。

### 应用骨架（4 个）

- **`<AppShell>`** props：`{ layout?: 'sidebar'|'topbar'|'workspace'; header?; sidebar?; statusBar?; drawer?; children; className?; maxWidth? }`。**没有** `style`。
- **`<AppHeader>`** props：`{ title?; subtitle?; logo?; actions?; center?; sticky?; className? }`。
- **`<AppSidebar>`** props：`{ items; activeId?; onChange?(id); title?; progress?; syncToStore?; className? }`。**没有** `onItemClick / onNavigate / isOpen / onToggle / footer`。item 字段：`{ id, label, description?, icon?, onSelect?, disabled? }`，**没有** `active / completed / stepNumber`。
- **`<AppStatusBar>`** props：`{ left?; center?; right?; progress?; className? }`。**没有** `label / statusIcon`。

### 应用反馈/设置（3 个）

- **`<Onboarding>`** props：`{ steps; storageKey?; onClose?; className? }`。step：`{ title, body, visual? }`。`onClose` 不是 `onComplete`；step 字段是 `body` 不是 `description`。
- **`<SettingsDrawer>`** props：`{ open; onOpenChange; sections?; extra?; widthClass?; className? }`。
- **`<CompletionCelebration>`** props：`{ open; title?; message?; onClose?; autoCloseMs?; confirmLabel?; className? }`。

### 应用上下文 & 错误隔离

- **`<AppProvider>`** props：`{ appId?; appName?; initialState?; storeVersion?; defaultSettings?; children }`。
- **`<ComponentErrorBoundary name>`** —— 编辑时不得移除（SOUL 硬约束）。

### 6 条致命反例（编辑时遇到必须修对，不要保留原样）

```text
反例 1：useStore((s) => s.progress)
  → 错；正确：useStore((s) => s.state.progress)

反例 2：const p = useAppState('k') || {}
  → 错；正确：const [p, setP] = useAppState('k', {})

反例 3：<AppSidebar onItemClick={...}>
  → 错；正确：<AppSidebar onChange={setSection}>

反例 4：<Onboarding steps={[{title, description}]} onComplete={...} />
  → 错；正确：<Onboarding steps={[{title, body}]} onClose={...} />

反例 5：<AppStatusBar label="..." statusIcon={...} />
  → 错；正确：<AppStatusBar left={...} right={<Icon/>} />

反例 6：emit_event?.({ ... })
  → 错；emit_event 不是 SDK 导出，禁用。改为 setProgress / appStore.getState().set。
```

### import 删除安全规则（避免 build 死循环）

如果你需要删除某个 import 符号（无论原因——文件缺失、用户要求删除、或修复期间），**必须同时删除该符号在文件中的所有 JSX 节点和函数调用引用**。

绝不允许只把 import 行注释成 `// [removed: missing file]` 而让下文继续 `<XXX />` —— 这会让 build 立刻 `ReferenceError`，进入 build → repair 死循环（参见 Tutorial 1d2f9f9e 的死亡链路：repair 用了 20 多分钟也没收敛）。

如果你判断"该组件应当存在但当前缺失"，**在最终回复中告知调用方让上游补齐**，而不是删 import 留半截 JSX。

### 写入前自检清单

- [ ] `useStore((s) => s.state.` —— 没有 `s.xxx` 直接访问
- [ ] 所有 `useAppState(` 都带 `const [v, setV] =` 解构
- [ ] `<AppSidebar` 上没有 `onItemClick` / `onNavigate` / `isOpen` / `onToggle`
- [ ] `<Onboarding` 没有 `onComplete`，step 字段是 `body`
- [ ] `<AppStatusBar` 没有 `label` / `statusIcon`
- [ ] `<AppShell` 没有 `style={...}` prop
- [ ] 没有 `emit_event(` 调用
- [ ] 业务组件渲染都被 `<ComponentErrorBoundary name="...">` 包裹（编辑时不得移除）
- [ ] 没有"import 注释了但 JSX 还在用"的残骸
- [ ] `createAppStore(...)` 在文件顶层（不在 `App` 函数体内）
