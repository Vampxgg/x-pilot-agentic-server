# SDK API 速查（致命）

> **单一可信源**。所有 `interactive-tutorial` 流水线下游 agent（`tutorial-app-shell-coder` / `tutorial-scene-coder` / `tutorial-component-coder` / `tutorial-scene-editor`）都按本表落地代码。
>
> 本表覆盖 11 个新增应用层符号 + `ComponentErrorBoundary`，全部仅可从 `@/sdk` import。
> 不要凭直觉给 prop 名/返回值类型——下面写的是真签名，凭直觉乱写过的代码已经在线上崩过 4 次。

---

## 1. `createAppStore({ appId, initialState?, version?, ephemeral? })`

**返回**：`AppStoreHook` —— 既是 React selector hook，又是 zustand store。

**store 内部 state 形状**（关键，几乎所有 LLM 都写错过）：

```ts
interface AppStoreApi {
  state: AppState;             // ← 你存的所有 key 都在这里面
  set: (key, value) => void;
  get: <T>(key) => T | undefined;
  patch: (partial) => void;
  reset: () => void;
}
```

**正确读法**（必须经过 `s.state`）：

```tsx
const useStore = createAppStore({
  appId: 'pid-control',
  initialState: { progress: {}, params: { kp: 1 } },
});

// 读
const progress = useStore((s) => s.state.progress);          // ✅
const kp       = useStore((s) => s.state.params?.kp ?? 1);    // ✅

// 命令式读写（store API）
useStore.getState().get('progress');                          // ✅
useStore.getState().set('progress', { 'X': 'done' });        // ✅
useStore.getState().patch({ progress: {...} });               // ✅
```

**禁止写法**（运行时 `Cannot read properties of undefined`）：

```tsx
const progress = useStore((s) => s.progress);                 // ❌ 真实路径是 s.state.progress
Object.values(progress);                                       // ❌ progress 此时是 undefined
```

**`initialState` 至少给 `{ progress: {} }`**——蓝图 `app_meta.persistent_state` 中再加 key。

**store hook 必须在文件顶层模块作用域创建**，禁止放进 `App` 函数体（每次渲染都重建会丢状态）。

---

## 2. `useAppState<T>(key, defaultValue?)`

**返回 `[value, setter]` 元组**，签名与 `useState` 同。**必须解构**。

```tsx
const [progress, setProgress] = useAppState<Record<string, 'visited'|'done'>>('progress', {});  // ✅
setProgress((p) => ({ ...p, X: 'done' }));                                                       // ✅
```

**禁止写法**（progress 实际是数组 `[value, setter]`，对它调 `Object.values` 会拿到 `[]` 之后再 `.filter` 永远 0；当用作对象访问时立刻 `TypeError`）：

```tsx
const progress = useAppState('progress');                      // ❌ progress = [value, setter]
const progress = useAppState('progress') || {};                // ❌ 同上，数组永远不 falsy
const v = useAppState('alignment');                            // ❌
const yawOk = Math.abs(v.yaw) <= 0.5;                           // ❌ v.yaw 是 undefined → TypeError
```

`useAppState` 来自 `<AppProvider>` 内部 store；如果同时在文件顶层另起一个 `createAppStore`，二者**不是同一个 store**（仅 localStorage key 同名），mid-session 更新不会互相同步。**只挑一种**：要么 useAppState 全栈，要么顶层 useStore + 选择器全栈。

---

## 3. `usePersistedState<T>(key, defaultValue)`

**签名同 `useState`**，自动 `localStorage` 持久化（独立于 `createAppStore`）。适合**组件级**展开/折叠/Tab/草稿等局部状态。

```tsx
const [open, setOpen] = usePersistedState<boolean>('panel.open', false);  // ✅
```

不要把组件内部 UI 状态写进 `useAppState`——会污染应用全局 state。

---

## 4. `useApp()`

**返回**：

