/**
 * Chorus pipeline handlers（独立实现，禁止 import interactive-tutorial-v2）。
 */

import type { PipelineHandler, PipelineHandlerContext } from "../../../../src/core/types.js";
import { logger } from "../../../../src/utils/logger.js";
import { workspaceManager } from "../../../../src/core/workspace.js";

import type { Dsl, Scene, Action } from "./schema.js";
import { parseDsl } from "./schema.js";
import { validateDslSemantics, type SemanticIssue } from "./validator.js";
import { mergeDslFragments, type SceneFragment } from "./merger.js";
import { publishDsl } from "./publisher.js";
import { applyPatch, type PatchOp } from "./patch-applier.js";
import { buildChorusActionCookbook } from "./prompt-pack.js";

function safeParseJson(input: unknown): Record<string, unknown> | null {
  if (input == null) return null;
  if (typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== "string") return null;
  try {
    const v = JSON.parse(input);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const m = input.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const v = JSON.parse(m[0]);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function loadJsonArtifact(
  ctx: { tenantId: string; userId: string; sessionId?: string; previousResults: Map<string, unknown> },
  artifactName: string,
  stepName: string,
): Promise<Record<string, unknown> | null> {
  if (ctx.sessionId) {
    try {
      const raw = await workspaceManager.readArtifact(ctx.tenantId, ctx.userId, ctx.sessionId, artifactName);
      if (raw) {
        const parsed = safeParseJson(raw);
        if (parsed) {
          logger.info(`[chorus loadJson] artifact ${artifactName}`);
          return parsed;
        }
      }
    } catch {
      /* ignore */
    }
  }
  const raw = ctx.previousResults.get(stepName);
  return safeParseJson(raw);
}

function slugify(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\w\u4e00-\u9fff-]+/g, "")
      .slice(0, 48) || "chorus-app"
  );
}

/** 融合 pedagogy / sensory / data 与 host 为单一 bundle（供 playwright 与 save-skeleton 使用） */
export const chorusFuseFacets: PipelineHandler = async (ctx) => {
  const host = (await loadJsonArtifact(ctx, "artifacts/chorus-host.json", "host")) ?? safeParseJson(ctx.previousResults.get("host"));
  const pedagogy = (await loadJsonArtifact(ctx, "artifacts/chorus-pedagogy.json", "pedagogy")) ?? safeParseJson(ctx.previousResults.get("pedagogy"));
  const sensory = (await loadJsonArtifact(ctx, "artifacts/chorus-sensory.json", "sensory")) ?? safeParseJson(ctx.previousResults.get("sensory"));
  const data = (await loadJsonArtifact(ctx, "artifacts/chorus-data.json", "data")) ?? safeParseJson(ctx.previousResults.get("data"));

  if (!host) throw new Error("[chorusFuseFacets] host 输出缺失");

  const bundle = { host, pedagogy: pedagogy ?? {}, sensory: sensory ?? {}, data: data ?? {} };
  if (ctx.sessionId) {
    await workspaceManager.writeArtifact(
      ctx.tenantId,
      ctx.userId,
      ctx.sessionId,
      "artifacts/chorus-fused-brief.json",
      JSON.stringify(bundle, null, 2),
    );
  }
  logger.info("[chorusFuseFacets] fused bundle ok");
  return { bundle };
};

interface SkeletonShape {
  app?: Dsl["app"];
  context?: Dsl["context"];
  flow?: Dsl["flow"];
  scenes?: Record<string, Scene>;
  actions?: Record<string, Action>;
  transitions?: Dsl["transitions"];
  tick?: Dsl["tick"];
  computed?: Dsl["computed"];
  version?: Dsl["version"];
}

export interface ChorusFanOutItem {
  id: string;
  title?: string;
  intent?: string;
  fanOutContext: {
    dslShared: Record<string, unknown>;
    siblingScenes: Record<string, { title?: string; intent?: string }>;
    chorusBriefDigest?: string;
  };
}

