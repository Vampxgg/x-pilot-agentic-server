/**
 * DSL Semantic Validator —— v2 服务端语义校验。
 *
 * schema 校验只保证形态对，**语义校验**还要保证：
 *   1. flow.initial 是已存在的 scene
 *   2. transitions.from / to 都指向已存在 scene（"*" 通配除外）
 *   3. transitions.action 必须是 actions 里定义过的（或场景 on 字段引用过的）
 *   4. scene.on 引用的 action / events 引用的 action 必须在 actions 里
 *   5. action 的 navigate.to 必须是已存在 scene
 *   6. 所有 UINode.type 必须在 component-manifest 里注册
 *   7. 表达式语法合法（简单括号匹配 + 不含禁字符）
 *   8. 至少一条 scene 是 reachable 的（从 flow.initial 出发）—— 警告级，不阻塞
 *
 * 返回结构化错误，dsl-fixer 可以基于这些错误生成 JSON Patch。
 */

import type { Dsl, ActionOp } from "./schema.js";
import { listManifestComponents } from "./component-manifest.js";

export type Severity = "error" | "warning";

export interface SemanticIssue {
  severity: Severity;
  /** 机器可读的错误代码 */
  code: SemanticErrorCode;
  /** 人类可读的描述 */
  message: string;
  /** JSON Pointer 路径（dsl-fixer 用它定位修复点） */
  path: string;
  /** 修复提示（可选） */
  hint?: string;
}

export type SemanticErrorCode =
  | "INVALID_INITIAL_SCENE"
  | "TRANSITION_FROM_UNKNOWN"
  | "TRANSITION_TO_UNKNOWN"
  | "TRANSITION_ACTION_UNKNOWN"
  | "SCENE_ON_ACTION_UNKNOWN"
  | "EVENT_ACTION_UNKNOWN"
  | "NAVIGATE_TO_UNKNOWN"
  | "UNKNOWN_COMPONENT"
  | "EXPRESSION_INVALID"
  | "UNREACHABLE_SCENE"
  | "EMPTY_SCENES"
  | "SHELL_TEMPLATE_PATTERN"
  | "CONTEXT_FIELD_UNUSED"
  | "SHALLOW_UI_TREE";

export interface SemanticValidatorOptions {
  /** 反壳子/浅 UI/context 引用等增强规则；默认开启（传 false 可关闭） */
  semanticRichness?: boolean;
}

export interface SemanticResult {
  valid: boolean;
  errors: SemanticIssue[];
  warnings: SemanticIssue[];
}

const KNOWN_COMPONENTS = new Set<string>(listManifestComponents());

/** 常见「壳子」排版组件：若场景树几乎只有这些，给 warning */
const SHELL_ONLY_TYPES = new Set(["Col", "Row", "InfoCard", "FlowController"]);

