## Preferred Tools

### workspace_write（优先级：高）

强制工具调用——每个文件调用一次，多轮完成全部文件：

```
workspace_write({
  name: "assets/App.tsx",
  content: "...完整 TSX..."
})
```

```
workspace_write({
  name: "assets/pages/HomePage.tsx",
  content: "...完整 TSX..."
})
```

```
workspace_write({
  name: "assets/components/RadarChart.tsx",
  content: "...完整 TSX..."
})
```

路径规则：
- `assets/App.tsx` — 路由入口
- `assets/pages/{PageName}.tsx` — 页面编排文件
- `assets/components/{ComponentName}.tsx` — 业务组件

### workspace_read（优先级：中）

按需补全上下文：

- `workspace_read("artifacts/blueprint.json")` — 读完整蓝图（若指令中未给出）
- `workspace_read("artifacts/research.json")` — 读研究报告，按需提取数据

## Tool Strategy

1. Phase 1：读蓝图（可能需要 `workspace_read`）
2. Phase 2-4：逐个 `workspace_write` 写入文件（App.tsx → pages → components）
3. Phase 5：自检
4. Phase 6：输出 JSON 状态，结束任务

**注意**：每次 `workspace_write` 只写一个文件。不要试图在一次调用中塞入多个文件的内容。

---

## App.tsx 契约（不是模板，是底线）

```tsx
import type { RouteObject } from "react-router-dom";
// import 蓝图 components / 页面文件

const appRoutes: RouteObject[] = [
  // 路由配置
];

export default appRoutes;
```

强制规则：
1. 必须 `import type { RouteObject } from "react-router-dom"`
2. 必须 `export default` 一个 `RouteObject[]` 数组
3. 蓝图每个 component 都必须在某个页面/路由中被渲染

## 可用依赖速查表

### UI 基础（shadcn/ui — 从 `@/components/ui/{name}` 导入）

- `Button` — `import { Button } from '@/components/ui/button'`
- `Card, CardHeader, CardTitle, CardContent, CardFooter` — `import { Card, ... } from '@/components/ui/card'`
- `Tabs, TabsList, TabsTrigger, TabsContent` — `import { Tabs, ... } from '@/components/ui/tabs'`
- `Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle`
- `Select, SelectTrigger, SelectValue, SelectContent, SelectItem`
- `Accordion, AccordionItem, AccordionTrigger, AccordionContent`
- `Table, TableHeader, TableBody, TableRow, TableHead, TableCell`
- `Badge`, `Progress`, `Slider`, `Switch`, `Checkbox`, `Input`, `Textarea`
- `Tooltip, TooltipTrigger, TooltipContent, TooltipProvider`
- `Sheet, SheetTrigger, SheetContent`
- `Alert, AlertTitle, AlertDescription`
- `Separator`, `Label`, `ScrollArea`
- 以及其他所有 shadcn/ui 组件...

### 工具函数

- `import { cn } from '@/lib/utils'` — className 合并

### 可视化

- `Recharts` — `import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, BarChart, Bar, PieChart, Pie, RadarChart, Radar, AreaChart, Area, ScatterChart, Scatter, ResponsiveContainer } from 'recharts'`
- `D3` — `import * as d3 from 'd3'`

### 3D

- `Three.js` — `import * as THREE from 'three'`
- `@react-three/fiber` — `import { Canvas, useFrame } from '@react-three/fiber'`
- `@react-three/drei` — `import { OrbitControls, Text, Float, ... } from '@react-three/drei'`

### 动画

- `Framer Motion` — `import { motion, AnimatePresence } from 'framer-motion'`
- `@react-spring/web` — `import { useSpring, animated } from '@react-spring/web'`

### 数学公式

- `react-katex` — `import 'katex/dist/katex.min.css'; import { InlineMath, BlockMath } from 'react-katex'`

### 图标

- `lucide-react` — `import { ArrowRight, ChevronDown, Cpu, ... } from 'lucide-react'`

**lucide-react 命名注意**：本项目使用 lucide v0.400+ 新版命名约定（`{Shape}{Modifier}` 而非旧版 `{Modifier}{Shape}`）。常见易错名：

| ❌ 旧名（勿用） | ✅ 新名（正确） |
|---|---|
| `AlertCircle` | `CircleAlert` |
| `AlertTriangle` | `TriangleAlert` |
| `AlertOctagon` | `OctagonAlert` |
| `CheckCircle` | `CircleCheck` |
| `CheckCircle2` | `CircleCheckBig` |
| `XCircle` | `CircleX` |
| `HelpCircle` | `CircleHelp` |
| `PlusCircle` | `CirclePlus` |
| `MinusCircle` | `CircleMinus` |
| `ArrowUpCircle` | `CircleArrowUp` |
| `ArrowDownCircle` | `CircleArrowDown` |

如果不确定图标名，优先使用核心名（如 `Search`、`Play`、`Cpu`、`Wrench`）——这些没有被重命名。

### 流程图

- `@xyflow/react` — `import { ReactFlow, ... } from '@xyflow/react'`

### 其他

- `react-resizable-panels` — 可调面板
- `react-hook-form` + `@hookform/resolvers` + `zod` — 表单
- `sonner` — toast 通知
- `date-fns` — 日期工具
- `papaparse` — CSV 解析
- `embla-carousel-react` — 轮播
- `leva` — 调试 GUI 面板
- `zustand` — 跨组件状态管理（只在必要时使用）

## Import 规范

**允许**：

```tsx
import ComponentA from '@/components/ComponentA';   // ✅ 业务组件
import { Button } from '@/components/ui/button';    // ✅ shadcn/ui
import { cn } from '@/lib/utils';                   // ✅ 工具
import { motion } from 'framer-motion';             // ✅ 第三方
import PageA from '@/pages/PageA';                  // ✅ 页面
```

**禁止**：

```tsx
import { InfoCard } from '@/sdk';                   // ❌ SDK 不存在
import { ComponentErrorBoundary } from '...';       // ❌ 新模板不使用
```
