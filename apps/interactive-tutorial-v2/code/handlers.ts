/**
 * v2 Pipeline Handlers —— 注册到 pipeline-executor，由 director 的 yaml.pipeline.steps 引用。
 *
 * 所有 handler 签名：(ctx: PipelineHandlerContext) => Promise<unknown>
 *  - ctx.previousResults Map：取上游 step 输出（可能是 string raw text 或 object）
 *  - 返回值会被 results.set(stepName, result) 存起来供下游 inputMapping/fanOutFrom 用
 *
 * 管线步名与 dsl-director/agent.config.yaml 一致（含 pedagogy / data-pack / visual）。
 * 关键设计：所有 handler 优先读 workspace artifact（agent 通过 workspace_write 写入的稳定 JSON），
 * 而不是依赖 step 的 raw text 输出（容易混入自然语言导致 JSON.parse 失败）。
 * 这与 v1 saveBlueprint 的 3 级 fallback 策略一致。
 */

import type { PipelineHandler, PipelineHandlerContext } from "../../../src/core/types.js";
import { logger } from "../../../src/utils/logger.js";
import { workspaceManager } from "../../../src/core/workspace.js";

import type { Dsl, Scene, Action } from "./dsl/schema.js";
import { parseDsl } from "./dsl/schema.js";
import { validateDslSemantics, type SemanticIssue } from "./dsl/validator.js";
import { mergeDslFragments, type SceneFragment } from "./dsl/merger.js";
import { publishDsl } from "./dsl/publisher.js";
import { applyPatch, type PatchOp } from "./dsl/patch-applier.js";

// ─────────────────────────────────────────────────────────
// 通用 helpers
// ─────────────────────────────────────────────────────────

/** 安全 JSON.parse；输入 null/undefined/非 JSON 字符串时返回 null。 */
function safeParseJson(input: unknown): Record<string, unknown> | null {
  if (input == null) return null;
  if (typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== "string") return null;
  // 直接尝试
  try {
    const v = JSON.parse(input);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }
  // 从混合文本中提取第一个 JSON 对象（贪心匹配最长 {...} 块）
  const m = input.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const v = JSON.parse(m[0]);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* ignore */ }
  }
  return null;
}

/** 优先 workspace artifact，回退 step result 的统一逻辑 */
async function loadJsonArtifact(
  ctx: { tenantId: string; userId: string; sessionId?: string; previousResults: Map<string, unknown> },
  artifactName: string,
  stepName: string,
): Promise<Record<string, unknown> | null> {
  // 1. workspace artifact（最稳）
  if (ctx.sessionId) {
    try {
      const raw = await workspaceManager.readArtifact(ctx.tenantId, ctx.userId, ctx.sessionId, artifactName);
      if (raw) {
        const parsed = safeParseJson(raw);
        if (parsed) {
          logger.info(`[v2 loadJson] hit workspace artifact: ${artifactName}`);
          return parsed;
        }
        logger.warn(`[v2 loadJson] artifact "${artifactName}" exists but unparseable; falling back to step result`);
      }
    } catch {
      /* ignore not-found */
    }
  }
  // 2. step result raw
  const raw = ctx.previousResults.get(stepName);
  const parsed = safeParseJson(raw);
  if (parsed) {
    logger.info(`[v2 loadJson] fell back to step "${stepName}" raw output`);
    return parsed;
  }
  return null;
}

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

/** 控制 fan-out 单项 JSON 体积；优先去掉 context.schema（LLM 仍可读 initial） */
function trimFanOutDslShared(base: Record<string, unknown>, maxLen: number): Record<string, unknown> {
  let cur: Record<string, unknown> = { ...base };
  for (let i = 0; i < 4; i++) {
    if (JSON.stringify(cur).length <= maxLen) return cur;
    const ctx = cur.context;
    if (ctx && typeof ctx === "object" && !Array.isArray(ctx) && "schema" in (ctx as Record<string, unknown>)) {
      const c = ctx as Record<string, unknown>;
      const { schema: _s, ...rest } = c;
      cur = { ...cur, context: rest };
      continue;
    }
    break;
  }
  if (JSON.stringify(cur).length <= maxLen) return cur;
  return {
    version: cur.version,
    app: cur.app,
    flow: cur.flow,
    scenes: cur.scenes,
    actions: cur.actions,
    transitions: cur.transitions,
    _fanOutNote:
      "dslShared 仍超长已极简；请 workspace_read artifacts/dsl-skeleton.json 获取完整 JSON。",
  };
}

