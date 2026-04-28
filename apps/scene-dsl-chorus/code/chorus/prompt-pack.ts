/**
 * Chorus —— 管线注入用的 schema / 组件说明（不依赖 v2 prompt-injection）。
 */

import { manifestDetailedForPrompt, manifestNamesForPrompt } from "./component-manifest.js";

const DSL_SHAPE = `
## DSL 顶层（必须可 parseDsl 通过）
- version: "1.1"
- app: { id, name, description?, shell?, theme? }
- context: { schema?, initial }
- scenes: Record<sceneId, { title?, intent?, ui, on? }>
- actions: Record<actionId, Action>
- transitions: [{ from, action, to, condition? }]
- flow: { initial: sceneId, completion? }
- tick?, computed?

## UI 节点
- type 必须是组件清单中的注册名
- props 可用占位符: $bind(path), $expr(...), $compute(name)
- events: { onXxx: "ACTION_ID" } 对应 actions 键
`;

/**
 * 给 playwright / director 看的「合法 actions」硬范例（减少 invalid_union）。
 * 禁止发明无 type 的 action 对象；禁止把「步骤说明」当成 action 值。
 */
export function buildChorusActionCookbook(): string {
  return `
## 【必读】actions 与 transitions 的合法形状（复制后改 id 即可）

### 每条 action 必须是以下之一（顶层必有字符串字段 type）

1) 单步 set_context —— 改 context 字段：
\`\`\`json
"ACTION_MARK_DONE": { "type": "set_context", "path": "stepDone", "value": true }
\`\`\`

2) 单步 navigate —— 切换场景：
\`\`\`json
"ACTION_GO_LAB": { "type": "navigate", "to": "scene_lab" }
\`\`\`

3) 单步 emit —— 埋点：
\`\`\`json
"ACTION_LOG_START": { "type": "emit", "event": "lab_started", "payload": { "scene": "intro" } }
\`\`\`

4) 单步 compute_step —— 驱动仿真（若需要）：
\`\`\`json
"ACTION_TICK": { "type": "compute_step", "provider": "pidStepProvider" }
\`\`\`

5) compound —— 多条顺序执行（最常用：先改状态再跳转）：
\`\`\`json
"ACTION_NEXT_SCENE": {
  "type": "compound",
  "ops": [
    { "type": "set_context", "path": "visitedTheory", "value": true },
    { "type": "navigate", "to": "scene_practice" }
  ]
}
\`\`\`

### transitions（可为 []）；若写，则每一项必须同时含 from、action、to

- from: 场景 id，或通配 "*"
- action: 必须是上面 actions 里某个**键名**（字符串），例如 "ACTION_NEXT_SCENE"
- to: 目标场景 id

\`\`\`json
"transitions": [
  { "from": "scene_intro", "action": "ACTION_NEXT_SCENE", "to": "scene_practice" }
]
\`\`\`

### 常见错误（会导致 publish 报 invalid_union）

- 写成 \`"WEAR_GOGGLES": { "label": "戴护目镜" }\` —— **错**：缺少 type，也不是合法 op。
- 把教学步骤当 action —— **错**：请改成 set_context / navigate / compound 组合。
- transitions 里漏写 from —— **错**：每条都要有 from。

若只需「线性下一页」，可令 transitions 为 []，仅在 UI 里用 FlowController 的默认行为；但此时仍须在 actions 里提供 navigate 或 compound（与 FlowController 的 events 对齐）。
`.trim();
}

export function buildChorusPipelineSchemaRef(): string {
  return (
    `## Chorus 管线分阶段输出契约\n` +
    `${DSL_SHAPE}\n\n` +
    `${buildChorusActionCookbook()}\n\n` +
    `## 已注册组件（名称速览）\n${manifestNamesForPrompt()}\n`
  );
}

export function buildChorusWeaverPack(maxChars = 24_000): string {
  const detailed = manifestDetailedForPrompt();
  const head = `## SceneFragment 输出格式\n输出 JSON：{ "id": "<scene_id>", "scene": { "title"?, "intent"?, "ui": <UINode> }, "actionsContrib"?: { ... } }\n\n`;
  let body = detailed;
  if (head.length + body.length > maxChars) {
    body = body.slice(0, maxChars - head.length - 40) + "\n…[manifest truncated]";
  }
  return head + body;
}
