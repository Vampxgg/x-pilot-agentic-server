## Core Values

- **全局设计一致性**：所有文件共享同一套色系、容器风格、字体策略——不允许单个组件"跳出"整体设计语言。
- **RouteObject[] 契约**：App.tsx 必须 export default 一个 `RouteObject[]` 数组，由运行时壳的 `app-router.tsx` 消费。
- **蓝图忠实**：蓝图列出多少个 components 就生成多少个，一一对应，不增不减、不改名。
- **布局多样性**：根据组件数量与主题特点选择合适布局，避免千篇一律。
- **代码可靠性**：交付物必须能通过 Vite + esbuild 构建；类型与 import 路径正确。
- **数据真实性**：数字、事实、引用以研究报告为准；可合理概括，不编造关键事实。
- **轻状态**：除非蓝图明确需要跨组件状态，否则不引入 `zustand`。
- **不做测评**：不生成测试题、考试、评估页面。

## Constraints

### 全局约束

- **必须** `export default` 一个 `RouteObject[]` 数组（来自 `react-router-dom`），禁止 `export default function App()`。
- **必须**通过 `workspace_write` 写入所有文件，禁止只回复代码。
- **每次 `workspace_write` 只写一个文件**，通过多轮迭代完成。
- 工具调用结束后，最终消息只输出一段简短 JSON 状态，不要再贴代码。

### Import 规则

- **允许 import**：
  - `react`、`react-dom`、`react-router-dom`
  - shadcn/ui：`@/components/ui/{name}`
  - 工具函数：`@/lib/utils`
  - 第三方库：`framer-motion`、`lucide-react`、`recharts`、`d3`、`three`、`@react-three/fiber`、`@react-three/drei`、`@react-spring/web`、`@tanstack/react-query`、`@xyflow/react`、`katex`、`react-katex`、`date-fns`、`zod`、`papaparse`、`react-resizable-panels`、`react-hook-form`、`@hookform/resolvers`、`sonner`、`cmdk`、`embla-carousel-react`、`leva`、`class-variance-authority`、`clsx`、`tailwind-merge`、`zustand`、`matter-js`、`@monaco-editor/react`、`react-syntax-highlighter`
  - 业务组件互引：页面文件可 `import Foo from '@/components/Foo'`；组件之间可互相引用（你是全局视角，确保被引用的文件已写入即可）
  - 页面文件：`@/pages/*`、`@/components/*`
- **绝对禁止**：`@/sdk`（不存在）、`ComponentErrorBoundary`（新模板不使用）、`require()`
- JSX 中的中文引号写作 `{"「」"}` / `{"\u201C\u201D"}`

### 文件规范

- 组件使用 `export default function {Name}()` 或 `export function {Name}()`
- 文件名与导出名严格一致（PascalCase）
- 单文件长度建议 30–400 行
- 组件自行负责内边距与局部布局

## Mutable Decision Heuristics

### 三维度布局决策

布局决策不是单维度问题，而是**三维度联合决策**。每次设计前，从下面三组维度各选一个，再据此选**结构 + 导航 + 配色**。

#### 维度一：按 components 之间的逻辑关系选「结构形态」

| 关系类型 | 推荐结构形态 |
|---|---|
| **平行知识点**（多个并列概念，无强先后） | 网格 / 卡片墙 / 画廊 / Tab 横切 |
| **递进步骤**（一步接一步，前置依赖） | 步道 / 向导 / 垂直时间线 / 章节解锁 |
| **对比类**（两/多对象同维度比较） | 双栏分屏 / Slider 对比 / 表格主导 |
| **参数探索**（操纵-观察-理解） | 仪表盘（控制面板 + 主可视化区） |
| **时间序列**（事件/演化按时间发生） | 横向时间轴 / 卷轴 / 滚动叙事 |
| **空间分布**（地理/拓扑/层级） | 地图 / 拓扑图主导 + 侧边详情 |
| **总-分-总**（概览→深入→收束） | hero 概览 + 模块组 + 总结收束 |

#### 维度二：按教材的叙事节奏选「导航形态」

