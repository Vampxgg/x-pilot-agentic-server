/**
 * patch-applier —— 应用 RFC 6902 JSON Patch 到 dsl.json。
 *
 * v3 编辑路径：dsl-edit-planner 输出 patch[]，
 * server 应用后写回会话目录 + SSE 推送给浏览器 SceneRuntime 热更新。
 *
 * v1.2 阶段实现最小子集：add / replace / remove。
 * 完整 RFC 6902 含 move/copy/test，按需后续补。
 */

export type PatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function decode(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parsePath(path: string): string[] {
  if (!path.startsWith("/")) throw new Error(`patch path must start with '/': ${path}`);
  if (path === "/") return [];
  return path.slice(1).split("/").map(decode);
}

function navigate(target: unknown, parts: string[]): { parent: unknown; key: string } {
  if (parts.length === 0) throw new Error("cannot navigate to root parent");
  let cur: unknown = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    if (FORBIDDEN.has(key)) throw new Error(`forbidden key ${key}`);
    if (cur == null || typeof cur !== "object") {
      throw new Error(`path ${parts.slice(0, i + 1).join("/")} not navigable`);
    }
    cur = Array.isArray(cur) ? cur[Number(key)] : (cur as Record<string, unknown>)[key];
  }
  const lastKey = parts[parts.length - 1] as string;
  if (FORBIDDEN.has(lastKey)) throw new Error(`forbidden key ${lastKey}`);
  return { parent: cur, key: lastKey };
}

export function applyPatch<T>(target: T, patches: PatchOp[]): T {
  const cloned = structuredClone(target);
  for (const p of patches) applyOne(cloned, p);
  return cloned;
}

function applyOne(target: unknown, p: PatchOp): void {
  const parts = parsePath(p.path);
  if (parts.length === 0) {
    throw new Error("patches at root not supported (provide a sub-path)");
  }
  const { parent, key } = navigate(target, parts);
  if (parent == null || typeof parent !== "object") {
    throw new Error(`parent at ${parts.slice(0, -1).join("/")} not navigable`);
  }
  if (Array.isArray(parent)) {
    const idx = key === "-" ? parent.length : Number(key);
    if (Number.isNaN(idx)) throw new Error(`array index NaN: ${key}`);
    switch (p.op) {
      case "add":
        parent.splice(idx, 0, p.value);
        return;
      case "replace":
        if (idx < 0 || idx >= parent.length) throw new Error(`replace out of bounds: ${idx}`);
        parent[idx] = p.value;
        return;
      case "remove":
        parent.splice(idx, 1);
        return;
    }
  } else {
    const obj = parent as Record<string, unknown>;
    switch (p.op) {
      case "add":
      case "replace":
        obj[key] = p.value;
        return;
      case "remove":
        delete obj[key];
        return;
    }
  }
}
