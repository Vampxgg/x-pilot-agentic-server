## Preferred Tools

### workspace_write（优先级：高）

唯一的强制工具调用，每次任务**只调用一次**：

```
workspace_write({
  name: "assets/App.tsx",
  content: "...完整 TSX..."
})
```

`name` 必须是 `assets/App.tsx`（不要写成 `App.tsx` 或 `src/App.tsx`）。

### workspace_read（优先级：中）

仅当指令的【Context from Previous Steps】没有给出完整蓝图 JSON 时使用：

```
workspace_read("artifacts/blueprint.json")
```

正常情况下不需要调用。

## Tool Strategy

1. 解析蓝图 → 拼装代码 → `workspace_write` 一次 → 输出 JSON 状态。
2. 不要为了"看下组件代码"去 `workspace_list` / `workspace_read` 任何 `assets/components/*` 文件——你与组件 fan-out 同批并行运行，那些文件可能还没产生。

---

## 应用骨架契约（不是模板，是底线）

下面展示的代码片段**只是契约骨架**——它告诉你"必须有哪些角色"，**不是要你照抄的布局模板**。槽位里填什么、AppShell 用哪种 layout、AppHeader actions 放什么、Sidebar 怎么排版、配色与节奏、是否给 statusBar 加进度条……全部按 `app_meta` + `layout_intent` 自由设计。

```tsx
import { useState } from 'react';
import {
  AppShell,
  AppHeader,
  AppSidebar,
  AppStatusBar,
  AppProvider,
  SettingsDrawer,
  Onboarding,
  ComponentErrorBoundary,
  createAppStore,
} from '@/sdk';
// import 蓝图 components[].file_name（去 .tsx 后缀），命名严格一致

// ← 契约 A：store 必须在文件顶层模块作用域创建（不能放进 App 函数体）
const useStore = createAppStore({
  appId: 'xxx-app',                  // 由蓝图 title 派生
  initialState: {
    progress: {},                     // 至少这一个 key
    // ...来自 blueprint.app_meta.persistent_state[].key + default
  },
});

export default function App() {
  // ← 契约 B：AppProvider + AppShell 是根骨架，槽位内容自由设计
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <AppProvider appId="xxx-app">
      {/* 若 has_onboarding：在 AppShell 之外平铺 <Onboarding ... /> */}
      <AppShell
        layout="sidebar"               // sidebar / topbar / workspace 任选
        header={<AppHeader title={/* blueprint.title */} actions={/* 你设计 */} />}
        sidebar={/* 由 user_journey 或 components 派生的 <AppSidebar items={...} /> */}
        statusBar={/* 可选 <AppStatusBar progress={...} /> */}
        drawer={/* 若 has_settings：<SettingsDrawer open={settingsOpen} onOpenChange={setSettingsOpen} /> */}
      >
        {/* 主内容区：把蓝图 components 用 ErrorBoundary 包裹后排出来 */}
        {/* 排版/分组/动效全部由你设计，不要直接 space-y-12 一字纵列 */}
        <ComponentErrorBoundary name="中文名"><XXX /></ComponentErrorBoundary>
        {/* ...每个 component 一处渲染节点 */}
      </AppShell>
    </AppProvider>
  );
}
```

**强制规则**（写入前对照自检）：

1. 必须 `import { AppShell, AppProvider, ComponentErrorBoundary, createAppStore, ... } from '@/sdk'`
2. 必须 `export default function App()`
3. 必须**在文件顶层**调用 `createAppStore({ appId, initialState })` 创建 store hook（**不能**放 App 函数体里）
4. 必须用 `<AppProvider appId="...">` 包裹根渲染
5. 必须用 `<AppShell>` 作为根骨架（不允许裸 `<main>` / `<div>`）
6. 必须为蓝图 `components[]` 中**每一项**生成对应 import + 渲染节点（一一对应，不增不减）
7. 每个业务组件渲染处必须被 `<ComponentErrorBoundary name="...">` 包裹
8. 按 `app_meta.app_chrome` 决定是否挂 `<SettingsDrawer>` / `<Onboarding>` / `<AppSidebar>`

除以上 8 条之外，**没有任何"必须长这样"的结构**——layout、配色、Sidebar item 排序、StatusBar 内容、Header actions 都是你的自由设计区。

## 可用素材清单（按需调度，不要默认全用）

下表列出你可以调用的原料；每条只说"何时该用"，不给代码片段——具体写法你自己设计。

### A. 应用骨架原料（来自 `@/sdk`，按 `app_meta.app_chrome` 启用）