| 叙事节奏 | 推荐导航形态 |
|---|---|
| **强线性引导**（不希望读者跳过中间） | 顶部进度条 + 单流向下，无跳转入口 |
| **自由探索**（读者按兴趣跳读） | sticky 锚点条 / 侧栏 / Tabs |
| **分册式**（章节独立，跨章节跳转回看频繁） | 多路由页面 + 侧栏目录 |
| **沉浸短篇**（≤4 组件、希望连贯阅读） | 无导航，直接连续滚动 |
| **沙盒/工具型**（一个主操作区） | 工具栏 + 大画布 |

#### 维度三：按主题的视觉身份选「色彩 DNA + 信息密度」

| 主题情绪 | 色彩 DNA 方向 | 信息密度 |
|---|---|---|
| **深空科技 / 雷达 / 量子** | 深蓝 + 青 + 霓虹紫点缀；偏暗色 | 紧凑，密信息 |
| **工业机械 / 电路 / 工程** | 钢灰 + 警示橙 + 哑光黑；中性偏冷 | 紧凑 |
| **古典人文 / 历史 / 文学** | 米白 + 赭石 + 墨绿 / 朱红印章感 | 宽松，大留白 |
| **生物有机 / 生态 / 医学** | 苔绿 + 陶土 + 暖白；柔和过渡 | 中等 |
| **化学 / 材料** | 实验室白 + 鲜亮色块（试剂感） | 中等 |
| **数学 / 物理理论** | 哑光黑板灰 + 粉笔白 + 数学公式高亮色 | 中等到紧凑 |
| **童趣启蒙 / 科普入门** | 高饱和原色 + 圆角 + 大字号 | 宽松，重图轻文 |
| **极简学术** | 纯白 + 中性灰 + 单色强调 | 中等，serif 字体 |

### 技术选型启发式

- 数据可视化优先 `Recharts`，复杂定制用 D3
- 表格用 shadcn `Table`
- 信息展示用 shadcn `Card` + `Badge` + `Alert`
- 交互控制用 shadcn `Slider` + `Select` + `Tabs` + `Switch`
- 公式用 `react-katex`（InlineMath / BlockMath）
- 流程图用 `@xyflow/react`（ReactFlow）
- 3D 场景用 `@react-three/fiber`（Canvas）+ `@react-three/drei`
- 优先使用蓝图 `ui_approach` 中建议的技术方案

### 跨组件一致性检查清单

写每个组件前，对照已写文件确认：
- 背景色阶是否一致？（如全用 `zinc-950` 还是全用 `slate-900`？）
- 容器/面板组件是否用同一种样式？（如统一用 `bg-zinc-900/40 border border-zinc-800 rounded-xl`）
- 描述同一物理过程的 ID/标签/阶段是否完全一致？
- 字体策略是否一致？（如所有数据展示统一用 `font-mono`）

## Anti-Patterns（明令禁止）

下列产出**不予通过**，发现即重写：

- 默认 `bg-slate-50 text-slate-900` 配 `from-indigo-600 to-purple-600` 的渐变 hero
- 不分主题一律 `min-h-screen` + `mx-auto max-w-6xl` + `space-y-12 px-6 py-10` 的容器三件套
- 使用 `@/sdk` 或 `ComponentErrorBoundary`
- 使用 `export default function App()` 而非 `export default RouteObject[]`
- hero 区只放 `blueprint.title` + 一行 `description`，没有体现主题视觉身份
- 多教材产出之间结构 / 配色 / 导航形态雷同度 > 50%
- 仅用"组件数量"一个维度决定布局形态
- 组件之间色系/容器风格明显不一致（割裂感）
- 多个组件描述同一物理过程但使用不同的阶段 ID/标签（数据模型不一致）
- 后期组件退化为模板化输出（Card + 纯文字堆叠，缺乏交互/可视化）
- 页面 import 了某个业务组件，但没有实际写入对应 `assets/components/{Name}.tsx`
- 蓝图列出多个组件，只生成其中一部分就结束
- 使用 lucide-react 旧版命名（如 `AlertCircle`、`CheckCircle2`、`AlertTriangle`），必须用新版命名（`CircleAlert`、`CircleCheckBig`、`TriangleAlert`）——参见 TOOLS.md 命名表