const MAX_ARTIFACT_DIGEST = 2_400;

function digestJsonForFanOut(label: string, obj: Record<string, unknown> | null, maxLen: number): string | undefined {
  if (!obj) return undefined;
  let s = JSON.stringify(obj);
  if (s.length > maxLen) {
    s = s.slice(0, maxLen) + `\n…[${label} truncated]`;
  }
  return s;
}

/** 单条 fan-out 项：基座不改时 executor 只把该项 JSON 作为 Original Request，故附带共享上下文 */
export interface SceneFanOutItem {
  id: string;
  title?: string;
  intent?: string;
  /** 供 v2-scene-author 使用的内联上下文（避免仅收到 id/title/intent） */
  fanOutContext: {
    /** 与 skeleton 一致但不含各 scene 的 ui；含全量 app/context/flow/actions/transitions/tick/computed */
    dslShared: Record<string, unknown>;
    /** 全部 scene 的 title+intent，便于导航与一致性 */
    siblingScenes: Record<string, { title?: string; intent?: string }>;
    /** research.json 截断文本；完整版仍可在 workspace_read */
    researchDigest?: string;
    /** 教纲 / 数据包 / 视觉系统 artifact 截断摘要（完整见 workspace） */
    pedagogyDigest?: string;
    dataPackDigest?: string;
    visualDigest?: string;
  };
}

// ─────────────────────────────────────────────────────────
// saveDslSkeleton —— blueprint-architect 的输出落地为 artifacts
// ─────────────────────────────────────────────────────────

