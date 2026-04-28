/**
 * Chorus 组件清单 —— 与 react-code-rander RuntimeKit 手动对齐（独立副本，禁止 import v2）。
 *
 * 用途：语义校验、chorus-ui-weaver / fixer 的 prompt 注入。
 *
 * 数据结构刻意保持轻量（不是 zod / 不是 React 类型），
 * 因为它会被 JSON 序列化注入到 LLM prompt 上下文。
 */

export interface ComponentSpec {
  name: string;
  category:
    | "container"      // 布局
    | "display"        // 信息展示
    | "interaction"    // 用户交互
    | "guide"          // 引导/进度
    | "media"          // 图/视频/3D
    | "app-shell";     // 壳
  description: string;
  /** 设计意图 / 何时该用 */
  intent?: string;
  /** 该组件最常用的 props 列表（自然语言描述，不是 zod） */
  props?: Record<string, string>;
  /** 该组件触发的事件列表，event 名 -> 触发时机 */
  events?: Record<string, string>;
  /** 简洁示范片段（供 LLM 模仿） */
  example?: Record<string, unknown>;
}

export const COMPONENT_MANIFEST: ComponentSpec[] = [
  // ─── 容器（v1 内置） ───
  { name: "Section", category: "container", description: "标题 + 描述 + 子节点垂直排列",
    props: { title: "字符串", description: "字符串", spacing: "compact|cozy|comfortable" } },
  { name: "Container", category: "container", description: "居中带最大宽度",
    props: { size: "sm|md|lg|xl|full" } },
  { name: "Row", category: "container", description: "水平排列子节点",
    props: { gap: "0~8 数字", align: "start|center|end|stretch", justify: "start|center|end|between|around", wrap: "boolean" } },
  { name: "Col", category: "container", description: "垂直排列子节点",
    props: { gap: "0~8 数字" } },
  { name: "Group", category: "container", description: "紧凑分组卡（带小标题）",
    props: { title: "字符串" } },
  { name: "Tabs", category: "container", description: "标签页切换",
    props: { items: "[{key,label,content}] 或 slots", defaultActive: "string" } },

  // ─── 自由布局 (layout) ───
  { name: "Canvas", category: "container",
    description: "自由画布，绝对定位；children 由 items 数组按索引指定 x/y/w/h/z",
    intent: "仪表盘 / 实验台 / 自定义工作区，不按文档流排列",
    props: { items: "[{x,y,w,h,z}] 与 children 同索引匹配", height: "数字 px", background: "subtle|grid|dot|plain|none" } },
  { name: "SplitPane", category: "container", description: "可拖动分隔的双面板分屏",
    intent: "左工作区+右讲解 / 顶视图+底数据",
    props: { direction: "horizontal|vertical", initial: "0~1", min: "0~1", max: "0~1", height: "字符串如 600px / 100vh", resizable: "boolean" } },
  { name: "Floating", category: "container", description: "PiP 浮动卡（可拖动/最小化/关闭）",
    intent: "常驻参考资料 / 公式参考 / 视频画中画",
    props: { title: "字符串", anchor: "top-left|top-right|bottom-left|bottom-right", initialX: "数字", initialY: "数字", width: "数字", minimizable: "boolean", closable: "boolean" } },
  { name: "Layer", category: "container", description: "叠层容器，children 共占同一空间",
    intent: "3D 上叠 HUD / 地图上叠图层",
    props: { height: "数字" } },
  { name: "Spacer", category: "container", description: "占位空间", props: { size: "数字 px", axis: "horizontal|vertical" } },
  { name: "Divider", category: "container", description: "分隔线（带可选标签）", props: { axis: "horizontal|vertical", label: "字符串" } },

  // ─── 业务展示/反馈 ───
  { name: "InfoCard", category: "display",
    description: "信息卡：标题 + 内容 + 图标 + 语义色",
    intent: "阐述概念、提示要点；当不希望喧宾夺主时优先用 Callout",
    props: { title: "string 必填", content: "字符串/节点", intent: "neutral|tip|success|warning|danger", showAccent: "boolean" } },
  { name: "Callout", category: "display",
    description: "轻量提示条（行内引文风）",
    intent: "比 InfoCard 更轻；行内提示、引言、温馨提示",
    props: { text: "string|节点 必填", intent: "note|tip|warning", align: "left|center" } },
  { name: "SafetyAlert", category: "guide",
    description: "三色分级安全警示（info|caution|warning|danger）",
    intent: "汽车操作前安全提示；高压/油液/电池/明火",
    props: { level: "必填 info|caution|warning|danger", title: "必填", content: "节点", prefix: "默认安全提示", pulse: "boolean" } },
  { name: "StepGuide", category: "guide",
    description: "步骤进度，垂直时间轴风格",
    props: { steps: "[{title,description?}] 必填", current: "数字 0-based 必填", density: "cozy|compact", title: "节点" } },

  // ─── 业务交互 ───
  { name: "Selection", category: "interaction",
    description: "选项选择卡（单/多选）；用户在分支决策点的输入",
    intent: "用户做选择影响后续流程；比 Quiz 更轻不判分",
    props: { title: "string", description: "string", options: "[{label,value,description?}] 必填", multi: "boolean", value: "string" },
    events: { onSelect: "payload: { value: string|string[] }" } },
  { name: "Quiz", category: "interaction",
    description: "知识检测题，带答案判定+错误反馈+可重试",
    intent: "知识点检测；反馈语气友好不惩罚",
    props: { question: "必填", options: "[{label,value}] 必填", answer: "string|string[] 必填", multi: "boolean", explanation: "string" },
    events: { onAnswer: "payload: { value, correct: boolean }" } },
  { name: "ToggleReveal", category: "interaction", description: "折叠/展开揭示",
    props: { title: "必填", content: "节点", defaultOpen: "boolean", hint: "string" } },
  { name: "NumberInput", category: "interaction", description: "数字输入+步进按钮+单位",
    intent: "扭矩/间隙/油液/标定参数等数值输入",
    props: { value: "$bind(path) 必填", min: "数字", max: "数字", step: "数字", unit: "字符串", label: "字符串", intent: "neutral|accent|warn|danger", hint: "字符串" } },
  { name: "Dial", category: "interaction", description: "旋钮控件（仿汽车空调/仪表标定）",
    props: { value: "$bind(path) 必填", min: "数字", max: "数字", step: "数字", size: "数字", label: "string", unit: "string", format: "如 0.00", accentHsl: "字符串" } },

  // ─── 仿真原语 (sim) ───
  { name: "Slider", category: "interaction",
    description: "数值滑块；通过 $bind(path) 双向绑定 context",
    intent: "仿真应用的连续输入入口；任何参数化的『调』操作都用它",
    props: { value: "$bind(path) 必填", min: "数字", max: "数字", step: "数字", label: "string", format: "如 0.00", unit: "string", accentHsl: "如 231 75% 58%", hint: "string" } },
  { name: "LiveChart", category: "media",
    description: "实时滚动折线图（多 series + 滚动窗口）",
    intent: "仿真数据可视化的核心；结合 $compute 提供数据，tick 驱动更新",
    props: { series: "[{name,data,field,color?,dashed?,width?}] 必填", xField: "默认 t", windowSec: "数字", yMin: "数字", yMax: "数字", title: "string", height: "数字", yUnit: "string" } },
  { name: "PlayController", category: "interaction",
    description: "仿真运行控制器：运行/暂停（双向绑定 running）+ 重置 + 注入扰动",
    props: { running: "$bind(path) 必填", elapsed: "string", totalSec: "数字" },
    events: { onReset: "重置", onDisturbance: "注入扰动" } },
  { name: "MetricBoard", category: "display", description: "实时指标面板",
    props: { metrics: "数组 必填 [{label,value,unit?,intent?,hint?}]", title: "string", columns: "2|3|4" } },
  { name: "Hint", category: "guide", description: "实时反馈卡：根据 advice 显示分级提示",
    intent: "让用户感受到『AI 在看我的操作』",
    props: { advice: "{ level, message } 通常 $compute(...)", title: "默认 实时反馈" } },
  { name: "Schematic", category: "media", description: "极简电路示意图（v1.1 内置 simple-loop 拓扑）",
    intent: "电路实验类应用的可视化锚点",
    props: { layout: "默认 simple-loop", voltage: "数字", resistance: "数字", current: "数字", brightness: "0~1", title: "string", height: "数字" } },

  // ─── 多模态 (content) ───
  { name: "Markdown", category: "display", description: "轻量 Markdown 渲染（段落/标题/列表/链接/加粗/斜体/行内代码）",
    intent: "富文本叙述；操作说明、知识点讲解、章节简介",
    props: { text: "字符串 必填", size: "sm|md|lg" } },
  { name: "Image", category: "media", description: "教学图片：lazy load + 占位 + 图注 + aspect ratio",
    props: { src: "url 必填", alt: "string", caption: "string", aspect: "如 16/9", fit: "cover|contain", radius: "none|sm|md|lg" } },
  { name: "Hotspot", category: "interaction", description: "图片热点标注：点击圆点弹出说明",
    intent: "发动机分解图/电气接线图/仪表盘按钮认识等找位置教学",
    props: { src: "url 必填", alt: "string", hotspots: "[{id,x(0~100),y(0~100),label,description?}] 必填" },
    events: { onAllRevealed: "全部点击完触发" } },
  { name: "Video", category: "media", description: "HTML5 视频播放器（含章节标记）",
    props: { src: "url 必填", poster: "url", caption: "string", chapters: "[{t秒,label}]", autoPlay: "boolean", loop: "boolean", muted: "boolean" } },

  // ─── 汽车专业域 (auto) ───
  { name: "ProcedureChecklist", category: "interaction",
    description: "操作步骤清单：按顺序完成 + 安全提示 + 工具/参数标注",
    intent: "汽车维修拆装核心交互；让用户体验『按步骤动手』",
    props: { steps: "[{title,detail?,caution?,tool?,param?}] 必填", current: "$bind(path) 必填", title: "string", strict: "boolean" },
    events: { onComplete: "全部完成时触发" } },
  { name: "DiagPanel", category: "interaction", description: "OBD-II 故障码查询面板",
    intent: "故障诊断教学；输入码看释义/原因/检修建议",
    props: { codes: "[{code,name,description?,causes?,remedies?,severity?}] 必填", defaultCode: "string", title: "string" } },
  { name: "ModelViewer3D", category: "media",
    description: "3D 模型查看器（基于 Three.js）；内置发动机程序化模型",
    intent: "汽车机械结构 3D 教学；可旋转/缩放/点击部件",
    props: { layout: "默认 engine", selectedPart: "$ctx.x", disassemblyStage: "0~4 数字", highlightMode: "glow|wireframe|isolated", showLabels: "boolean", height: "数字", autoRotateSpeed: "数字" },
    events: { onSelect: "payload: { partId: string }" } },
  { name: "PartTree", category: "interaction",
    description: "部件层级树；与 ModelViewer3D 通过同 context 字段双向联动",
    intent: "层级浏览部件；典型用法 selected 字段 $bind 同 ModelViewer3D.selectedPart",
    props: { nodes: "[{id,label,meta?,children?}] 必填", selected: "$bind(path) 必填", title: "string" } },

  // ─── 老 SDK 桥接 (bridge) ───
  { name: "CodeBlock", category: "display", description: "代码块：语法高亮、可复制、可多文件 tab",
    props: { code: "必填", language: "如 typescript js python", title: "string", files: "[{name,code,language}] 多文件模式", showLineNumbers: "boolean", highlightLines: "[行号]" } },
  { name: "Formula", category: "display", description: "LaTeX 数学/化学公式（KaTeX）",
    props: { formula: "LaTeX 字符串 必填", label: "string", description: "string", inline: "boolean" } },
  { name: "DataTable", category: "display", description: "数据表（可排序/行高亮/条纹）",
    props: { title: "string", columns: "[{key,label,align?}] 必填", rows: "Record<string,string|number> 必填", sortable: "boolean", striped: "boolean", highlightRow: "数字" } },
  { name: "Timeline", category: "display", description: "事件时间轴",
    props: { title: "string", events: "[{date?,title,description?}] 必填" } },
  { name: "MatchingPairs", category: "interaction", description: "配对题：左右两列连线",
    props: { question: "string", pairs: "[{left,right}] 必填" },
    events: { onComplete: "payload: { allCorrect: boolean }" } },
  { name: "DragSort", category: "interaction", description: "拖拽排序题",
    props: { question: "string", items: "[{id,text}] 必填", correctOrder: "[id...] 必填" },
    events: { onComplete: "payload: { isCorrect: boolean }" } },
  { name: "CircuitDiagram", category: "media", description: "电气原理图（可 svg 字符串或 components 数组）",
    props: { svg: "完整 SVG 字符串", components: "[{id,type,x,y,label?,value?}]", connections: "[{from,to}]" } },

  // ─── 导航 (nav) ───
  { name: "FlowController", category: "guide",
    description: "标准上一步/下一步导航控制器",
    intent: "线性教学流程的标配；放在每个 scene 的底部",
    props: { prev: "scene id（不写则按字典顺序）", next: "scene id", prevLabel: "默认 上一节", nextLabel: "默认 下一节", nextEnabled: "表达式 false 时禁用 next", nextHint: "禁用时提示", hidePrev: "boolean", hideNext: "boolean", align: "left|right|between" },
    events: { onNext: "覆盖默认行为", onPrev: "覆盖默认行为" } },
  { name: "SceneNav", category: "guide",
    description: "场景导航器，三种布局",
    intent: "智能体根据 topic 长度选择：< 5 scene 用 list；> 5 用 breadcrumb 或 dropdown；闯关式用 lockedWhen",
    props: { layout: "list|dropdown|breadcrumb 默认 list", items: "[{scene,label?,icon?,lockedWhen?,lockHint?,done?}]", orientation: "horizontal|vertical（list）", title: "string" } },
];