```ts
{
  appId: string;
  appName: string;
  appStore: AppStoreHook;
  theme: 'light' | 'dark' | 'system';
  settings: { theme, fontSize, animations };
  setSettings: (patch: Partial<AppSettings>) => void;
  resetProgress: () => void;
}
```

无 Provider 时返回兜底值，**不会抛错**——意味着 `useApp()` 永远 truthy。

---

## 5. `<AppShell>`

**Props**：

```ts
{
  layout?: 'sidebar' | 'topbar' | 'workspace';   // 默认 'sidebar'
  header?: ReactNode;
  sidebar?: ReactNode;
  statusBar?: ReactNode;
  drawer?: ReactNode;
  children: ReactNode;
  className?: string;
  maxWidth?: string;
}
```

**没有** `style` prop。要自定义颜色用 `className` + Tailwind 或 CSS variable。

```tsx
<AppShell layout="sidebar" header={...} sidebar={...} className="bg-slate-900">  // ✅
<AppShell style={{ background: '...' }}>                                          // ❌ 会被 TS 拒绝 / 静默忽略
```

---

## 6. `<AppHeader>`

```ts
{ title?: string; subtitle?: string; logo?: ReactNode;
  actions?: ReactNode; center?: ReactNode; sticky?: boolean; className?: string; }
```

---

## 7. `<AppSidebar>`

**Props**（绝大多数报错都来自这里）：

```ts
{
  items: AppSidebarItem[];
  activeId?: string;
  onChange?: (id: string) => void;       // ← 注意是 onChange，不是 onItemClick / onNavigate
  title?: string;
  progress?: { current: number; total: number };
  syncToStore?: boolean;
  className?: string;
}

interface AppSidebarItem {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
}
```

**没有**：`onItemClick` / `onNavigate` / `isOpen` / `onToggle` / `footer`。
item 上**没有**：`active`（用顶层 `activeId` 标识）/ `completed` / `stepNumber`。

```tsx
// ✅
<AppSidebar
  items={[{ id: 'intro', label: '导论', icon: <Book/> }, ...]}
  activeId={section}
  onChange={setSection}
/>

// ❌ 全是不存在的 prop / 字段
<AppSidebar
  items={[{ id: 'intro', label: '导论', active: true, completed: false }]}
  onItemClick={(id) => setSection(id)}
  isOpen={open}
  onToggle={() => setOpen(!open)}
  footer={<Logout/>}
/>
```

---

## 8. `<AppStatusBar>`

```ts
{
  left?: ReactNode;      // 槽位：左侧任意内容
  center?: ReactNode;
  right?: ReactNode;
  progress?: number;     // 0-100，显示在底部进度条
  className?: string;
}
```

**没有** `label` / `statusIcon` / `text` —— 要文案就放进 `left` / `center` / `right` 任一槽位。

```tsx
// ✅
<AppStatusBar
  left={<span>实训进度 {done}/{total}</span>}
  right={done === total ? <CheckCircle2 className="w-4 h-4 text-green-400"/> : null}
  progress={(done / total) * 100}
/>

// ❌
<AppStatusBar
  label={`进度 ${done}/${total}`}
  statusIcon={<CheckCircle2/>}
/>
```

---

## 9. `<Onboarding>`

```ts
{
  steps: OnboardingStep[];
  storageKey?: string;
  onClose?: () => void;       // ← 不是 onComplete
  className?: string;
}

interface OnboardingStep {
  title: string;
  body: string;               // ← 不是 description
  visual?: ReactNode;
}
```

```tsx
// ✅
<Onboarding
  steps={[{ title: '欢迎', body: '本应用将带你走完 4 个阶段', visual: <Hero/> }]}
  storageKey="radar-onboarding-v1"
  onClose={() => setOnboardingDone(true)}
/>

// ❌
<Onboarding
  steps={[{ title: '欢迎', description: '本应用…' }]}
  onComplete={() => setDone(true)}
/>
```

