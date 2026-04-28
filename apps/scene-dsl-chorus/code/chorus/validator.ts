/**
 * Chorus DSL 语义校验（独立实现，逻辑与 SceneRuntime 期望一致）。
 */

import type { Dsl, ActionOp } from "./schema.js";
import { listManifestComponents } from "./component-manifest.js";

export type Severity = "error" | "warning";

export interface SemanticIssue {
  severity: Severity;
  code: SemanticErrorCode;
  message: string;
  path: string;
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
  | "EMPTY_SCENES";

export interface SemanticResult {
  valid: boolean;
  errors: SemanticIssue[];
  warnings: SemanticIssue[];
}

const KNOWN_COMPONENTS = new Set<string>(listManifestComponents());

export function validateDslSemantics(dsl: Dsl): SemanticResult {
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

  if (!sceneIds.has(dsl.flow.initial)) {
    issues.push({
      severity: "error",
      code: "INVALID_INITIAL_SCENE",
      message: `flow.initial "${dsl.flow.initial}" 未在 scenes 中定义`,
      path: "/flow/initial",
      hint: `应从以下 scene 中选一个：${Array.from(sceneIds).join(", ")}`,
    });
  }

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
        message: `transition[${i}].action "${t.action}" 未在 actions 中定义`,
        path: `/transitions/${i}/action`,
      });
    }
    if (t.condition?.expr) {
      const err = checkExpression(t.condition.expr);
      if (err) {
        issues.push({
          severity: "error",
          code: "EXPRESSION_INVALID",
          message: `transition[${i}].condition.expr: ${err}`,
          path: `/transitions/${i}/condition/expr`,
        });
      }
    }
  });

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
    walkUI(scene.ui, `/scenes/${sid}/ui`, (node, nodePath) => {
      if (!KNOWN_COMPONENTS.has(node.type)) {
        issues.push({
          severity: "error",
          code: "UNKNOWN_COMPONENT",
          message: `未注册的组件类型 "${node.type}"`,
          path: `${nodePath}/type`,
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
            message: `${nodePath}.if: ${err}`,
            path: `${nodePath}/if/expr`,
          });
        }
      }
    });
  }

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

  const reachable = new Set<string>();
  const queue: string[] = [dsl.flow.initial];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (reachable.has(cur) || !sceneIds.has(cur)) continue;
    reachable.add(cur);
    for (const t of dsl.transitions ?? []) {
      if ((t.from === cur || t.from === "*") && sceneIds.has(t.to)) queue.push(t.to);
    }
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
        message: `scene "${sid}" 不可达`,
        path: `/scenes/${sid}`,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { valid: errors.length === 0, errors, warnings };
}

function walkUI(
  node: {
    type?: string;
    events?: Record<string, string>;
    if?: { expr: string };
    slots?: Record<string, unknown[]>;
    children?: unknown[];
  },
  path: string,
  visitor: (n: { type: string; events?: Record<string, string>; if?: { expr: string } }, p: string) => void,
): void {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node as { type: string; events?: Record<string, string>; if?: { expr: string } }, path);
  if (node.children) {
    (node.children as unknown[]).forEach((child, i) =>
      walkUI(child as Parameters<typeof walkUI>[0], `${path}/children/${i}`, visitor),
    );
  }
  if (node.slots) {
    for (const [slotName, items] of Object.entries(node.slots)) {
      (items as unknown[]).forEach((child, i) =>
        walkUI(child as Parameters<typeof walkUI>[0], `${path}/slots/${slotName}/${i}`, visitor),
      );
    }
  }
}

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
