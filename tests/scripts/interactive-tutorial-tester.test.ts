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
      replayRoot: "scripts",
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

  it("builds a collapsible event tree and pairs lifecycle events", () => {
    const { buildEventTree, parseSseText } = helpers;
    const frames = parseSseText([
      "event: agent_log",
      "id: 1",
      'data: {"event":"agent_log","data":{"id":"round-1","label":"ROUND 1","step":"round","status":"started","parent_id":null}}',
      "",
      "event: agent_log",
      "id: 2",
      'data: {"event":"agent_log","data":{"id":"tool-start","parent_id":"round-1","label":"CALL workspace_read","step":"act","status":"started","node_type":"tool","data":{"tool_name":"workspace_read","tool_call_id":"call-1","tool_input":{"name":"artifacts/blueprint.json"}}}}',
      "",
      "event: agent_log",
      "id: 3",
      'data: {"event":"agent_log","data":{"id":"tool-end","parent_id":"round-1","label":"CALL workspace_read","step":"act","status":"succeeded","node_type":"tool","data":{"output":{"tool_call_id":"call-1","tool_call_name":"workspace_read","tool_response":"{\\"success\\":true}"}},"elapsed_time":0.2}}',
      "",
    ].join("\n"));

    const tree = buildEventTree(frames);

    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].businessId).toBe("round-1");
    expect(tree.roots[0].children).toHaveLength(1);
    expect(tree.roots[0].children[0]).toMatchObject({
      toolName: "workspace_read",
      status: "succeeded",
      startEventId: "2",
      endEventId: "3",
      businessId: "tool-start",
      endBusinessId: "tool-end",
    });
  });

  it("classifies generation, edit, and suspicious runs", () => {
    const { classifyRun, parseSseText, summarizeEvents } = helpers;
    const generationFrames = parseSseText([
      "event: agent_log",
      "id: 1",
      'data: {"event":"agent_log","data":{"id":"tool-start","label":"CALL start_generation_pipeline","step":"act","status":"started","node_type":"tool","data":{"tool_name":"start_generation_pipeline","tool_call_id":"gen-1"}}}',
      "",
      "event: progress",
      "id: 2",
      'data: {"event":"progress","data":{"phase":"research","message":"research"}}',
      "",
      "event: progress",
      "id: 3",
      'data: {"event":"progress","data":{"phase":"assemble","message":"assemble"}}',
      "",
    ].join("\n"));
    const editFrames = parseSseText([
      "event: agent_log",
      "id: 1",
      'data: {"event":"agent_log","data":{"id":"read","label":"CALL workspace_read","step":"act","status":"succeeded","node_type":"tool","data":{"tool_name":"workspace_read"}}}',
      "",
      "event: agent_log",
      "id: 2",
      'data: {"event":"agent_log","data":{"id":"agent","label":"tutorial-scene-editor","step":"act","status":"started","node_type":"agent","data":{"agent_name":"tutorial-scene-editor"}}}',
      "",
      "event: agent_log",
      "id: 3",
      'data: {"event":"agent_log","data":{"id":"reassemble","label":"CALL reassemble_app","step":"act","status":"succeeded","node_type":"tool","data":{"tool_name":"reassemble_app"}}}',
      "",
    ].join("\n"));

    expect(classifyRun(generationFrames, summarizeEvents(generationFrames)).kind).toBe("generation");
    expect(classifyRun(editFrames, summarizeEvents(editFrames)).kind).toBe("edit");
    expect(classifyRun(generationFrames, summarizeEvents(generationFrames), { expectedMode: "edit" }).kind).toBe("mixed_or_suspicious");
  });

  it("keeps replay paths inside the configured replay root", () => {
    const { resolveReplayDir, resolveReplayFile } = helpers;

    expect(resolveReplayDir("scripts/generation").relativePath).toBe("scripts/generation");
    expect(resolveReplayFile("scripts/generation/generation1.jsonl").relativePath).toBe("scripts/generation/generation1.jsonl");
    expect(() => resolveReplayDir("../secrets")).toThrow(/outside replay root/);
    expect(() => resolveReplayFile("scripts/generation/../../secrets/key.json")).toThrow(/outside replay root/);
  });

  it("resolves replay save paths safely", () => {
    const { resolveReplaySavePath } = helpers;

    const savePath = resolveReplaySavePath("scripts/generation", "generation-20260513-112530.jsonl");
    expect(savePath.relativePath).toBe("scripts/generation/generation-20260513-112530.jsonl");
    expect(savePath.absolutePath.endsWith("scripts\\generation\\generation-20260513-112530.jsonl")).toBe(true);

    expect(() => resolveReplaySavePath("../secrets", "leak.jsonl")).toThrow(/outside replay root/);
    expect(() => resolveReplaySavePath("scripts/generation", "../leak.jsonl")).toThrow(/Invalid replay filename/);
    expect(() => resolveReplaySavePath("scripts/generation", "bad.exe")).toThrow(/Replay file must be/);
  });
});