---

## 10. `<SettingsDrawer>`

```ts
{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections?: ReactNode;
  extra?: ReactNode;
  widthClass?: string;
  className?: string;
}
```

主题/字号/动效切换由 `useApp().setSettings(...)` 内部驱动，不需要传额外 prop。

---

## 11. `<CompletionCelebration>`

```ts
{
  open: boolean;
  title?: string;
  message?: string;
  onClose?: () => void;
  autoCloseMs?: number;
  confirmLabel?: string;
  className?: string;
}
```

---

## 12. `<ToastProvider>` + `useToast()`

```tsx
<ToastProvider position="top-right" max={3}>
  <App />
</ToastProvider>

const { show, dismiss } = useToast();
show({ title: '已保存', variant: 'success' });
```

---

## 13. `<ComponentErrorBoundary>`

```ts
{ name: string; children: ReactNode; }
```

每个业务组件渲染处**必须**用它包裹，`name` 给中文标识。

```tsx
<ComponentErrorBoundary name="动态标定与路试">
  <RadarDynamicCalibration />
</ComponentErrorBoundary>
```

---

## 14. `<AppProvider>`

```ts
{
  appId?: string;                   // 默认 'default-app'，多应用务必显式
  appName?: string;
  initialState?: AppState;          // 给 useAppState 用的初始 state
  storeVersion?: number;
  defaultSettings?: Partial<AppSettings>;
  children: ReactNode;
}
```

包裹 `<AppShell>`，是 `useApp` / `useAppState` 的上下文源。

---

## 6 条致命反例（都是真实崩过的代码）

```text
反例 1（Tutorial f361348d 崩白屏）：
  const progress = useStore((s) => s.progress);
  → 错；正确：useStore((s) => s.state.progress)

反例 2（Tutorial 844e98f0 崩 TypeError）：
  const p = useAppState('k') || {};
  → 错；正确：const [p, setP] = useAppState('k', {})

反例 3（Tutorial 844e98f0 / 1d2f9f9e Sidebar 不响应）：
  <AppSidebar onItemClick={(id) => setSection(id)}>
  → 错；正确：<AppSidebar onChange={setSection}>

反例 4（Tutorial f361348d / 844e98f0 / 1d2f9f9e Onboarding 不可关闭）：
  <Onboarding steps={[{title, description}]} onComplete={...} />
  → 错；正确：<Onboarding steps={[{title, body}]} onClose={...} />

反例 5（Tutorial 1d2f9f9e / 844e98f0 StatusBar 报 prop 错）：
  <AppStatusBar label="..." statusIcon={...} />
  → 错；正确：<AppStatusBar left={<>...</>} right={<Icon/>} />

反例 6（Tutorial 1d2f9f9e ReferenceError）：
  emit_event?.({ ... });
  → 错；emit_event 不是任何 SDK 导出，禁止使用全局回调。需要副作用就直接调用 useStore 的 set/patch，
    或在 useEffect 中走 setProgress 等本地状态。
```

---

## 自检清单（写完 App.tsx 之前 grep 一遍）

- [ ] `useStore((s) => s.state.` —— 没有任何 `s.progress` 直接访问
- [ ] 任何 `useAppState(` 调用都带 `const [v, setV] =` 解构
- [ ] `<AppSidebar` 上没有 `onItemClick` / `onNavigate` / `isOpen` / `onToggle`
- [ ] `<Onboarding` 上没有 `onComplete`，step 字段是 `body` 不是 `description`
- [ ] `<AppStatusBar` 上没有 `label` / `statusIcon`
- [ ] `<AppShell` 上没有 `style={...}` prop
- [ ] 没有调用 `emit_event`
- [ ] 业务组件渲染都被 `<ComponentErrorBoundary name="...">` 包裹
- [ ] `createAppStore(...)` 在文件顶层（不在 `App` 函数体内）
