/**
 * Comprehensive test script for the Tavily-backed web_search tool.
 *
 * Run:
 *   npx tsx scripts/test-tavily-search.ts
 *   npx tsx scripts/test-tavily-search.ts --only=text,image
 *   npx tsx scripts/test-tavily-search.ts --verbose
 *
 * Requires: TAVILY_API_KEY in .env (or fallback baked into web-search.ts).
 */

import "dotenv/config";
import { webSearchTool } from "../src/tools/built-in/web-search.js";

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

type Case = {
  name: string;
  group: string;
  run: () => Promise<void>;
};

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const onlyArg = argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg
  ? onlyArg
      .replace("--only=", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  : null;

const results: Array<{ name: string; ok: boolean; ms: number; err?: string }> = [];

function pad(s: string, n: number) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function color(s: string, code: number) {
  return `\x1b[${code}m${s}\x1b[0m`;
}

const ok = (s: string) => color(s, 32);
const fail = (s: string) => color(s, 31);
const dim = (s: string) => color(s, 90);
const bold = (s: string) => color(s, 1);

function header(title: string) {
  console.log("\n" + bold("━".repeat(70)));
  console.log(bold(`  ${title}`));
  console.log(bold("━".repeat(70)));
}

function dump(label: string, value: unknown) {
  if (!VERBOSE) return;
  console.log(dim(`  [debug] ${label}: ${JSON.stringify(value, null, 2)}`));
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function runCase(c: Case) {
  if (ONLY && !ONLY.includes(c.group.toLowerCase())) return;
  process.stdout.write(`  ${pad(c.name, 55)} `);
  const t0 = Date.now();
  try {
    await c.run();
    const ms = Date.now() - t0;
    console.log(ok(`PASS`) + dim(` (${ms}ms)`));
    results.push({ name: c.name, ok: true, ms });
  } catch (e) {
    const ms = Date.now() - t0;
    const err = e instanceof Error ? e.message : String(e);
    console.log(fail(`FAIL`) + dim(` (${ms}ms)`) + "\n      " + fail(err));
    results.push({ name: c.name, ok: false, ms, err });
  }
}

async function invoke(input: Record<string, unknown>) {
  const raw = (await webSearchTool.invoke(input as never)) as string;
  const data = JSON.parse(raw);
  dump("input", input);
  dump("output", data);
  return data;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

const cases: Case[] = [
  // ============== TEXT SEARCH ==============
  {
    group: "text",
    name: "[text] basic English query returns organic_results",
    run: async () => {
      const r = await invoke({ query: "What is TypeScript?", num: 3 });
      assert(!r.error, `tool returned error: ${r.error}`);
      assert(Array.isArray(r.organic_results), "organic_results not array");
      assert(r.organic_results.length > 0, "no results returned");
      const first = r.organic_results[0];
      assert(typeof first.title === "string" && first.title, "missing title");
      assert(typeof first.link === "string" && first.link.startsWith("http"), "missing link");
      assert(typeof first.snippet === "string", "missing snippet");
      assert(typeof first.domain === "string" && first.domain, "missing domain");
      console.log(dim(`        first → ${first.domain} | ${first.title.slice(0, 50)}`));
    },
  },
  {
    group: "text",
    name: "[text] basic Chinese query works",
    run: async () => {
      const r = await invoke({ query: "Vue3 组合式 API 教程", num: 3 });
      assert(!r.error, `tool returned error: ${r.error}`);
      assert(r.organic_results.length > 0, "no results returned");
      console.log(dim(`        got ${r.organic_results.length} CN results`));
    },
  },
  {
    group: "text",
    name: "[text] include_answer → ai_overview populated",
    run: async () => {
      const r = await invoke({ query: "Who founded OpenAI?", num: 3 });
      assert(!r.error, `tool returned error: ${r.error}`);
      assert(typeof r.ai_overview === "string" && r.ai_overview.length > 10, "ai_overview missing");
      console.log(dim(`        answer → ${r.ai_overview.slice(0, 80)}...`));
    },
  },
  {
    group: "text",
    name: "[text] num clamps to [1,20]",
    run: async () => {
      const r = await invoke({ query: "react hooks", num: 2 });
      assert(!r.error, `tool returned error: ${r.error}`);
      assert(r.organic_results.length <= 2, `expected ≤2 results, got ${r.organic_results.length}`);
    },
  },

  // ============== EXTRACT CONTENT ==============
  {
    group: "extract",
    name: "[extract] extract_content=true populates content & extracted_content",
    run: async () => {
      // Use num:1 to avoid the 50KB JSON truncation safeguard in the tool.
      const r = await invoke({
        query: "Node.js official site",
        num: 1,
        extract_content: true,
      });
      assert(!r.error, `tool returned error: ${r.error}`);
      const withRaw = r.organic_results.filter(
        (x: { extracted_content?: string }) => typeof x.extracted_content === "string" && x.extracted_content.length > 0,
      );
      assert(withRaw.length > 0, "no result contains extracted_content");
      const first = withRaw[0];
      assert(first.content === first.extracted_content, "content and extracted_content should match");
      console.log(
        dim(`        ${withRaw.length}/${r.organic_results.length} results extracted, first len=${first.content.length}`),
      );
    },
  },
  {
    group: "extract",
    name: "[extract] extract_content=false leaves content empty",
    run: async () => {
      const r = await invoke({ query: "MDN web docs fetch", num: 2 });
      assert(!r.error, `tool returned error: ${r.error}`);
      for (const x of r.organic_results) {
        assert(x.content === "", `expected empty content, got len=${x.content?.length}`);
      }
    },
  },

  // ============== IMAGE SEARCH ==============
  {
    group: "image",
    name: "[image] basic image search returns thumbnails",
    run: async () => {
      const r = await invoke({ query: "red panda", search_type: "image", num: 4 });
      assert(!r.error, `tool returned error: ${r.error}`);
      assert(r.organic_results.length > 0, "no images returned");
      const first = r.organic_results[0];
      assert(first.link?.startsWith("http"), "image link not http");
      assert(first.thumbnail === first.link, "thumbnail should equal link for Tavily images");
      assert(Array.isArray(first.images) && first.images.length === 1, "images[] not populated");
      console.log(dim(`        ${r.organic_results.length} images, first → ${first.domain}`));
    },
  },
  {
    group: "image",
    name: "[image] description used as title/snippet",
    run: async () => {
      const r = await invoke({ query: "golden retriever puppy", search_type: "image", num: 3 });
      assert(!r.error, `tool returned error: ${r.error}`);
      const withDesc = r.organic_results.filter(
        (x: { snippet?: string }) => typeof x.snippet === "string" && x.snippet.length > 0,
      );
      assert(withDesc.length > 0, "no image carries a description");
    },
  },
  {
    group: "image",
    name: "[image] deprecated filters are silently accepted",
    run: async () => {
      const r = await invoke({
        query: "mountain landscape",
        search_type: "image",
        num: 2,
        image_size: "large",
        image_color: "blue",
        image_type: "photo",
        aspect_ratio: "wide",
      });
      assert(!r.error, `tool returned error: ${r.error}`);
      assert(r.organic_results.length > 0, "no images returned");
    },
  },

  // ============== ADVANCED PARAMETERS ==============
  {
    group: "advanced",
    name: "[advanced] search_depth=advanced returns results",
    run: async () => {
      const r = await invoke({
        query: "CRISPR gene editing latest research",
        num: 3,
        search_depth: "advanced",
      });
      assert(!r.error, `tool returned error: ${r.error}`);
      assert(r.organic_results.length > 0, "no results returned");
    },
  },
  {
    group: "advanced",
    name: "[advanced] topic=news returns news-style results",
    run: async () => {
      const r = await invoke({ query: "AI regulation", num: 3, topic: "news" });
      assert(!r.error, `tool returned error: ${r.error}`);
      assert(r.organic_results.length > 0, "no news returned");
    },
  },
  {
    group: "advanced",
    name: "[advanced] time_period=last_year maps to year",
    run: async () => {
      const r = await invoke({ query: "javascript runtime benchmarks", num: 3, time_period: "last_year" });
      assert(!r.error, `tool returned error: ${r.error}`);
      assert(r.organic_results.length > 0, "no results returned for time-restricted query");
    },
  },
  {
    group: "advanced",
    name: "[advanced] include_domains restricts results",
    run: async () => {
      const r = await invoke({
        query: "fetch API",
        num: 5,
        include_domains: ["developer.mozilla.org"],
      });
      assert(!r.error, `tool returned error: ${r.error}`);
      assert(r.organic_results.length > 0, "no results returned");
      for (const x of r.organic_results) {
        assert(
          typeof x.domain === "string" && x.domain.includes("mozilla.org"),
          `unexpected domain leaked through: ${x.domain}`,
        );
      }
      console.log(dim(`        all ${r.organic_results.length} results from mozilla.org`));
    },
  },
  {
    group: "advanced",
    name: "[advanced] exclude_domains filters out a domain",
    run: async () => {
      const r = await invoke({
        query: "javascript closure tutorial",
        num: 5,
        exclude_domains: ["w3schools.com"],
      });
      assert(!r.error, `tool returned error: ${r.error}`);
      for (const x of r.organic_results) {
        assert(!x.domain?.includes("w3schools.com"), `w3schools leaked through: ${x.link}`);
      }
    },
  },

  // ============== CONCURRENCY ==============
  {
    group: "concurrent",
    name: "[concurrent] 5 parallel calls all succeed",
    run: async () => {
      const queries = [
        "Bun runtime",
        "Deno runtime",
        "Node.js runtime",
        "Python asyncio",
        "Rust tokio",
      ];
      const t0 = Date.now();
      const all = await Promise.all(
        queries.map((q) => invoke({ query: q, num: 2 })),
      );
      const dt = Date.now() - t0;
      for (const r of all) assert(!r.error, `parallel call failed: ${r.error}`);
      const total = all.reduce((acc, r) => acc + (r.organic_results?.length ?? 0), 0);
      console.log(dim(`        ${queries.length} queries, ${total} total results in ${dt}ms`));
    },
  },

  // ============== ERROR PATHS ==============
  {
    group: "errors",
    name: "[errors] empty query rejected by zod schema",
    run: async () => {
      let threw = false;
      try {
        await webSearchTool.invoke({ query: "" } as never);
      } catch {
        threw = true;
      }
      assert(threw, "empty query should be rejected by schema validation");
    },
  },
  {
    group: "errors",
    name: "[errors] tiny timeout aborts gracefully",
    run: async () => {
      const r = await invoke({ query: "any deep query that needs network", num: 5, timeout: 1 });
      assert(r.error, "expected an abort error, got success");
      console.log(dim(`        got expected error → ${String(r.error).slice(0, 60)}`));
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log(bold("\n  Tavily web_search Tool — Test Suite"));
  console.log(dim(`  ${new Date().toISOString()}`));
  if (ONLY) console.log(dim(`  Filter: groups = [${ONLY.join(", ")}]`));
  if (VERBOSE) console.log(dim(`  Verbose mode ON`));

  const groups = Array.from(new Set(cases.map((c) => c.group)));
  for (const g of groups) {
    if (ONLY && !ONLY.includes(g.toLowerCase())) continue;
    header(`Group: ${g}`);
    for (const c of cases) {
      if (c.group === g) await runCase(c);
    }
  }

  // Summary
  console.log("\n" + bold("━".repeat(70)));
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const totalMs = results.reduce((a, r) => a + r.ms, 0);
  console.log(
    bold("  Summary  ") +
      ok(`${passed} passed`) +
      "  " +
      (failed > 0 ? fail(`${failed} failed`) : dim("0 failed")) +
      dim(`  (${totalMs}ms total)`),
  );
  console.log(bold("━".repeat(70)) + "\n");

  if (failed > 0) {
    console.log(fail("Failed cases:"));
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  - ${r.name}\n      ${dim(r.err ?? "")}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(fail("\nFatal error:"), e);
  process.exit(1);
});