function trimFanOutPayload(base: Record<string, unknown>, maxLen: number): Record<string, unknown> {
  let cur: Record<string, unknown> = { ...base };
  for (let i = 0; i < 4; i++) {
    if (JSON.stringify(cur).length <= maxLen) return cur;
    const ctx0 = cur.context;
    if (ctx0 && typeof ctx0 === "object" && !Array.isArray(ctx0) && "schema" in (ctx0 as Record<string, unknown>)) {
      const c = ctx0 as Record<string, unknown>;
      const { schema: _s, ...rest } = c;
      cur = { ...cur, context: rest };
      continue;
    }
    break;
  }
  return JSON.stringify(cur).length <= maxLen ? cur : { version: cur.version, app: cur.app, flow: cur.flow, scenes: cur.scenes, _note: "truncated" };
}

const STUB_UI: Scene["ui"] = {
  type: "Col",
  props: { gap: 4 },
  children: [{ type: "Callout", props: { text: "（Chorus 占位：将由 ui-weaver 替换）", intent: "note" } }],
};

export const chorusSaveSkeleton: PipelineHandler = async (ctx) => {
  const fused = (await loadJsonArtifact(ctx, "artifacts/chorus-fused-brief.json", "fuse")) as { bundle?: Record<string, unknown> } | null;
  const fuseStep = safeParseJson(ctx.previousResults.get("fuse"));
  const bundle = (fused?.bundle ?? (fuseStep as { bundle?: Record<string, unknown> })?.bundle) as Record<string, unknown> | undefined;
  const playwright =
    (await loadJsonArtifact(ctx, "artifacts/chorus-playwright.json", "playwright")) ?? safeParseJson(ctx.previousResults.get("playwright"));

  if (!bundle?.host) {
    throw new Error("[chorusSaveSkeleton] fuse 结果缺失（需要 bundle.host）");
  }

  const host = bundle.host as Record<string, unknown>;
  const sensory = (bundle.sensory ?? {}) as Record<string, unknown>;
  const data = (bundle.data ?? {}) as Record<string, unknown>;
  const pedagogy = (bundle.pedagogy ?? {}) as Record<string, unknown>;

  const appName = (host.appName as string) || (host.learningGoal as string)?.slice(0, 40) || "Chorus 应用";
  const appId = (host.appId as string) || slugify(appName);

  const scenePlan = host.scenePlan as unknown;
  let sceneIds: string[] = [];
  if (Array.isArray(scenePlan)) {
    sceneIds = scenePlan.map((x) => (typeof x === "string" ? x : (x as { id?: string }).id ?? "scene")).filter(Boolean);
  } else if (scenePlan && typeof scenePlan === "object") {
    sceneIds = Object.keys(scenePlan as object);
  }
  if (sceneIds.length === 0) {
    sceneIds = ["scene_main"];
  }

  const pedByScene = (pedagogy.scenes ?? pedagogy) as Record<string, Record<string, unknown>>;
  const scenes: Record<string, Scene> = {};
  for (const sid of sceneIds) {
    const p = (pedByScene && pedByScene[sid]) || {};
    scenes[sid] = {
      title: (p.title as string) || (host[`title_${sid}`] as string) || sid,
      intent: (p.intent as string) || (p.summary as string) || "",
      ui: STUB_UI,
    };
  }

  const shell = sensory.shell as Dsl["app"]["shell"] | undefined;
  const theme: Dsl["app"]["theme"] =
    (sensory.theme as Dsl["app"]["theme"]) ||
    ({ preset: (sensory.themePreset as string) || "edu-light" } as Dsl["app"]["theme"]);

  const pwFlow = playwright?.flow as Dsl["flow"] | undefined;
  const flow: Dsl["flow"] = pwFlow?.initial
    ? pwFlow
    : { initial: sceneIds[0]!, completion: sceneIds[sceneIds.length - 1] };

  const skeleton: SkeletonShape = {
    version: "1.1",
    app: {
      id: appId,
      name: appName,
      description: (host.learningGoal as string) || undefined,
      ...(shell != null ? { shell } : {}),
      theme,
    },
    context: (data.context as Dsl["context"]) || { initial: {} },
    flow,
    scenes,
    actions: (playwright?.actions as Record<string, Action>) || {},
    transitions: (playwright?.transitions as Dsl["transitions"]) || [],
    ...(data.tick ? { tick: data.tick as Dsl["tick"] } : {}),
    ...(data.computed ? { computed: data.computed as Dsl["computed"] } : {}),
  };

  if (ctx.sessionId) {
    await workspaceManager.writeArtifact(
      ctx.tenantId,
      ctx.userId,
      ctx.sessionId,
      "artifacts/dsl-skeleton.json",
      JSON.stringify(skeleton, null, 2),
    );
  }

  const siblingScenes: Record<string, { title?: string; intent?: string }> = {};
  for (const [sid, sc] of Object.entries(scenes)) {
    siblingScenes[sid] = { title: sc.title, intent: sc.intent };
  }

  const dslSharedRaw: Record<string, unknown> = {
    version: skeleton.version ?? "1.1",
    app: skeleton.app,
    context: skeleton.context,
    flow: skeleton.flow,
    actions: skeleton.actions ?? {},
    transitions: skeleton.transitions ?? [],
    ...(skeleton.tick ? { tick: skeleton.tick } : {}),
    ...(skeleton.computed ? { computed: skeleton.computed } : {}),
    scenes: siblingScenes,
  };
  const dslSharedForFanOut = trimFanOutPayload(dslSharedRaw, 18_000);

  let digest = JSON.stringify({ host: host, pedagogy: pedagogy });
  if (digest.length > 4000) digest = digest.slice(0, 4000) + "\n…[truncated]";

  const sceneList: ChorusFanOutItem[] = Object.entries(scenes).map(([id, scene]) => ({
    id,
    title: scene.title,
    intent: scene.intent,
    fanOutContext: {
      dslShared: dslSharedForFanOut,
      siblingScenes,
      chorusBriefDigest: digest,
    },
  }));

  logger.info(`[chorusSaveSkeleton] scenes=${sceneList.length}`);
  return { ...skeleton, sceneList };
};

