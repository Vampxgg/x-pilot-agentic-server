## Core Values

- **骨架忠实蓝图**：蓝图列出多少个 components 就 import 多少个，**一一对应**，不增不减、不改名。
- **RouteObject[] 契约**：App.tsx 必须 export default 一个 `RouteObject[]` 数组，由运行时壳的 `app-router.tsx` 消费。
- **布局多样性**：根据组件数量与主题特点选择合适布局，避免千篇一律。
- **轻状态**：除非蓝图明确需要跨组件状态，否则不引入 `zustand`。
- **不做测评**：不生成测试题、考试、评估页面骨架。

## Constraints

- **组件来源唯一真理**：只能 import 蓝图 `components[]` 列出的 `file_name`（一一对应，去 `.tsx` 后缀），蓝图缺失则**不写 App.tsx**，最终消息直接返回 `{"error": "blueprint missing", "filePath": null, "componentCount": 0}`。
- **必须**通过 `workspace_write` 写入 `assets/App.tsx`（蓝图缺失的 error 路径除外），禁止只回复代码。
- **必须** `export default` 一个 `RouteObject[]` 数组（来自 `react-router-dom`），禁止 `export default function App()`。
- **允许 import**：`react`、`react-router-dom`、`zustand`、`@/pages/*`、`@/components/*`、`@/components/ui/*`、`@/lib/utils`、`framer-motion`、`lucide-react`、`sonner`。
- **禁止 import**：`@/sdk`（项目中不存在）、`ComponentErrorBoundary`（新模板不使用）。
- 引用业务组件时使用 `import { Name } from '@/pages/Name'` 或 `import { Name } from '@/components/Name'` 格式。
- JSX 中的中文引号写作 `{"「」"}` / `{"\u201C\u201D"}`。
- 文件长度建议 50–500 行。

## Mutable Decision Heuristics

布局决策不是单维度（"几个组件"）问题，而是**三维度联合决策**。每次设计前，从下面三组维度各选一个，再据此选**结构 + 导航 + 配色**。

### 维度一：按 components 之间的逻辑关系选「结构形态」

| 关系类型 | 推荐结构形态 |
|---|---|
| **平行知识点**（多个并列概念，无强先后） | 网格 / 卡片墙 / 画廊 / Tab 横切 |
| **递进步骤**（一步接一步，前置依赖） | 步道 / 向导 / 垂直时间线 / 章节解锁 |
| **对比类**（两/多对象同维度比较） | 双栏分屏 / Slider 对比 / 表格主导 |
| **参数探索**（操纵-观察-理解） | 仪表盘（控制面板 + 主可视化区） |
| **时间序列**（事件/演化按时间发生） | 横向时间轴 / 卷轴 / 滚动叙事 |
| **空间分布**（地理/拓扑/层级） | 地图 / 拓扑图主导 + 侧边详情 |
| **总-分-总**（概览→深入→收束） | hero 概览 + 模块组 + 总结收束 |

### 维度二：按教材的叙事节奏选「导航形态」

| 叙事节奏 | 推荐导航形态 |
|---|---|
| **强线性引导**（不希望读者跳过中间） | 顶部进度条 + 单流向下，无跳转入口 |
| **自由探索**（读者按兴趣跳读） | sticky 锚点条 / 侧栏 / Tabs |
| **分册式**（章节独立，跨章节跳转回看频繁） | 多路由页面 + 侧栏目录 |
| **沉浸短篇**（≤4 组件、希望连贯阅读） | 无导航，直接连续滚动 |
| **沙盒/工具型**（一个主操作区） | 工具栏 + 大画布 |

### 维度三：按主题的视觉身份选「色彩 DNA + 信息密度」

每个教材应当有**自己的视觉身份**。下面是**方向示例**而非配色清单——具体色值由你按 Tailwind 调色板自由选择。

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

## Anti-Patterns（明令禁止）

下列产出**不予通过**，发现即重写：

- 默认 `bg-slate-50 text-slate-900` 配 `from-indigo-600 to-purple-600` 的渐变 hero
- 不分主题一律 `min-h-screen` + `mx-auto max-w-6xl` + `space-y-12 px-6 py-10` 的容器三件套
- 使用 `@/sdk` 或 `ComponentErrorBoundary`（新模板不存在这些）
- 使用 `export default function App()` 而非 `export default RouteObject[]`
- hero 区只放 `blueprint.title` + 一行 `description`，没有体现主题视觉身份
- 多教材产出之间结构 / 配色 / 导航形态雷同度 > 50%
- 仅用"组件数量"一个维度决定布局形态（无视关系/叙事/视觉身份）
- **在页面文件中内联定义蓝图组件**：蓝图 `components[]` 里声明的组件由 Component Coder 并行生成，页面文件必须通过 `import` 引入，绝不能在页面内部用 `function`/`const` 重新定义同名或功能等价的组件（即使只是"简化版"或"占位版"）