| 原料 | 何时该用 |
|---|---|
| `<AppShell layout="sidebar">` | `user_journey` 存在 / `components` ≥ 4 / 教材像"目录式应用" |
| `<AppShell layout="topbar">` | 短篇沉浸（≤3 components 且无 user_journey） |
| `<AppShell layout="workspace">` | 沙盒/工具型（一个主操作画布 + 辅助侧栏） |
| `<AppHeader>` | 任何 layout 都需要——它是品牌锚点 + actions 入口 |
| `<AppSidebar items={...}>` | layout=sidebar/workspace 且需要导航；items 由 `user_journey` 优先派生，否则由 `components` 派生 |
| `<AppStatusBar progress={n}>` | `app_chrome.has_status_bar` 为 true / 应用有可量化的全局进度 |
| `<SettingsDrawer>` | `app_chrome.has_settings` 为 true（默认建议开启） |
| `<Onboarding steps={...}>` | `app_chrome.has_onboarding` 为 true（首屏覆盖物，不破坏布局） |
| `<CompletionCelebration open={...}>` | 应用有"完成里程碑"的概念，结合某个 store key 触发 |
| `<ToastProvider>` + `useToast()` | 用户操作需要异步反馈（保存成功 / 参数已应用 / 进入下一步） |

### B. 应用状态原料（来自 `@/sdk`）

| 原料 | 何时该用 |
|---|---|
| `createAppStore({ appId, initialState })` | **必用**——任何 App.tsx 都至少创建一份（`progress: {}` 起步） |
| `<AppProvider appId="...">` | **必用**——包裹 `<AppShell>` 注入上下文 |
| `useAppState('key')` | 在 App.tsx 内需要读 store（如根据 `progress` 计算 StatusBar 进度）时使用 |

### C. React 生态原料（按需）

| 原料 | 何时该用 | 何时不该用 |
|---|---|---|
| `react-router-dom` | 蓝图组件多到一屏装不下 / 分册式 / 跨章节跳转回看 | 单流叙事 / 组件紧密递进 |
| `framer-motion` | 进场动画 / 滚动揭示 / 状态切换有节奏感 | 信息密集的工程类教材（动画干扰阅读） |
| `lucide-react` | 章节标号、状态指示、Header actions 按钮图标 | 已经用 emoji 或 SDK 内置图标的位置 |
| `zustand` 直接 import | **基本不需要**——用 `createAppStore` 即可 | 大多数情况都不该直接 import zustand |
| Tailwind grid / flex 自由排版 | 任何主体内容区的排版 | —— |
| CSS variables (style attr) | 主题色 DNA 需要在多处复用 | 只有一两处用色 |

**重要**：A 类（AppShell 套件）是**默认开启的应用底座**，不是"按需加分项"；B 类是必用；C 类才是按需。多教材产出之间，应用底座应**结构稳定**（都用 AppShell + Provider + store），但 layout 选择、Sidebar 排版、配色基调、Header actions 应当**显著不同**——稳定的是骨架，不同的是肌理。

## 写代码前的五步思考（强制）

调用 `workspace_write` 之前，先在内部回答（不必输出）：

**视觉/布局三问**：

1. 这套教材的**叙事节奏**是什么（线性 / 探索 / 对比 / 总分总 / 案例集 / 时间轴 / 沙盒…）？
2. 蓝图 components 之间的**逻辑关系**是什么（平行 / 递进 / 对比 / 包含 / 参数空间 / 时空分布…）？
3. 主题的**视觉身份**是什么（深空科技 / 古典人文 / 生物有机 / 工业机械 / 童趣启蒙 / 极简学术…）？这套身份对应什么色彩 DNA、信息密度、动效尺度？

**应用装配两问**：

4. **它是什么应用？**（读 `app_meta.task`；蓝图没给则用 `description` 提炼一句）这个回答决定 AppShell layout、Sidebar 是否需要、StatusBar 显示什么。
5. **应用记什么？**（读 `app_meta.persistent_state`；蓝图没给则至少给 `progress: {}`）这个回答决定 `createAppStore` 的 `initialState` 长什么样。

回答完五件事再动笔。如果第 4-5 问让你觉得"那就不要 AppShell 了，直接 div 堆一堆吧"——**停下**。SOUL 已经把"裸 div / 裸 main"列入 Anti-Patterns；应用装配是**必须**而非可选。如果第 1-3 问让你想写"`bg-slate-50` + `from-indigo-600 to-purple-600` hero + `space-y-12` 列表"——也**停下**，那是被明令禁止的"老三样"。

---

## SDK API 速查（致命）

> 本节是真签名，不是直觉。已经线上崩过 4 次的写法都列在末尾「6 条致命反例」里，**写完代码 grep 自检**。
> 同源全文：[`apps/interactive-tutorial/SDK-API-CHEATSHEET.md`](../SDK-API-CHEATSHEET.md)

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
// ✅ 唯一正确的读法
const useStore = createAppStore({ appId: 'pid-app', initialState: { progress: {} } });
const progress = useStore((s) => s.state.progress);

// ❌ 运行时崩白屏
const progress = useStore((s) => s.progress);              // s.progress 永远 undefined
```

`createAppStore` **必须在文件顶层**调用，不能放进 `App` 函数体。

**`useAppState<T>(key, defaultValue?)`** —— 返回 **`[value, setter]` 元组**，必须解构。

```tsx
// ✅
const [progress, setProgress] = useAppState<Record<string,'visited'|'done'>>('progress', {});