export const chorusMergeFragments: PipelineHandler = async (ctx) => {
  let skeleton = ctx.previousResults.get("save-skeleton") as SkeletonShape & { sceneList?: ChorusFanOutItem[] };
  if (!skeleton?.app) {
    const fallback = await loadJsonArtifact(ctx, "artifacts/dsl-skeleton.json", "save-skeleton");
    if (fallback) skeleton = fallback as typeof skeleton;
  }
  if (!skeleton?.app || !skeleton.context || !skeleton.flow) {
    throw new Error("[chorusMergeFragments] save-skeleton 缺失或不完整");
  }

  const fragments = pickFragments(ctx.previousResults.get("weave"));
  if (fragments.length === 0) {
    throw new Error("[chorusMergeFragments] weave fan-out 输出为空");
  }

  const dsl = mergeDslFragments(
    skeleton as Partial<Dsl> & { app: Dsl["app"]; context: Dsl["context"]; flow: Dsl["flow"] },
    fragments,
  );

  if (ctx.sessionId) {
    await workspaceManager.writeArtifact(
      ctx.tenantId,
      ctx.userId,
      ctx.sessionId,
      "artifacts/dsl-merged.json",
      JSON.stringify(dsl, null, 2),
    );
  }
  logger.info(`[chorusMergeFragments] merged scenes=${Object.keys(dsl.scenes).length}`);
  return dsl;
};

export const chorusValidateDsl: PipelineHandler = async (ctx) => {
  const merged = ctx.previousResults.get("merge") as Dsl | undefined;
  if (!merged) throw new Error("[chorusValidateDsl] merge 缺失");

  const schemaResult = parseDsl(merged);
  if (!schemaResult.valid) {
    const result = {
      valid: false,
      schemaErrors: schemaResult.errors,
      semanticErrors: [] as SemanticIssue[],
      warnings: [] as SemanticIssue[],
    };
    if (ctx.sessionId) {
      await workspaceManager.writeArtifact(
        ctx.tenantId,
        ctx.userId,
        ctx.sessionId,
        "artifacts/dsl-validation.json",
        JSON.stringify(result, null, 2),
      );
    }
    return result;
  }

  const sem = validateDslSemantics(schemaResult.data!);
  const result = {
    valid: sem.valid,
    schemaErrors: [] as typeof schemaResult.errors,
    semanticErrors: sem.errors,
    warnings: sem.warnings,
  };
  if (ctx.sessionId) {
    await workspaceManager.writeArtifact(
      ctx.tenantId,
      ctx.userId,
      ctx.sessionId,
      "artifacts/dsl-validation.json",
      JSON.stringify(result, null, 2),
    );
  }
  logger.info(`[chorusValidateDsl] valid=${result.valid}`);
  return result;
};

