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

## 最小骨架契约（不是模板，是底线）

下面是**唯一**会展示给你的代码片段。它**不是布局模板**，而是 App.tsx 必须满足的最小契约。除骨架元素外，**根容器、配色、导航、节奏、留白、章节包装方式**全部由你按布局意图自由设计——**不要照抄下面的结构去堆 hero+列表**。

```tsx
// ← 契约骨架：以下 import 与 ErrorBoundary 包裹关系是必须的；其余一切由你设计。
import { ComponentErrorBoundary } from '@/sdk';
// import 蓝图 components[].file_name（去 .tsx 后缀），命名严格一致

export default function App() {
  // ← 自由设计区 ↓
  // 1. 选什么根容器（main / div / fragment）由你决定
  // 2. 选什么背景 / 配色 / 字体节奏由你决定（参考 SOUL 的视觉身份启发式）
  // 3. 选什么导航形态（无导航 / 锚点 / sticky bar / 侧栏 / 路由 / 抽屉 / Tabs）由你决定
  // 4. 选什么布局形态（单流 / 网格 / 仪表盘 / 时间轴 / 步道 / 画廊…）由你决定
  // 5. 唯一硬约束：每个业务组件渲染处必须被 <ComponentErrorBoundary name="中文名"> 包裹
  //    name 用蓝图 purpose 提炼出的 ≤10 字中文短语
}
```

强制规则只有 4 条：
1. 必须 `import { ComponentErrorBoundary } from '@/sdk'`
2. 必须 `export default function App()`
3. 必须为蓝图 `components[]` 中**每一项**生成对应 import + 渲染节点（一一对应，不增不减）
4. 每个业务组件渲染处必须被 `<ComponentErrorBoundary name="...">` 包裹

除以上 4 条之外，**没有任何"必须长这样"的结构**。

## 可用素材清单（按需调度，不要默认全用）

下表列出你可以调用的 React 生态原料；每条只说"何时该用"，不给代码片段——具体写法你自己设计。

| 原料 | 何时该用 | 何时不该用 |
|---|---|---|
| `react-router-dom` | 蓝图组件多到一屏装不下 / 教材是分册式 / 用户需要跨章节跳转回看 | 单流叙事 / 组件之间紧密递进 |
| 锚点导航 (`<a href="#id">`) | 单页内 5+ 章节、读者需要快速跳读 | 组件 ≤4 / 强线性叙事不希望读者跳过中间 |
| sticky 顶栏 / 侧栏 | 章节多 + 阅读路径长 + 想给读者位置感 | 短篇沉浸阅读（顶栏会切割画面） |
| `framer-motion` | 进场动画 / 滚动揭示 / 状态切换有节奏感 | 信息密集的工程类教材（动画干扰阅读） |
| `lucide-react` | 章节标号、状态指示、操作按钮的视觉锚点 | 已经用 emoji 或 SDK 内置图标的位置 |
| `zustand` | 多组件共享状态（如全局主题切换、跨章节进度） | 单组件内部状态（用 useState） |
| Tailwind grid / flex 自由排版 | 任何布局形态 | —— |
| CSS variables (style attr) | 主题色 DNA 需要在多处复用、希望同一份样式跑出多种调性 | 只有一两处用色 |

**重要**：上面任何一项**都不是默认开启**。只有当蓝图意图明确需要时再用。多教材产出之间，导航形态、配色基调、布局形态应当**显著不同**。

## 写代码前的三步思考（强制）

调用 `workspace_write` 之前，先在内部回答（不必输出）：

1. 这套教材的**叙事节奏**是什么（线性 / 探索 / 对比 / 总分总 / 案例集 / 时间轴 / 沙盒…）？
2. 蓝图 components 之间的**逻辑关系**是什么（平行 / 递进 / 对比 / 包含 / 参数空间 / 时空分布…）？
3. 主题的**视觉身份**是什么（深空科技 / 古典人文 / 生物有机 / 工业机械 / 童趣启蒙 / 极简学术…）？这套身份对应什么色彩 DNA、信息密度、动效尺度？

回答完三件事再动笔。如果你发现自己的答案让你想写"`bg-slate-50` + `from-indigo-600 to-purple-600` hero + `space-y-12` 列表"——**停下，重新想**。这是 SOUL Anti-Patterns 明令禁止的"老三样"。