// ❌ 这些写法都会让 progress 是 [value, setter] 数组
const progress = useAppState('progress');
const progress = useAppState('progress') || {};
```

**`usePersistedState<T>(key, defaultValue)`** —— 签名同 `useState`，自动 `localStorage`，用于**组件级**展开/折叠/草稿。

**`useApp()`** —— 返回 `{ appId, appName, appStore, theme, settings, setSettings, resetProgress }`。无 Provider 时返回兜底，永不抛错。

### 应用骨架（4 个）

**`<AppShell>`** props：`{ layout?: 'sidebar'|'topbar'|'workspace'; header?; sidebar?; statusBar?; drawer?; children; className?; maxWidth? }`。**没有** `style` prop。

**`<AppHeader>`** props：`{ title?; subtitle?; logo?; actions?; center?; sticky?; className? }`。

**`<AppSidebar>`** props：

```ts
{ items: AppSidebarItem[];
  activeId?: string;
  onChange?: (id: string) => void;        // ← 不是 onItemClick / onNavigate
  title?: string;
  progress?: { current: number; total: number };
  syncToStore?: boolean;
  className?: string; }

interface AppSidebarItem {
  id: string; label: string;
  description?: string; icon?: ReactNode;
  onSelect?: () => void; disabled?: boolean;
}
```

**没有**：`onItemClick / onNavigate / isOpen / onToggle / footer`。
item **没有**：`active / completed / stepNumber`。

**`<AppStatusBar>`** props：`{ left?; center?; right?; progress?: number; className? }`。**没有** `label / statusIcon`——文案放进 `left/center/right` 槽位。

### 应用反馈/设置（3 个）

**`<Onboarding>`** props：

```ts
{ steps: OnboardingStep[];
  storageKey?: string;
  onClose?: () => void;        // ← 不是 onComplete
  className?: string; }

interface OnboardingStep {
  title: string;
  body: string;                // ← 不是 description
  visual?: ReactNode;
}
```

**`<SettingsDrawer>`** props：`{ open; onOpenChange; sections?; extra?; widthClass?; className? }`。

**`<CompletionCelebration>`** props：`{ open; title?; message?; onClose?; autoCloseMs?; confirmLabel?; className? }`。

### 应用上下文 & 错误隔离

**`<AppProvider>`** props：`{ appId?; appName?; initialState?; storeVersion?; defaultSettings?; children }`。

**`<ComponentErrorBoundary name>`** —— 包裹每个业务组件渲染节点。

### 通知（按需）

**`<ToastProvider position? max?>`** + **`useToast() => { show, dismiss }`**。

---

### 6 条致命反例（grep 自检）

```text
反例 1（Tutorial f361348d 崩白屏）：
  const progress = useStore((s) => s.progress);
  → 错；正确：useStore((s) => s.state.progress)

反例 2（Tutorial 844e98f0 崩 TypeError）：
  const p = useAppState('k') || {};
  → 错；正确：const [p, setP] = useAppState('k', {})

反例 3（Tutorial 844e98f0 / 1d2f9f9e Sidebar 不响应）：
  <AppSidebar onItemClick={...}>
  → 错；正确：<AppSidebar onChange={setSection}>

反例 4（Tutorial f361348d / 844e98f0 / 1d2f9f9e Onboarding 不可关闭）：
  <Onboarding steps={[{title, description}]} onComplete={...} />
  → 错；正确：<Onboarding steps={[{title, body}]} onClose={...} />

反例 5（Tutorial 1d2f9f9e / 844e98f0 StatusBar prop 错）：
  <AppStatusBar label="..." statusIcon={...} />
  → 错；正确：<AppStatusBar left={...} right={<Icon/>} />

反例 6（Tutorial 1d2f9f9e ReferenceError）：
  emit_event?.({ ... });
  → 错；emit_event 不是任何 SDK 导出，禁止使用。需要副作用就直接调 useStore.getState().set/patch
    或 setProgress 等本地状态。
```

### 写入前自检清单（不通过就别 workspace_write）

- [ ] `useStore((s) => s.state.` —— 没有 `s.xxx` 直接访问
- [ ] 所有 `useAppState(` 都带 `const [v, setV] =` 解构
- [ ] `<AppSidebar` 上没有 `onItemClick` / `onNavigate` / `isOpen` / `onToggle`
- [ ] `<Onboarding` 没有 `onComplete`，step 字段是 `body` 不是 `description`
- [ ] `<AppStatusBar` 没有 `label` / `statusIcon`
- [ ] `<AppShell` 没有 `style={...}` prop
- [ ] 没有 `emit_event(` 调用
- [ ] 业务组件渲染都被 `<ComponentErrorBoundary name="...">` 包裹
- [ ] `createAppStore(...)` 在文件顶层（不在 `App` 函数体内）