const FIX_MAX_ROUNDS = 3;

/** 把 zod schema 报错翻成用户可操作的短句（避免只显示 Invalid input） */
function hintForZodIssue(e: { path?: string; message?: string; code?: string }): string {
  const path = e.path ?? "";
  const code = e.code ?? "";
  if (code === "invalid_union" && /^actions\./.test(path)) {
    return (
      "→ 该 action 不是合法结构：值必须是对象且含顶层 \"type\"；" +
      "取值只能是 set_context、navigate、emit、api_call、custom_widget、compute_step，或多条包在 compound.ops 里。" +
      "不要把「步骤标题」当成 action 本体。"
    );
  }
  if ((code === "invalid_type" || code === "too_small") && /transitions\.\d+\.from/.test(path)) {
    return "→ 每条 transition 必须包含 from（字符串：场景 id 或 \"*\"）、action、to。";
  }
  return "";
}

function formatChorusPublishFailure(validation: {
  schemaErrors?: { path?: string; message?: string; code?: string }[];
  semanticErrors?: SemanticIssue[];
}): string {
  const lines: string[] = [];
  for (const e of validation.schemaErrors ?? []) {
    const h = hintForZodIssue(e);
    lines.push(`  - [${e.code ?? "schema"}] ${e.path ?? "/"}: ${e.message ?? ""}${h ? `\n    ${h}` : ""}`);
  }
  for (const e of validation.semanticErrors ?? []) {
    lines.push(`  - [${e.code}] ${e.path}: ${e.message}${e.hint ? ` (${e.hint})` : ""}`);
  }
  const tail =
    "\n\n【你可以怎么做】\n" +
    "1) 让导演重新跑一次管线；或 2) 打开 workspace 里的 artifacts/chorus-playwright.json，" +
    "把 actions 改成 Brief 里「actions 与 transitions 的合法形状」中的范例结构（每条必有 type）。";
  return `[chorusPublishDsl] DSL 未通过校验，拒绝发布。\n${lines.join("\n")}${tail}`;
}