export const saveDslSkeleton: PipelineHandler = async (ctx) => {
  const skeleton = (await loadJsonArtifact(
    ctx,
    "artifacts/dsl-skeleton.json",
    "blueprint",
  )) as SkeletonShape | null;

  if (!skeleton || !skeleton.app || !skeleton.context || !skeleton.flow) {
    throw new Error(
      "[saveDslSkeleton] 上游 blueprint 输出不含完整 skeleton（app/context/flow）。" +
      "排查：1) 检查 workspace artifacts/dsl-skeleton.json 是否被 v2-blueprint-architect 写入；" +
      "2) 检查 agent raw output 是否含合法 JSON；" +
      "3) 如果 agent 完全没产出，重新触发或检查模型可用性。",
    );
  }

  // 落到 workspace artifacts/dsl-skeleton.json（如果是从 step result 解析来的，写一份保底）
  if (ctx.sessionId) {
    await workspaceManager.writeArtifact(
      ctx.tenantId,
      ctx.userId,
      ctx.sessionId,
      "artifacts/dsl-skeleton.json",
      JSON.stringify(skeleton, null, 2),
    );
  }

  // ─────────────────────────────────────────────────────────
  // 关键：返回值额外提供 sceneList 数组，供 fan-out 用。
  // pipeline-executor 的 fan-out 要求 fanOutFrom 路径解析为 Array，
  // 但 skeleton.scenes 是 Record<sceneId, Scene>，不能直接 fan-out。
  // 每项带 fanOutContext：基座 executeFanOut 仅把「单条 item」JSON 塞进 Original Request，
  // 不附带上游 save-skeleton / research 的完整输出，故在此内联 dsl 共享块 + research 摘要。
  // ─────────────────────────────────────────────────────────
  const research = await loadJsonArtifact(ctx, "artifacts/research.json", "research");
  const pedagogy = await loadJsonArtifact(ctx, "artifacts/pedagogy-plan.json", "pedagogy");
  const dataPack = await loadJsonArtifact(ctx, "artifacts/data-pack.json", "data-pack");
  const visualSystem = await loadJsonArtifact(ctx, "artifacts/visual-system.json", "visual");

  const siblingScenes: Record<string, { title?: string; intent?: string }> = {};
  for (const [sid, sc] of Object.entries(skeleton.scenes ?? {})) {
    siblingScenes[sid] = {
      title: (sc as { title?: string }).title,
      intent: (sc as { intent?: string }).intent,
    };
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
  const dslSharedForFanOut = trimFanOutDslShared(dslSharedRaw, 18_000);

  let researchDigest: string | undefined;
  if (research) {
    let rs = JSON.stringify(research);
    const MAX_RESEARCH = 4_000;
    if (rs.length > MAX_RESEARCH) {
      rs = rs.slice(0, MAX_RESEARCH) + "\n…[researchDigest truncated]";
      logger.warn(`[v2 saveDslSkeleton] research digest truncated to ${MAX_RESEARCH} chars`);
    }
    researchDigest = rs;
  }

  const pedagogyDigest = digestJsonForFanOut("pedagogy", pedagogy, MAX_ARTIFACT_DIGEST);
  const dataPackDigest = digestJsonForFanOut("data-pack", dataPack, MAX_ARTIFACT_DIGEST);
  const visualDigest = digestJsonForFanOut("visual-system", visualSystem, MAX_ARTIFACT_DIGEST);

  const sceneList: SceneFanOutItem[] = Object.entries(skeleton.scenes ?? {}).map(([id, scene]) => {
    const title = (scene as { title?: string }).title;
    const intent = (scene as { intent?: string }).intent;
    const entry: SceneFanOutItem = {
      id,
      fanOutContext: {
        dslShared: dslSharedForFanOut,
        siblingScenes,
        ...(researchDigest ? { researchDigest } : {}),
        ...(pedagogyDigest ? { pedagogyDigest } : {}),
        ...(dataPackDigest ? { dataPackDigest } : {}),
        ...(visualDigest ? { visualDigest } : {}),
      },
    };
    if (title !== undefined) entry.title = title;
    if (intent !== undefined) entry.intent = intent;
    return entry;
  });

  logger.info(
    `[v2 saveDslSkeleton] ok scenes=${sceneList.length} ` +
    `actions=${Object.keys(skeleton.actions ?? {}).length} ` +
    `transitions=${(skeleton.transitions ?? []).length}`,
  );

  return {
    ...skeleton,
    sceneList,
  };
};

// ─────────────────────────────────────────────────────────
// mergeDslFragments —— 合并 fan-out 的 scene 片段
// ─────────────────────────────────────────────────────────

export const mergeDslFragmentsHandler: PipelineHandler = async (ctx) => {
  // 优先从 save-skeleton 的 result 取（在内存里更快），否则回退 workspace
  let skeleton = ctx.previousResults.get("save-skeleton") as SkeletonShape | undefined;
  if (!skeleton || !skeleton.app) {
    const fallback = await loadJsonArtifact(ctx, "artifacts/dsl-skeleton.json", "save-skeleton");
    if (fallback) skeleton = fallback as SkeletonShape;
  }
  if (!skeleton || !skeleton.app || !skeleton.context || !skeleton.flow) {
    throw new Error("[mergeDslFragments] save-skeleton 缺失或不完整");
  }

  const fragments = pickFragments(ctx.previousResults.get("scenes"));
  if (fragments.length === 0) {
    throw new Error("[mergeDslFragments] scenes fan-out 输出为空");
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
  logger.info(`[v2 mergeDslFragments] merged scenes=${Object.keys(dsl.scenes).length} fragments=${fragments.length}`);
  return dsl;
};

// ─────────────────────────────────────────────────────────
// validateDsl —— schema + 语义校验
// ─────────────────────────────────────────────────────────

export const validateDslHandler: PipelineHandler = async (ctx) => {
  const merged = ctx.previousResults.get("merge") as Dsl | undefined;
  if (!merged) throw new Error("[validateDsl] merge 缺失");

  const schemaResult = parseDsl(merged);
  if (!schemaResult.valid) {
    const result = {
      valid: false,
      schemaErrors: schemaResult.errors,
      semanticErrors: [],
      warnings: [],
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

  const sem = validateDslSemantics(schemaResult.data!, { semanticRichness: true });
  const result = {
    valid: sem.valid,
    schemaErrors: [],
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
  logger.info(
    `[v2 validateDsl] valid=${result.valid} ` +
    `errors=${result.semanticErrors.length} warnings=${result.warnings.length}`,
  );
  return result;
};

// ─────────────────────────────────────────────────────────
// publishDsl —— 写到 data/dsl-tutorials/{sid}/dsl.json
//
// 校验门禁：发现 invalid 时调起 v2-dsl-fixer 子智能体，
// 应用其返回的 patches 后重新校验，仍失败则 throw（不发布坏 dsl）。
// ─────────────────────────────────────────────────────────

const FIX_MAX_ROUNDS = 3;

export const publishDslHandler: PipelineHandler = async (ctx) => {
  let dsl = ctx.previousResults.get("merge") as Dsl | undefined;
  const initialValidation = ctx.previousResults.get("validate") as
    | { valid?: boolean; schemaErrors?: SemanticIssue[]; semanticErrors?: SemanticIssue[]; warnings?: SemanticIssue[] }
    | undefined;

  if (!dsl) throw new Error("[publishDsl] merge 缺失");
  if (!ctx.sessionId) throw new Error("[publishDsl] sessionId required");

  let validation = initialValidation;
  let round = 0;

  while (validation && validation.valid === false && round < FIX_MAX_ROUNDS) {
    round++;
    const errors = [
      ...(validation.schemaErrors ?? []),
      ...(validation.semanticErrors ?? []),
    ];
    logger.warn(
      `[v2 publishDsl] round=${round}/${FIX_MAX_ROUNDS} validation failed (${errors.length} issues), invoking v2-dsl-fixer`,
    );

    const patches = await invokeDslFixer(ctx, dsl, errors);
    if (!patches || patches.length === 0) {
      logger.error(`[v2 publishDsl] dsl-fixer round ${round} returned no patches; abort`);
      break;
    }

    try {
      dsl = applyPatch(dsl, patches);
    } catch (e) {
      logger.error(`[v2 publishDsl] applyPatch failed: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }

    // 重新校验
    const sch = parseDsl(dsl);
    if (!sch.valid) {
      validation = {
        valid: false,
        schemaErrors: sch.errors as unknown as SemanticIssue[],
        semanticErrors: [],
        warnings: [],
      };
      continue;
    }
    const sem = validateDslSemantics(sch.data!, { semanticRichness: true });
    validation = {
      valid: sem.valid,
      schemaErrors: [],
      semanticErrors: sem.errors,
      warnings: sem.warnings,
    };
    dsl = sch.data!;
  }

  if (validation && validation.valid === false) {
    const errors = [
      ...(validation.schemaErrors ?? []),
      ...(validation.semanticErrors ?? []),
    ];
    const lines = errors.slice(0, 8).map((e) => `  - [${e.code}] ${e.path}: ${e.message}`);
    throw new Error(
      `[publishDsl] DSL 校验失败且 dsl-fixer 修补 ${round} 轮后仍未通过，拒绝发布坏 dsl。\n` +
      `首批错误（共 ${errors.length} 条）：\n${lines.join("\n")}\n` +
      `建议：让 director 把这些错误告诉用户，询问是否换个题材重新生成。`,
    );
  }

  // 校验通过（原本就通过 / 修补后通过）→ 发布
  if (round > 0) {
    logger.info(`[v2 publishDsl] dsl-fixer 修补 ${round} 轮后校验通过`);
    if (ctx.sessionId) {
      await workspaceManager.writeArtifact(
        ctx.tenantId,
        ctx.userId,
        ctx.sessionId,
        "artifacts/dsl-merged.json",
        JSON.stringify(dsl, null, 2),
      );
      const finalValidation = {
        valid: true,
        fixRounds: round,
        warnings: validation?.warnings ?? [],
      };
      await workspaceManager.writeArtifact(
        ctx.tenantId,
        ctx.userId,
        ctx.sessionId,
        "artifacts/dsl-validation.json",
        JSON.stringify(finalValidation, null, 2),
      );
    }
  }

  return publishDsl(ctx.sessionId, dsl);
};

// ─────────────────────────────────────────────────────────
// invokeDslFixer —— 在 handler 内调起 dsl-fixer 子智能体
// ─────────────────────────────────────────────────────────

async function invokeDslFixer(
  ctx: PipelineHandlerContext,
  dsl: Dsl,
  errors: SemanticIssue[],
): Promise<PatchOp[] | null> {
  try {
    const { agentRegistry } = await import("../../../src/core/agent-registry.js");
    const { agentRuntime } = await import("../../../src/core/agent-runtime.js");

    if (!agentRegistry.has("v2-dsl-fixer")) {
      logger.error(`[v2 publishDsl] v2-dsl-fixer agent 未注册，无法自动修补`);
      return null;
    }

    const errorList = errors
      .map((e) => `- [${e.code}] ${e.path}: ${e.message}${e.hint ? ` (hint: ${e.hint})` : ""}`)
      .join("\n");

    const instruction =
      `【DSL 校验失败，需要 patch 修补】\n\n` +
      `## 错误清单（共 ${errors.length} 条）\n${errorList}\n\n` +
      `## 当前 DSL\n\`\`\`json\n${JSON.stringify(dsl, null, 2)}\n\`\`\`\n\n` +
      `请输出 RFC 6902 patches 数组，应用后让 dsl 通过校验。\n` +
      `输出格式严格遵循：\n` +
      `\`\`\`json\n{ "patches": [{"op":"replace","path":"/scenes/.../type","value":"InfoCard"}], "summary": "修了 N 处" }\n\`\`\`\n` +
      `最后一条 message 必须是纯 JSON。`;

    const result = await agentRuntime.invokeAgent("v2-dsl-fixer", instruction, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      skipPipeline: true,
    });

    return extractPatches(result);
  } catch (e) {
    logger.error(`[v2 publishDsl] invokeDslFixer error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function extractPatches(invokeResult: unknown): PatchOp[] | null {
  // agent-runtime 返回结构通常含 taskResult.output 或 output
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
  // 解析 JSON
  const parsed = safeParseJson(payload);
  if (!parsed) return null;
  const patches = parsed["patches"];
  if (!Array.isArray(patches)) return null;
  return patches as PatchOp[];
}

// ─────────────────────────────────────────────────────────
// fan-out 片段提取（fragment 可能是字符串或 object）
// ─────────────────────────────────────────────────────────

/** scene-author 在 reflection / 自然语言前缀后仍可能输出可解析 JSON；sub-agent-manager 解析失败时会留下 raw string */
function extractSceneFragmentFromAgentOutput(raw: string): SceneFragment | null {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  // 常见 think 包裹（不同模型前缀略有差异）
  s = s.replace(/^<think>[\s\S]*?<\/think>\s*/i, "");
  s = s.replace(/^<thinking>[\s\S]*?<\/thinking>\s*/i, "");
  s = s.replace(/<redacted[_\s]?thinking[^>]*>[\s\S]*?<\/redacted[_\s]?thinking>\s*/gi, "");

  const tryOne = (chunk: string): SceneFragment | null => {
    const parsed = safeParseJson(chunk);
    if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).id === "string") {
      const frag = parsed as unknown as SceneFragment;
      if (frag.scene && typeof frag.scene === "object" && (frag.scene as { ui?: unknown }).ui != null) {
        return frag;
      }
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

  // 从首个疑似 SceneFragment 根对象起截断再 parse（避免文首长说明破坏 greedy）
  for (const m of ['{"id"', '{\n  "id"', '{\r\n  "id"']) {
    const i = s.indexOf(m);
    if (i >= 0) {
      const hit = tryOne(s.slice(i));
      if (hit) return hit;
    }
  }
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
        if (typeof item === "string") {
          return extractSceneFragmentFromAgentOutput(item);
        }
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          if (typeof o.id === "string" && o.scene && typeof o.scene === "object") {
            return item as unknown as SceneFragment;
          }
          // invoke 包装或单字段兜底
          if (typeof o.output === "string") {
            return extractSceneFragmentFromAgentOutput(o.output);
          }
        }
        return null;
      })
      .filter((x): x is SceneFragment => x !== null && typeof x.id === "string" && Boolean(x.scene));
  }
  if (typeof upstream === "string") {
    const parsed = safeParseJson(upstream);
    if (Array.isArray(parsed)) return pickFragments(parsed);
    const one = extractSceneFragmentFromAgentOutput(upstream);
    if (one) return [one];
    if (parsed && typeof parsed === "object") return [parsed as unknown as SceneFragment];
  }
  return [];
}