export function validateDslSemantics(
  dsl: Dsl,
  options?: SemanticValidatorOptions,
): SemanticResult {
  const richness = options?.semanticRichness !== false;
  const issues: SemanticIssue[] = [];
  const sceneIds = new Set(Object.keys(dsl.scenes));
  const actionIds = new Set(Object.keys(dsl.actions ?? {}));

  if (sceneIds.size === 0) {
    issues.push({
      severity: "error",
      code: "EMPTY_SCENES",
      message: "scenes 字典不能为空",
      path: "/scenes",
    });
  }

  // 1. flow.initial
  if (!sceneIds.has(dsl.flow.initial)) {
    issues.push({
      severity: "error",
      code: "INVALID_INITIAL_SCENE",
      message: `flow.initial "${dsl.flow.initial}" 未在 scenes 中定义`,
      path: "/flow/initial",
      hint: `应从以下 scene 中选一个：${Array.from(sceneIds).join(", ")}`,
    });
  }

  // 2 & 3. transitions
  (dsl.transitions ?? []).forEach((t, i) => {
    if (t.from !== "*" && !sceneIds.has(t.from)) {
      issues.push({
        severity: "error",
        code: "TRANSITION_FROM_UNKNOWN",
        message: `transition[${i}].from "${t.from}" 未定义`,
        path: `/transitions/${i}/from`,
      });
    }
    if (!sceneIds.has(t.to)) {
      issues.push({
        severity: "error",
        code: "TRANSITION_TO_UNKNOWN",
        message: `transition[${i}].to "${t.to}" 未定义`,
        path: `/transitions/${i}/to`,
      });
    }
    if (!actionIds.has(t.action)) {
      issues.push({
        severity: "warning",
        code: "TRANSITION_ACTION_UNKNOWN",
        message: `transition[${i}].action "${t.action}" 未在 actions 中定义（可能是场景级 on 引用）`,
        path: `/transitions/${i}/action`,
      });
    }
    if (t.condition?.expr) {
      const err = checkExpression(t.condition.expr);
      if (err) {
        issues.push({
          severity: "error",
          code: "EXPRESSION_INVALID",
          message: `transition[${i}].condition.expr 语法错: ${err}`,
          path: `/transitions/${i}/condition/expr`,
        });
      }
    }
  });

  // 4. scene.on / events
  for (const [sid, scene] of Object.entries(dsl.scenes)) {
    Object.entries(scene.on ?? {}).forEach(([evt, aid]) => {
      if (!actionIds.has(aid)) {
        issues.push({
          severity: "warning",
          code: "SCENE_ON_ACTION_UNKNOWN",
          message: `scene "${sid}".on.${evt} 引用了未定义 action "${aid}"`,
          path: `/scenes/${sid}/on/${evt}`,
        });
      }
    });
    if (!scene.ui) continue;
    walkUI(scene.ui, `/scenes/${sid}/ui`, (node, nodePath) => {
      if (!KNOWN_COMPONENTS.has(node.type)) {
        issues.push({
          severity: "error",
          code: "UNKNOWN_COMPONENT",
          message: `未注册的组件类型 "${node.type}"`,
          path: `${nodePath}/type`,
          hint: `已知组件可见 component-manifest.json`,
        });
      }
      Object.entries(node.events ?? {}).forEach(([evt, aid]) => {
        if (!actionIds.has(aid)) {
          issues.push({
            severity: "warning",
            code: "EVENT_ACTION_UNKNOWN",
            message: `${nodePath}.events.${evt} 引用了未定义 action "${aid}"`,
            path: `${nodePath}/events/${evt}`,
          });
        }
      });
      if (node.if?.expr) {
        const err = checkExpression(node.if.expr);
        if (err) {
          issues.push({
            severity: "error",
            code: "EXPRESSION_INVALID",
            message: `${nodePath}.if 表达式语法错: ${err}`,
            path: `${nodePath}/if/expr`,
          });
        }
      }
    });
  }

  // 5. actions 内 navigate.to
  for (const [aid, action] of Object.entries(dsl.actions ?? {})) {
    const ops: ActionOp[] = action.type === "compound" ? action.ops : [action as ActionOp];
    ops.forEach((op, opIdx) => {
      const opPath = action.type === "compound" ? `/actions/${aid}/ops/${opIdx}` : `/actions/${aid}`;
      if (op.type === "navigate" && !sceneIds.has(op.to)) {
        issues.push({
          severity: "error",
          code: "NAVIGATE_TO_UNKNOWN",
          message: `action "${aid}" navigate.to "${op.to}" 未定义`,
          path: `${opPath}/to`,
        });
      }
    });
  }

  // 6. 可达性（warning）
  const reachable = new Set<string>();
  const queue: string[] = [dsl.flow.initial];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (reachable.has(cur) || !sceneIds.has(cur)) continue;
    reachable.add(cur);
    // 通过 transitions
    for (const t of dsl.transitions ?? []) {
      if ((t.from === cur || t.from === "*") && sceneIds.has(t.to)) queue.push(t.to);
    }
    // 通过 actions.navigate
    for (const action of Object.values(dsl.actions ?? {})) {
      const ops: ActionOp[] = action.type === "compound" ? action.ops : [action as ActionOp];
      for (const op of ops) {
        if (op.type === "navigate" && sceneIds.has(op.to)) queue.push(op.to);
      }
    }
  }
  for (const sid of sceneIds) {
    if (!reachable.has(sid)) {
      issues.push({
        severity: "warning",
        code: "UNREACHABLE_SCENE",
        message: `scene "${sid}" 不可达（从 flow.initial 出发无法到达）`,
        path: `/scenes/${sid}`,
        hint: `添加一个 transition 或 navigate action 指向它，否则用户永远看不到此 scene`,
      });
    }
  }

  if (richness) {
    collectRichnessWarnings(dsl, issues);
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { valid: errors.length === 0, errors, warnings };
}