export const chorusPublishDsl: PipelineHandler = async (ctx) => {
  let dsl = ctx.previousResults.get("merge") as Dsl | undefined;
  const initialValidation = ctx.previousResults.get("validate") as
    | { valid?: boolean; schemaErrors?: unknown[]; semanticErrors?: SemanticIssue[]; warnings?: SemanticIssue[] }
    | undefined;

  if (!dsl) throw new Error("[chorusPublishDsl] merge 缺失");
  if (!ctx.sessionId) throw new Error("[chorusPublishDsl] sessionId required");

  let validation = initialValidation;
  let round = 0;

  while (validation && validation.valid === false && round < FIX_MAX_ROUNDS) {
    round++;
    const schemaErrs = (validation.schemaErrors ?? []) as { path?: string; message?: string; code?: string }[];
    const semErrs = validation.semanticErrors ?? [];
    const errors: SemanticIssue[] = [
      ...schemaErrs.map(
        (e) =>
          ({
            severity: "error" as const,
            code: "EXPRESSION_INVALID",
            message: e.message ?? "schema error",
            path: e.path ?? "/",
            hint: e.code,
          }) as SemanticIssue,
      ),
      ...semErrs,
    ];
    logger.warn(`[chorusPublishDsl] validation failed round=${round}, invoking chorus-dsl-fixer`);

    const patches = await invokeChorusDslFixer(ctx, dsl, errors);
    if (!patches?.length) break;

    try {
      dsl = applyPatch(dsl, patches);
    } catch (e) {
      logger.error(`[chorusPublishDsl] applyPatch: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }

    const sch = parseDsl(dsl);
    if (!sch.valid) {
      validation = { valid: false, schemaErrors: sch.errors, semanticErrors: [], warnings: [] };
      continue;
    }
    const sem = validateDslSemantics(sch.data!);
    validation = { valid: sem.valid, schemaErrors: [], semanticErrors: sem.errors, warnings: sem.warnings };
    dsl = sch.data!;
  }

  if (validation && validation.valid === false) {
    throw new Error(formatChorusPublishFailure(validation as Parameters<typeof formatChorusPublishFailure>[0]));
  }

  return publishDsl(ctx.sessionId, dsl);
};

async function invokeChorusDslFixer(
  ctx: PipelineHandlerContext,
  dsl: Dsl,
  errors: SemanticIssue[],
): Promise<PatchOp[] | null> {
  try {
    const { agentRegistry } = await import("../../../../src/core/agent-registry.js");
    const { agentRuntime } = await import("../../../../src/core/agent-runtime.js");

    if (!agentRegistry.has("chorus-dsl-fixer")) {
      logger.warn("[chorusPublishDsl] chorus-dsl-fixer 未注册");
      return null;
    }

    const errorList = errors
      .map((e) => `- [${e.code}] ${e.path}: ${e.message}${e.hint ? ` (${e.hint})` : ""}`)
      .join("\n");

    const cookbook = buildChorusActionCookbook().slice(0, 3500);
    const instruction =
      `【DSL 校验失败，输出 RFC 6902 patches】\n${errorList}\n\n` +
      `## 合法 action 备忘\n${cookbook}\n\n` +
      `当前 DSL:\n\`\`\`json\n${JSON.stringify(dsl, null, 2)}\n\`\`\`\n\n` +
      `最后一条 message 必须是 JSON：{"patches":[...],"summary":"..."}`;

    const result = await agentRuntime.invokeAgent("chorus-dsl-fixer", instruction, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      skipPipeline: true,
    });

    return extractPatches(result);
  } catch (e) {
    logger.error(`[chorusPublishDsl] fixer: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function extractPatches(invokeResult: unknown): PatchOp[] | null {
  let payload: unknown = invokeResult;
  if (payload && typeof payload === "object") {
    const r = payload as Record<string, unknown>;
    if (r.taskResult && typeof r.taskResult === "object") {
      const tr = r.taskResult as Record<string, unknown>;
      if (tr.output !== undefined) payload = tr.output;
    } else if (r.output !== undefined) {
      payload = r.output;
    }
  }
  const parsed = safeParseJson(payload);
  if (!parsed) return null;
  const patches = parsed["patches"];
  if (!Array.isArray(patches)) return null;
  return patches as PatchOp[];
}

function extractSceneFragmentFromAgentOutput(raw: string): SceneFragment | null {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  s = s.replace(/^<think>[\s\S]*?<\/think>\s*/i, "");

  const tryOne = (chunk: string): SceneFragment | null => {
    const parsed = safeParseJson(chunk);
    if (parsed && typeof parsed.id === "string") {
      const frag = parsed as unknown as SceneFragment;
      if (frag.scene && typeof frag.scene === "object" && frag.scene.ui != null) return frag;
    }
    return null;
  };

  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(s);
  if (fenced?.[1]) {
    const hit = tryOne(fenced[1].trim());
    if (hit) return hit;
  }
  const direct = tryOne(s);
  if (direct) return direct;

  const idxId = s.search(/\{\s*"id"\s*:/);
  if (idxId >= 0) {
    const hit = tryOne(s.slice(idxId));
    if (hit) return hit;
  }
  return null;
}

function pickFragments(upstream: unknown): SceneFragment[] {
  if (!upstream) return [];
  if (Array.isArray(upstream)) {
    return upstream
      .map((item) => {
        if (typeof item === "string") return extractSceneFragmentFromAgentOutput(item);
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          if (typeof o.id === "string" && o.scene && typeof o.scene === "object") return item as SceneFragment;
          if (typeof o.output === "string") return extractSceneFragmentFromAgentOutput(o.output);
        }
        return null;
      })
      .filter((x): x is SceneFragment => x !== null && typeof x?.id === "string" && Boolean(x.scene));
  }
  if (typeof upstream === "string") {
    const parsed = safeParseJson(upstream);
    if (Array.isArray(parsed)) return pickFragments(parsed);
    const one = extractSceneFragmentFromAgentOutput(upstream);
    if (one) return [one];
  }
  return [];
}
