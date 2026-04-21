/**
 * End-to-end pipeline benchmark for the interactive-tutorial domain.
 *
 * Invokes the director's PipelineExecutor directly in-process (the same code
 * path that the start_generation_pipeline tool uses), so we measure the real
 * pipeline cost without the extra hop through the LLM director.
 *
 * Usage:
 *   tsx scripts/benchmark-tutorial.ts                # both topics
 *   tsx scripts/benchmark-tutorial.ts --only=binary_search
 *   tsx scripts/benchmark-tutorial.ts --tag=new      # writes reports/benchmark-new-<ts>.json
 *   tsx scripts/benchmark-tutorial.ts --tag=old
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentRegistry } from "../src/core/agent-registry.js";
import { agentRuntime } from "../src/core/agent-runtime.js";
import { PipelineExecutor } from "../src/core/pipeline-executor.js";
import { eventBus, type AgentEvent } from "../src/core/event-bus.js";
import { logger } from "../src/utils/logger.js";

interface TopicSpec {
  id: string;
  topic: string;
  brief: string;
}

const TOPICS: TopicSpec[] = [
  {
    id: "binary_search",
    topic: "二分查找算法可视化",
    brief:
      "为大学一年级算法入门课程设计一个互动式教学应用，主题为「二分查找算法」。" +
      "目标受众：刚学完数组、循环、条件语句的本科新生，零算法基础。" +
      "需要包含：1) 算法原理动画，可视化展示左右指针移动；2) 步骤可控的交互（上一步/下一步/重置）；" +
      "3) 复杂度对比小练习（线性查找 vs 二分查找）；4) 一道小测验验证理解。" +
      "风格：简洁现代、配色清新，适合 PC 端浏览器。控件优先使用 @/sdk 内置组件。",
  },
  {
    id: "promise",
    topic: "JavaScript Promise 与异步",
    brief:
      "为 Web 前端培训班设计一个互动教学应用，主题为「JavaScript Promise 与异步编程」。" +
      "目标受众：已有 JS 基础（变量/函数/回调）但还没接触过 Promise 的初学者。" +
      "需要包含：1) Promise 三种状态的可视化卡片；2) 一个互动 Demo：" +
      "用户点击按钮触发 fulfill/reject，看状态机变化；3) 链式调用 .then 的箭头流程图；" +
      "4) 一道写代码小练习（把回调改写成 Promise）。" +
      "风格：浅色主题，重点突出动画和互动，控件优先使用 @/sdk 内置组件。",
  },
];

interface RunResult {
  topicId: string;
  topic: string;
  sessionId: string;
  success: boolean;
  totalMs: number;
  firstPreviewMs: number | null;
  stepDurations: Record<string, number>;
  fanOutCount: number | null;
  fanOutSuccessCount: number | null;
  url: string | null;
  error?: string;
  timeline: Array<{
    ts: string;
    stage?: string;
    phase?: string;
    durationMs?: number;
    count?: number;
    successCount?: number;
    message?: string;
  }>;
}

function parseArgs(): { only?: string; tag: string } {
  const args = process.argv.slice(2);
  const out: { only?: string; tag: string } = { tag: "new" };
  for (const a of args) {
    if (a.startsWith("--only=")) out.only = a.slice("--only=".length);
    else if (a.startsWith("--tag=")) out.tag = a.slice("--tag=".length);
  }
  return out;
}

async function runOne(spec: TopicSpec): Promise<RunResult> {
  const sessionId = `bench-${spec.id}-${Date.now()}`;
  const tenantId = "bench-tenant";
  const userId = "bench-user";

  const directorDef = agentRegistry.get("interactive-tutorial-director");
  if (!directorDef?.config.pipeline) {
    throw new Error("interactive-tutorial-director not found or missing pipeline");
  }

  const executor = new PipelineExecutor(agentRuntime);

  const timeline: RunResult["timeline"] = [];
  let firstPreviewAt: number | null = null;
  let fanOutCount: number | null = null;
  let fanOutSuccessCount: number | null = null;
  let previewUrl: string | null = null;
  const start = Date.now();

  const handler = (event: AgentEvent) => {
    if (event.type !== "progress") return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const entry = {
      ts: event.timestamp,
      stage: typeof data.stage === "string" ? data.stage : undefined,
      phase: typeof data.phase === "string" ? data.phase : undefined,
      message: typeof data.message === "string" ? data.message : undefined,
      durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
      count: typeof data.count === "number" ? data.count : undefined,
      successCount: typeof data.successCount === "number" ? data.successCount : undefined,
    };
    timeline.push(entry);

    if (entry.stage === "preview_ready" && !firstPreviewAt) {
      firstPreviewAt = Date.now() - start;
      const url = (data.url as string | undefined) ?? null;
      previewUrl = url;
      console.log(`  >> preview_ready @ +${firstPreviewAt}ms ${url ?? ""}`);
    }
    if (entry.stage === "fanout_finished" && entry.phase === "components") {
      fanOutCount = entry.count ?? null;
      fanOutSuccessCount = entry.successCount ?? null;
    }
    if (entry.stage === "step_finished" && entry.durationMs) {
      console.log(`  step "${entry.phase}" ${entry.durationMs}ms`);
    }
  };

  eventBus.onSession(sessionId, handler);

  const briefHeader = `【Generation Brief — Benchmark】\n${spec.brief}`;

  let success = false;
  let error: string | undefined;
  let stepDurations: Record<string, number> = {};
  try {
    const result = await executor.execute(directorDef, briefHeader, {
      tenantId,
      userId,
      sessionId,
      context: {
        businessType: "interactive-tutorial",
        generationBrief: spec.brief,
        topic: spec.topic,
      },
    });
    success = result.taskResult.success;
    stepDurations = Object.fromEntries(
      Object.entries(result.steps).map(([k, v]) => [k, v.duration]),
    );
    const assemble = result.steps.assemble?.result as Record<string, unknown> | undefined;
    if (assemble?.url && !previewUrl) previewUrl = assemble.url as string;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    eventBus.offSession(sessionId, handler);
  }

  const totalMs = Date.now() - start;

  return {
    topicId: spec.id,
    topic: spec.topic,
    sessionId,
    success,
    totalMs,
    firstPreviewMs: firstPreviewAt,
    stepDurations,
    fanOutCount,
    fanOutSuccessCount,
    url: previewUrl,
    error,
    timeline,
  };
}

function fmt(ms: number | null | undefined): string {
  if (ms == null) return "    -   ";
  const s = (ms / 1000).toFixed(1);
  return `${s.padStart(6, " ")}s`;
}

function printSummary(tag: string, results: RunResult[]): void {
  console.log("\n========= Benchmark Summary =========");
  console.log(`tag=${tag}  topics=${results.length}`);
  console.log(`${"topic".padEnd(28)}  ${"total".padStart(8)}  ${"1stPrev".padStart(8)}  ${"fanOut".padStart(8)}  result`);
  for (const r of results) {
    const fan = r.fanOutCount != null ? `${r.fanOutSuccessCount}/${r.fanOutCount}` : "-";
    const status = r.success ? "OK" : "FAIL";
    console.log(
      `${r.topic.padEnd(28).slice(0, 28)}  ${fmt(r.totalMs).padStart(8)}  ${fmt(r.firstPreviewMs).padStart(8)}  ${fan.padStart(8)}  ${status}${r.error ? " (" + r.error.slice(0, 60) + ")" : ""}`,
    );
  }
  console.log("=====================================\n");
}

async function main() {
  const { only, tag } = parseArgs();
  const targets = only ? TOPICS.filter((t) => t.id === only) : TOPICS;
  if (targets.length === 0) {
    console.error(`No matching topic for --only=${only}`);
    process.exit(2);
  }

  console.log(`[bench] Initializing agent registry... (tag=${tag})`);
  await agentRegistry.initialize();
  const all = agentRegistry.list();
  console.log(`[bench] ${all.length} agents loaded.`);

  const results: RunResult[] = [];
  for (const spec of targets) {
    console.log(`\n[bench] === Topic: ${spec.id} (${spec.topic}) ===`);
    const t0 = Date.now();
    const r = await runOne(spec);
    console.log(
      `[bench] Done topic=${spec.id} success=${r.success} totalMs=${r.totalMs} firstPreviewMs=${r.firstPreviewMs} url=${r.url ?? "n/a"} elapsed=${Date.now() - t0}ms`,
    );
    results.push(r);
  }

  printSummary(tag, results);

  const reportsDir = resolve(process.cwd(), "reports");
  mkdirSync(reportsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = resolve(reportsDir, `benchmark-${tag}-${ts}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        tag,
        startedAt: new Date(Date.now() - results.reduce((a, r) => a + r.totalMs, 0)).toISOString(),
        finishedAt: new Date().toISOString(),
        results,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`[bench] Report written: ${outPath}`);

  process.exit(results.every((r) => r.success) ? 0 : 1);
}

main().catch((err) => {
  logger.error(`[bench] Fatal: ${err}`);
  console.error(err);
  process.exit(1);
});