function collectRichnessWarnings(dsl: Dsl, issues: SemanticIssue[]): void {
  const allTypes = new Set<string>();
  let nodeCount = 0;
  for (const [sid, scene] of Object.entries(dsl.scenes)) {
    if (!scene.ui) continue;
    walkUI(scene.ui, `/scenes/${sid}/ui`, (node) => {
      if (node.type) {
        allTypes.add(node.type);
        nodeCount++;
      }
    });
  }

  if (nodeCount > 0 && nodeCount < 10) {
    issues.push({
      severity: "warning",
      code: "SHALLOW_UI_TREE",
      message: `全应用 UI 节点过少（${nodeCount}），可能偏「空壳」`,
      path: "/scenes",
      hint: "增加具体教学组件（图表、仿真、测验等）并绑定 context",
    });
  }

  if (allTypes.size > 0 && [...allTypes].every((t) => SHELL_ONLY_TYPES.has(t))) {
    issues.push({
      severity: "warning",
      code: "SHELL_TEMPLATE_PATTERN",
      message: `组件类型仅包含排版壳（${[...allTypes].join(", ")}），缺少专用教学组件`,
      path: "/scenes",
      hint: "为不同教学意图引入 manifest 中的专用组件并配置 $bind/$ctx",
    });
  }

  const initial = dsl.context?.initial;
  if (initial && typeof initial === "object" && !Array.isArray(initial)) {
    const blob = JSON.stringify(dsl.scenes);
    for (const key of Object.keys(initial)) {
      if (key.startsWith("_")) continue;
      const re = new RegExp(`\\$ctx\\.${escapeRegExp(key)}\\b`);
      if (!re.test(blob)) {
        issues.push({
          severity: "warning",
          code: "CONTEXT_FIELD_UNUSED",
          message: `context.initial 字段 "${key}" 在任意 scene.ui 中未见 $ctx.${key} 引用`,
          path: `/context/initial/${key}`,
          hint: "在 props 中使用 $ctx 绑定或从 initial 中移除无用字段",
        });
      }
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────

function walkUI(node: { type?: string; events?: Record<string, string>; if?: { expr: string }; slots?: Record<string, unknown[]>; children?: unknown[] }, path: string, visitor: (n: { type: string; events?: Record<string, string>; if?: { expr: string } }, p: string) => void): void {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node as { type: string; events?: Record<string, string>; if?: { expr: string } }, path);
  if (node.children) {
    (node.children as unknown[]).forEach((child, i) => walkUI(child as Parameters<typeof walkUI>[0], `${path}/children/${i}`, visitor));
  }
  if (node.slots) {
    for (const [slotName, items] of Object.entries(node.slots)) {
      (items as unknown[]).forEach((child, i) => walkUI(child as Parameters<typeof walkUI>[0], `${path}/slots/${slotName}/${i}`, visitor));
    }
  }
}

/**
 * 简单表达式合法性检查：括号配对 + 不含明显禁字符。
 * 不做完整解析，留给浏览器端 ExpressionVM 去精确报错。
 */
function checkExpression(expr: string): string | null {
  const FORBIDDEN = /(\bthis\b|\bwindow\b|\bdocument\b|=>|new\s+\w|prototype|constructor)/;
  if (FORBIDDEN.test(expr)) return "表达式含禁用字符";
  let depth = 0;
  for (const c of expr) {
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth < 0) return "括号不匹配";
    }
  }
  if (depth !== 0) return "括号不匹配";
  return null;
}