export function listManifestComponents(): string[] {
  return COMPONENT_MANIFEST.map((c) => c.name);
}

export function getComponentSpec(name: string): ComponentSpec | undefined {
  return COMPONENT_MANIFEST.find((c) => c.name === name);
}

/** 给 LLM prompt 注入用：返回所有组件的简洁清单。 */
export function manifestForPrompt(): string {
  return COMPONENT_MANIFEST.map((c) => {
    const props = c.props ? Object.entries(c.props).map(([k, v]) => `${k}:${v}`).join(", ") : "";
    const events = c.events ? Object.keys(c.events).join("/") : "";
    const tail = events ? ` | events: ${events}` : "";
    const intent = c.intent ? `\n    意图: ${c.intent}` : "";
    return `- **${c.name}** (${c.category}) — ${c.description}${intent}\n    props: { ${props} }${tail}`;
  }).join("\n");
}

/**
 * 详细 manifest —— 给 scene-author 用，每个组件展开成完整一段。
 * 比 manifestForPrompt() 更详细，但占 token 更多（~5KB）。
 */
export function manifestDetailedForPrompt(): string {
  const byCategory = new Map<string, ComponentSpec[]>();
  for (const c of COMPONENT_MANIFEST) {
    const arr = byCategory.get(c.category) ?? [];
    arr.push(c);
    byCategory.set(c.category, arr);
  }
  const sections: string[] = [];
  const categoryOrder: ComponentSpec["category"][] = [
    "container", "display", "interaction", "guide", "media", "app-shell",
  ];
  for (const cat of categoryOrder) {
    const items = byCategory.get(cat);
    if (!items || items.length === 0) continue;
    sections.push(`### ${cat.toUpperCase()} 类组件`);
    for (const c of items) {
      const lines: string[] = [];
      lines.push(`#### \`${c.name}\``);
      lines.push(`- **职责**：${c.description}`);
      if (c.intent) lines.push(`- **设计意图**：${c.intent}`);
      if (c.props && Object.keys(c.props).length > 0) {
        lines.push(`- **Props**（**仅这些字段名合法**）：`);
        for (const [k, v] of Object.entries(c.props)) {
          lines.push(`  - \`${k}\`: ${v}`);
        }
      }
      if (c.events && Object.keys(c.events).length > 0) {
        lines.push(`- **Events**：`);
        for (const [k, v] of Object.entries(c.events)) {
          lines.push(`  - \`${k}\`: ${v}`);
        }
      }
      sections.push(lines.join("\n"));
    }
  }
  return sections.join("\n\n");
}

/** 仅组件名清单（最省 token） */
export function manifestNamesForPrompt(): string {
  return COMPONENT_MANIFEST.map((c) => c.name).join(", ");
}
