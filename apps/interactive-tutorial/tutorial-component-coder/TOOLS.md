## Preferred Tools

### workspace_write（优先级：高）

唯一的强制工具调用。每次任务**只调用一次**：

```
workspace_write({
  name: "assets/components/{PascalCaseName}.tsx",
  content: "...完整 TSX..."
})
```

`name` 必须以 `assets/components/` 开头，且文件名与组件函数名严格一致。

### workspace_read（优先级：中）

按需补全上下文：

- `workspace_read("artifacts/blueprint.json")` — 读完整蓝图（一般 fan-out 已传入 _item，无需读全量）
- `workspace_read("artifacts/research.json")` — 读研究报告，按需提取本组件相关章节

不要无脑全部读取——尽量在 fan-out 注入的指令中获取信息，需要补充时再读。

## Tool Strategy

1. 默认只调用 `workspace_write` 一次。
2. 仅当 fan-out 指令中数据不足以撑起组件时，再 `workspace_read("artifacts/research.json")`。
3. 工具调用完毕后立即输出 JSON 状态，结束任务。

---

## 可用依赖速查表

新模板不使用 SDK，而是直接使用 shadcn/ui + Tailwind + 第三方库。以下是可用依赖清单：

### UI 基础（shadcn/ui — 从 `@/components/ui/{name}` 导入）

- `Button` — `import { Button } from '@/components/ui/button'`
- `Card, CardHeader, CardTitle, CardContent, CardFooter` — `import { Card, ... } from '@/components/ui/card'`
- `Tabs, TabsList, TabsTrigger, TabsContent` — `import { Tabs, ... } from '@/components/ui/tabs'`
- `Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle` — `import { Dialog, ... } from '@/components/ui/dialog'`
- `Select, SelectTrigger, SelectValue, SelectContent, SelectItem` — `import { Select, ... } from '@/components/ui/select'`
- `Accordion, AccordionItem, AccordionTrigger, AccordionContent`
- `Table, TableHeader, TableBody, TableRow, TableHead, TableCell`
- `Badge`, `Progress`, `Slider`, `Switch`, `Checkbox`, `Input`, `Textarea`
- `Tooltip, TooltipTrigger, TooltipContent, TooltipProvider`
- `Sheet, SheetTrigger, SheetContent` — 侧边抽屉
- `Alert, AlertTitle, AlertDescription`
- `Separator`, `Label`, `ScrollArea`
- 以及其他所有 shadcn/ui 组件...

### 工具函数

- `import { cn } from '@/lib/utils'` — className 合并（clsx + tailwind-merge）

### 可视化

- `Recharts` — `import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, BarChart, Bar, PieChart, Pie, RadarChart, Radar, AreaChart, Area, ScatterChart, Scatter } from 'recharts'`
- `D3` — `import * as d3 from 'd3'`（适用于自定义 SVG 可视化）

### 3D

- `Three.js` — `import * as THREE from 'three'`
- `@react-three/fiber` — `import { Canvas } from '@react-three/fiber'`
- `@react-three/drei` — `import { OrbitControls, Text, ... } from '@react-three/drei'`

### 动画

- `Framer Motion` — `import { motion, AnimatePresence } from 'framer-motion'`
- `@react-spring/web` — `import { useSpring, animated } from '@react-spring/web'`

### 数学公式

- `Katex` — `import katex from 'katex'` 或 `import 'katex/dist/katex.min.css'; import { InlineMath, BlockMath } from 'react-katex'`

### 图标

- `lucide-react` — `import { ArrowRight, ChevronDown, ... } from 'lucide-react'`

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

## Import 规范

文件头部模板（按需裁剪）：

```tsx
import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
// 可选第三方：
// import { LineChart, Line, XAxis, YAxis } from 'recharts';
// import { motion } from 'framer-motion';
// import { ArrowRight, Cpu } from 'lucide-react';
```

**禁止**：

```tsx
import OtherComponent from './OtherComponent';        // ❌ 组件互引
import { Foo } from '../components/Foo';              // ❌ 同上
import { InfoCard } from '@/sdk';                     // ❌ SDK 不存在
```
