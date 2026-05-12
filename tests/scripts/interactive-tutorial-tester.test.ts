import { beforeAll, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

let helpers: Record<string, any>;

beforeAll(async () => {
  helpers = await import(
    /* @vite-ignore */ pathToFileURL(resolve("scripts/interactive-tutorial-tester-lib.mjs")).href
  );
});

describe("interactive tutorial tester helpers", () => {
  it("parses CLI defaults and overrides", () => {
    const { parseArgs } = helpers;
    expect(parseArgs(["--target=http://localhost:3001", "--token=abc", "--port=3102"])).toEqual({
      target: "http://localhost:3001",
      token: "abc",
      port: 3102,
    });
  });

  it("parses dify-style SSE blocks and keeps malformed payloads", () => {
    const { parseSseText } = helpers;
    const frames = parseSseText([
      "event: workflow_started",
      "id: 1",
      'data: {"event":"workflow_started","task_id":"task_1","conversation_id":"conv_1","data":{"inputs":{"sys.query":"修复页面"}}}',
      "",
      "event: message",
      "id: 2",
      'data: {"event":"message","answer":"完成"}',
      "",
      "event: agent_log",
      "id: 3",
      "data: {bad json",
      "",
    ].join("\n"));

    expect(frames).toHaveLength(3);
    expect(frames[0].payload.data.inputs["sys.query"]).toBe("修复页面");
    expect(frames[1].payload.answer).toBe("完成");
    expect(frames[2].malformed).toBe(true);
  });

  it("summarizes native and dify message/tool events", () => {
    const { parseSseText, summarizeEvents } = helpers;
    const frames = parseSseText([
      "event: message",
      "id: 1",
      'data: {"event":"message","data":{"delta":"A"}}',
      "",
      "event: message",
      "id: 2",
      'data: {"event":"message","answer":"B"}',
      "",
      "event: tool_finished",
      "id: 3",
      'data: {"event":"tool_finished","data":{"tool_name":"workspace_read","status":"succeeded","output":"{\\"ok\\":true}"}}',
      "",
      "event: task_finished",
      "id: 4",
      'data: {"event":"task_finished","data":{"status":"succeeded","elapsed_time":1.5,"outputs":{"tutorialUrl":"http://example.test/tutorial"}}}',
      "",
    ].join("\n"));

    const summary = summarizeEvents(frames);

    expect(summary.answer).toBe("AB");
    expect(summary.tools).toHaveLength(1);
    expect(summary.tools[0].name).toBe("workspace_read");
    expect(summary.status).toBe("succeeded");
    expect(summary.tutorialUrl).toBe("http://example.test/tutorial");
  });

  it("keeps sample paths inside scripts/edit", () => {
    const { resolveSamplePath } = helpers;
    expect(resolveSamplePath("edit1.jsonl").endsWith("scripts\\edit\\edit1.jsonl")).toBe(true);
    expect(() => resolveSamplePath("../package.json")).toThrow(/Invalid sample name/);
  });

  it("parses real edit samples into useful summaries", () => {
    const { parseSseText, summarizeEvents } = helpers;

    for (const sampleName of ["edit1.jsonl", "edit2.jsonl", "edit3.jsonl"]) {
      const text = readFileSync(resolve("scripts/edit", sampleName), "utf8");
      const frames = parseSseText(text);
      const summary = summarizeEvents(frames);

      expect(frames.length).toBeGreaterThan(100);
      expect(summary.tools.length).toBeGreaterThan(0);
      expect(["succeeded", "failed"]).toContain(summary.status);
    }
  });
});
