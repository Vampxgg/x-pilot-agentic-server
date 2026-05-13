#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_AVM_PROMPT,
  DEFAULTS,
  SAMPLE_DIR,
  buildEventTree,
  classifyRun,
  normalizeFrame,
  parseArgs,
  parseSseText,
  resolveReplayDir,
  resolveReplayFile,
  resolveSamplePath,
  summarizeEvents,
  tryParseNestedJson,
} from "./interactive-tutorial-tester-lib.mjs";

export {
  parseArgs,
  buildEventTree,
  classifyRun,
  normalizeFrame,
  parseSseText,
  resolveReplayDir,
  resolveReplayFile,
  resolveSamplePath,
  summarizeEvents,
  tryParseNestedJson,
};

async function listSamples() {
  try {
    const entries = await readdir(SAMPLE_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function listReplayFiles(dir, opts) {
  const resolvedDir = resolveReplayDir(dir, { replayRoot: opts.replayRoot });
  const entries = await readdir(resolvedDir.absolutePath, { withFileTypes: true });
  return {
    dir: resolvedDir.relativePath,
    entries: entries
      .filter((entry) => entry.isDirectory() || /\.(jsonl|sse|txt)$/i.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
        path: `${resolvedDir.relativePath}/${entry.name}`.replace(/\\/g, "/"),
      }))
      .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`)),
  };
}

async function readJson(req) {
  const raw = await readRaw(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString("utf8"));
}

function readRaw(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

function targetUrl(opts, path) {
  return `${opts.target.replace(/\/+$/, "")}${path}`;
}

async function proxySse(req, res, opts, endpoint) {
  const body = await readJson(req);
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const upstream = await fetch(targetUrl(opts, endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${body.token || opts.token}`,
    },
    body: JSON.stringify(body.payload ?? {}),
    signal: abort.signal,
  });

  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Upstream-Status": String(upstream.status),
    "X-Stream-Protocol": upstream.headers.get("x-stream-protocol") ?? "",
    "X-Task-Id": upstream.headers.get("x-task-id") ?? "",
    "X-Session-Id": upstream.headers.get("x-session-id") ?? upstream.headers.get("x-conversation-id") ?? "",
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  res.end();
}

async function proxyRaw(req, res, opts, endpoint) {
  const body = await readRaw(req);
  const headers = {
    Authorization: req.headers.authorization ?? `Bearer ${opts.token}`,
  };
  if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];

  const upstream = await fetch(targetUrl(opts, endpoint), {
    method: "POST",
    headers,
    body,
  });
  const raw = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
  });
  res.end(raw);
}

export function createTesterServer(opts = DEFAULTS) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        sendText(res, 200, renderHtml(opts), "text/html; charset=utf-8");
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        sendJson(res, 200, { target: opts.target, token: opts.token });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/samples") {
        sendJson(res, 200, { samples: await listSamples() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/replay/list") {
        try {
          sendJson(res, 200, await listReplayFiles(url.searchParams.get("dir") ?? opts.replayRoot, opts));
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/replay/file") {
        try {
          const resolvedFile = resolveReplayFile(url.searchParams.get("path") ?? "", { replayRoot: opts.replayRoot });
          createReadStream(resolvedFile.absolutePath)
            .on("error", () => sendJson(res, 404, { error: "Replay file not found" }))
            .pipe(res);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/samples/")) {
        const name = decodeURIComponent(url.pathname.replace("/api/samples/", ""));
        let samplePath;
        try {
          samplePath = resolveSamplePath(name);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        createReadStream(samplePath)
          .on("error", () => sendJson(res, 404, { error: "Sample not found" }))
          .pipe(res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/stream/chat") {
        await proxySse(req, res, opts, "/api/business/interactive-tutorial/chat-stream");
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/uploads") {
        await proxyRaw(req, res, opts, "/api/uploads");
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function renderHtml(opts) {
  const initialConfig = JSON.stringify({
    target: opts.target,
    token: opts.token,
    replayRoot: opts.replayRoot,
    defaultPrompt: DEFAULT_AVM_PROMPT,
  });
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>互动教程编辑流测试页</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --panel: #111827;
      --panel-2: #18181b;
      --line: #27272a;
      --text: #e5e7eb;
      --muted: #9ca3af;
      --brand: #22d3ee;
      --ok: #34d399;
      --bad: #fb7185;
      --warn: #fbbf24;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { height: 72px; padding: 14px 22px; border-bottom: 1px solid var(--line); background: linear-gradient(135deg, #111827, #09090b); }
    h1 { margin: 0 0 6px; font-size: 20px; }
    p { margin: 0; color: var(--muted); }
    main { height: calc(100vh - 72px); display: grid; grid-template-columns: 380px minmax(0, 1fr); gap: 14px; padding: 14px; overflow: hidden; }
    .panel { background: rgba(17, 24, 39, 0.82); border: 1px solid var(--line); border-radius: 14px; padding: 14px; }
    aside.panel { height: 100%; min-height: 0; overflow-y: auto; align-content: start; }
    section.stack { height: 100%; min-height: 0; overflow: hidden; grid-template-rows: auto minmax(0, 1fr); }
    .stack { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
    input, textarea, select, button { border: 1px solid var(--line); border-radius: 10px; background: #09090b; color: var(--text); padding: 9px 10px; font: inherit; }
    textarea { min-height: 112px; resize: vertical; }
    button { cursor: pointer; background: #155e75; border-color: #0e7490; }
    button.secondary { background: #27272a; border-color: #3f3f46; }
    button.danger { background: #881337; border-color: #be123c; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .summary { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
    .metric { background: var(--panel-2); border: 1px solid var(--line); border-radius: 12px; padding: 10px; }
    .metric b { display: block; font-size: 18px; margin-top: 4px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
    .tab { background: #18181b; border-color: #27272a; }
    .tab.active { background: #155e75; border-color: #22d3ee; }
    .content { min-height: 0; overflow: hidden; display: grid; grid-template-rows: auto minmax(0, 1fr); }
    #view { overflow: auto; min-height: 0; padding-right: 4px; }
    .timeline { display: grid; gap: 8px; }
    .tree { display: grid; gap: 6px; }
    .tree-children { display: grid; gap: 6px; margin-left: 18px; padding-left: 10px; border-left: 1px dashed #334155; }
    .event { border: 1px solid var(--line); border-left: 4px solid #52525b; border-radius: 10px; padding: 10px; background: #0b1120; }
    .event.round { border-left-color: #64748b; }
    .event.think { border-left-color: #a78bfa; }
    .event.act, .event.tool { border-left-color: var(--brand); }
    .event.agent { border-left-color: #60a5fa; }
    .event.progress { border-left-color: var(--warn); }
    .event.tool { border-left-color: var(--brand); }
    .event.error { border-left-color: var(--bad); }
    .event.message { border-left-color: var(--ok); }
    .event.generation-risk { border-left-color: #fb923c; box-shadow: inset 0 0 0 1px rgba(251,146,60,.3); }
    .event.malformed { border-left-color: var(--warn); }
    .event-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .event-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .event-title { font-weight: 700; }
    .toggle { width: 26px; padding: 2px 0; border-radius: 7px; background: #18181b; }
    .muted { color: var(--muted); font-size: 12px; }
    .badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; color: var(--muted); font-size: 12px; }
    .badge.bad { color: #fecdd3; border-color: #be123c; background: rgba(190, 18, 60, .2); }
    .badge.good { color: #bbf7d0; border-color: #059669; background: rgba(5, 150, 105, .18); }
    .badge.warn { color: #fde68a; border-color: #d97706; background: rgba(217, 119, 6, .18); }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 12px; min-height: 0; }
    .detail { position: sticky; top: 0; align-self: start; max-height: calc(100vh - 180px); overflow: auto; }
    details { border: 1px solid var(--line); border-radius: 10px; padding: 8px; background: #09090b; }
    summary { cursor: pointer; color: var(--brand); }
    pre { overflow: auto; max-height: 420px; margin: 8px 0 0; white-space: pre-wrap; font-size: 12px; }
    .answer { white-space: pre-wrap; line-height: 1.55; background: #09090b; border: 1px solid var(--line); border-radius: 12px; padding: 12px; min-height: 180px; }
    .hidden { display: none; }
    .notice { color: var(--warn); font-size: 12px; }
    @media (max-width: 980px) {
      html, body { overflow: auto; }
      main { height: auto; grid-template-columns: 1fr; overflow: visible; }
      aside.panel, section.stack, .content, #view { height: auto; overflow: visible; }
      .summary { grid-template-columns: repeat(2, 1fr); }
      .split { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>互动教程编辑流测试页</h1>
    <p>用于替代 Apifox 手工看流：支持事件回看、实时 chat-stream、Dify 与原生 v2 SSE 解析。</p>
  </header>
  <main>
    <aside class="panel stack">
      <label>API Base URL <input id="target" /></label>
      <label>Bearer Token <input id="token" type="password" /></label>
      <div class="row">
        <label>运行模式
          <select id="runMode">
            <option value="generate">首轮生成（可空 sessionId）</option>
            <option value="edit">后续编辑（必须复用 sessionId）</option>
          </select>
        </label>
        <label>smartSearch
          <select id="smartSearch">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </label>
      </div>
      <label>sessionId <input id="sessionId" placeholder="首次可为空，后续编辑复用" /></label>
      <label>conversationId <input id="conversationId" placeholder="可为空，服务端自动生成" /></label>
      <label>databaseId <input id="databaseId" placeholder="可选" /></label>
      <label>fileIds（逗号分隔）<input id="fileIds" placeholder="file_xxx,file_yyy" /></label>
      <label>fileUrls（JSON 对象数组）
        <textarea id="fileUrls" placeholder='[{"fileName":"demo.pdf","fileType":"application/pdf","url":"https://..."}]'></textarea>
      </label>
      <label>消息 / 编辑指令 <textarea id="message"></textarea></label>
      <div class="actions">
        <button id="sendBtn">发送实时请求</button>
        <button id="stopBtn" class="danger" disabled>停止</button>
        <button id="clearBtn" class="secondary">清空</button>
        <button id="defaultPromptBtn" class="secondary">恢复默认 AVM 提示</button>
      </div>
      <div class="notice">默认通过本地 Node 代理调用目标服务，便于处理鉴权与长连接。</div>
      <hr style="width:100%;border-color:var(--line)" />
      <label>事件回看目录
        <input id="replayDir" placeholder="scripts/edit 或 scripts/generation" />
      </label>
      <label>事件流文件
        <select id="replayFileSelect"></select>
      </label>
      <div class="actions">
        <button id="listReplayBtn" class="secondary">刷新目录</button>
        <button id="loadReplayBtn" class="secondary">加载回看</button>
        <button id="rawBtn" class="secondary">显示/隐藏 raw</button>
      </div>
      <label><input id="hideNoise" type="checkbox" checked /> 隐藏 ping、空 observe/perceive、空 thought</label>
    </aside>
    <section class="stack">
      <div class="summary" id="summary"></div>
      <div class="panel content">
        <div class="tabs">
          <button class="tab active" data-tab="timeline">事件树</button>
          <button class="tab" data-tab="tools">工具调用</button>
          <button class="tab" data-tab="agents">子 Agent</button>
          <button class="tab" data-tab="diagnosis">路径诊断</button>
          <button class="tab" data-tab="answer">最终回复</button>
          <button class="tab" data-tab="errors">错误诊断</button>
          <button class="tab" data-tab="raw">原始事件</button>
        </div>
        <div id="view"></div>
      </div>
    </section>
  </main>
  <script>
    const INITIAL_CONFIG = ${initialConfig};
    const state = {
      frames: [],
      tab: "timeline",
      showRaw: false,
      collapsed: new Set(),
      selectedNode: null,
      treeFilter: "all",
      abort: null,
      streamBuffer: "",
    };

    const $ = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const pretty = (value) => escapeHtml(JSON.stringify(value, null, 2));

    function loadSettings() {
      const saved = JSON.parse(localStorage.getItem("tutorialTester") || "{}");
      $("target").value = saved.target || INITIAL_CONFIG.target;
      $("token").value = saved.token || INITIAL_CONFIG.token;
      $("sessionId").value = saved.sessionId || "";
      $("conversationId").value = saved.conversationId || "";
      $("databaseId").value = saved.databaseId || "";
      $("runMode").value = saved.runMode || "generate";
      $("smartSearch").value = saved.smartSearch ?? "true";
      $("fileUrls").value = saved.fileUrls || "";
      $("replayDir").value = saved.replayDir || "scripts/edit";
      $("message").value = saved.message || INITIAL_CONFIG.defaultPrompt;
    }

    function saveSettings() {
      localStorage.setItem("tutorialTester", JSON.stringify({
        target: $("target").value,
        token: $("token").value,
        sessionId: $("sessionId").value,
        conversationId: $("conversationId").value,
        databaseId: $("databaseId").value,
        runMode: $("runMode").value,
        smartSearch: $("smartSearch").value,
        fileUrls: $("fileUrls").value,
        replayDir: $("replayDir").value,
        message: $("message").value,
      }));
    }

    function parseSseText(text) {
      return text.split(/\r?\n\r?\n/).map((block) => block.trim()).filter(Boolean).map(parseSseBlock);
    }

    function parseSseBlock(block) {
      const frame = { event: "", id: "", data: "", payload: null, malformed: false, raw: block };
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        else if (line.startsWith("data:")) frame.data += (frame.data ? "\n" : "") + line.slice(5).trimStart();
      }
      if (!frame.data) {
        frame.payload = {};
        return frame;
      }
      try { frame.payload = JSON.parse(frame.data); }
      catch { frame.malformed = true; frame.payload = { raw: frame.data }; }
      return frame;
    }

    function appendSseChunk(chunk) {
      state.streamBuffer += chunk;
      const parts = state.streamBuffer.split(/\r?\n\r?\n/);
      state.streamBuffer = parts.pop() || "";
      for (const part of parts) {
        if (part.trim()) state.frames.push(parseSseBlock(part.trim()));
      }
      render();
    }

    function tryParseNestedJson(value) {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
      try { return JSON.parse(trimmed); } catch { return value; }
    }

    function normalize(frame) {
      const payload = frame.payload || {};
      const data = payload.data || {};
      const event = payload.event || frame.event;
      const output = data.data?.output || {};
      const toolName = data.data?.tool_name || output.tool_call_name || data.tool_name || (data.label?.startsWith("CALL ") ? data.label.replace(/^CALL\s+/, "") : "");
      return {
        event,
        id: payload.id || frame.id,
        businessId: data.id || payload.id || frame.id,
        createdAt: payload.created_at || data.created_at,
        taskId: payload.task_id || payload.taskId,
        sessionId: payload.session_id || payload.conversation_id,
        nodeId: data.node_id || data.node_execution_id,
        parentId: data.parent_id || data.parentId,
        label: data.label || data.title || event,
        step: data.step || data.node_type,
        status: data.status,
        nodeType: data.node_type || (event.includes("tool") ? "tool" : ""),
        toolName,
        toolCallId: data.data?.tool_call_id || output.tool_call_id || data.tool_call_id || "",
        input: data.data?.tool_input || data.arguments,
        output: tryParseNestedJson(output.tool_response || data.output || data.data?.output),
        phase: data.phase || data.metadata?.stage || "",
        agentName: data.data?.agent_name || data.agent_name || "",
        instruction: data.data?.instruction || data.instruction || "",
        elapsedTime: data.elapsed_time,
        malformed: frame.malformed,
        raw: payload,
      };
    }

    function buildTree(frames) {
      const nodes = [];
      const byBusinessId = new Map();
      const byToolCallId = new Map();
      for (const frame of frames) {
        const n = normalize(frame);
        const node = { ...n, key: (n.id || nodes.length) + "-" + (n.businessId || n.event), startEventId: n.id, endEventId: "", endBusinessId: "", children: [] };
        if (node.toolCallId) {
          const existing = byToolCallId.get(node.toolCallId);
          if (existing) {
            if (node.status && node.status !== "started") existing.status = node.status;
            existing.endEventId = node.id;
            existing.endBusinessId = node.businessId;
            existing.output = node.output || existing.output;
            existing.elapsedTime = node.elapsedTime || existing.elapsedTime;
            continue;
          }
          byToolCallId.set(node.toolCallId, node);
        }
        nodes.push(node);
        if (node.businessId) byBusinessId.set(String(node.businessId), node);
      }
      const roots = [];
      for (const node of nodes) {
        const parent = node.parentId ? byBusinessId.get(String(node.parentId)) : null;
        if (parent && parent !== node) parent.children.push(node);
        else roots.push(node);
      }
      return { roots, nodes };
    }

    function classifyRun(frames, summary) {
      const normalized = frames.map(normalize);
      const tools = new Set(summary.tools.map((tool) => tool.name).filter(Boolean));
      normalized.forEach((frame) => frame.toolName && tools.add(frame.toolName));
      const phases = new Set(normalized.map((frame) => frame.phase).filter(Boolean));
      const hasGenerationTool = tools.has("start_generation_pipeline");
      const hasEditToolChain = tools.has("workspace_read") && (tools.has("spawn_sub_agent") || normalized.some((frame) => frame.agentName === "tutorial-scene-editor"));
      const hasReassemble = tools.has("reassemble_app");
      const hasGenerationPhases = ["research", "architect", "code", "assemble"].some((phase) => phases.has(phase));
      const expectedEdit = $("runMode")?.value === "edit";
      let kind = "unknown";
      let label = "失败或未知";
      if (hasGenerationTool || hasGenerationPhases) {
        kind = "generation";
        label = "首轮生成或完整生成管线";
      }
      if (!hasGenerationTool && hasEditToolChain) {
        kind = "edit";
        label = hasReassemble ? "后续编辑路径" : "编辑路径未完整收尾";
      }
      if (expectedEdit && (hasGenerationTool || hasGenerationPhases)) {
        kind = "mixed_or_suspicious";
        label = "疑似误生成：编辑期触发完整生成管线";
      }
      return { kind, label, evidence: { tools: [...tools], phases: [...phases], hasGenerationTool, hasEditToolChain, hasReassemble, hasGenerationPhases, hasTutorialUrl: Boolean(summary.tutorialUrl) } };
    }

    function summarize(frames) {
      const summary = { answer: "", status: "running", query: "", taskId: "", sessionId: "", conversationId: "", tutorialUrl: "", tutorialTitle: "", elapsedTime: null, errors: [], tools: [], agents: [], totalEvents: frames.length, malformedCount: frames.filter((f) => f.malformed).length };
      for (const frame of frames) {
        const payload = frame.payload || {};
        const data = payload.data || {};
        const event = payload.event || frame.event;
        summary.taskId ||= payload.task_id || payload.taskId || "";
        summary.sessionId ||= payload.session_id || payload.conversation_id || "";
        summary.conversationId ||= payload.conversation_id || "";
        if (event === "workflow_started" || event === "task_started") summary.query ||= data?.inputs?.["sys.query"] || payload.query || "";
        if (event === "message") summary.answer += payload.answer || data.delta || data.answer || "";
        if (event === "error" || data?.error || payload.error) summary.errors.push({ event, message: data?.message || payload.message || data?.error || payload.error || "Unknown error" });
        if (event === "agent_log" && (data.node_type === "tool" || data.data?.tool_name || data.label?.startsWith("CALL "))) {
          const output = data.data?.output || {};
          summary.tools.push({ name: data.data?.tool_name || output.tool_call_name || data.label?.replace(/^CALL\s+/, "") || "tool", status: data.status || "unknown", input: data.data?.tool_input, output: tryParseNestedJson(output.tool_response || output || data.data?.output), elapsedTime: data.elapsed_time });
        }
        if (event === "tool_finished") summary.tools.push({ name: data.tool_name || "tool", status: data.status || "unknown", input: data.arguments, output: tryParseNestedJson(data.output), elapsedTime: data.elapsed_time });
        if (event === "agent_log" && data.node_type === "agent") summary.agents.push({ name: data.data?.agent_name || data.label || "agent", status: data.status || "unknown", instruction: data.data?.instruction || "", childTaskId: data.data?.child_task_id || "" });
        if (event === "workflow_finished" || event === "task_finished" || event === "node_finished") {
          summary.status = data.status || payload.status || summary.status;
          summary.elapsedTime = data.elapsed_time || payload.elapsed_time || summary.elapsedTime;
          const outputs = data.outputs || payload.outputs || {};
          summary.tutorialUrl ||= outputs.tutorialUrl || outputs.url || "";
          summary.tutorialTitle ||= outputs.tutorialTitle || outputs.title || "";
        }
      }
      if (summary.errors.length && summary.status === "running") summary.status = "failed";
      return summary;
    }

    function isNoise(frame) {
      if (!$("hideNoise").checked) return false;
      const n = normalize(frame);
      const data = frame.payload?.data || {};
      if (n.event === "ping") return true;
      if (["observe", "perceive"].includes(n.step) && !data.error && !data.output) return true;
      if (/Thought/.test(n.label) && !data?.data?.output && !data.output) return true;
      return false;
    }

    function renderSummary(summary) {
      const diagnosis = classifyRun(state.frames, summary);
      const statusClass = diagnosis.kind === "mixed_or_suspicious" ? "bad" : diagnosis.kind === "edit" ? "good" : diagnosis.kind === "generation" ? "warn" : "";
      $("summary").innerHTML = [
        ["状态", summary.status],
        ["事件", summary.totalEvents],
        ["工具", summary.tools.length],
        ["子 Agent", summary.agents.length],
        ["错误", summary.errors.length + summary.malformedCount],
        ["路径", diagnosis.label],
      ].map(([label, value], index) => '<div class="metric"><span class="muted">' + label + '</span><b class="' + (index === 5 ? statusClass : "") + '">' + escapeHtml(value) + '</b></div>').join("");
    }

    function renderTimeline(frames) {
      const tree = buildTree(frames.filter((frame) => !isNoise(frame)));
      const selected = state.selectedNode || tree.nodes[0] || null;
      const controls = '<div class="toolbar">' +
        '<button class="secondary" data-action="expand-all">全部展开</button>' +
        '<button class="secondary" data-action="collapse-all">全部折叠</button>' +
        '<button class="secondary" data-action="filter-tools">' + (state.treeFilter === "tools" ? "显示全部" : "仅工具和错误") + '</button>' +
        '</div>';
      return controls + '<div class="split"><div class="tree">' + tree.roots.map((node) => renderTreeNode(node)).join("") + '</div>' + renderDetail(selected) + '</div>';
    }

    function renderTreeNode(node) {
      const hasChildren = node.children.length > 0;
      const collapsed = state.collapsed.has(node.key);
      const isToolOrError = node.nodeType === "tool" || node.event.includes("tool") || node.event === "error" || node.malformed || node.status === "failed";
      if (state.treeFilter === "tools" && !isToolOrError && !node.children.some((child) => child.nodeType === "tool" || child.event === "error" || child.status === "failed")) return "";
      const kind = node.toolName === "start_generation_pipeline" ? "generation-risk" : node.nodeType === "agent" ? "agent" : node.nodeType === "tool" ? "tool" : node.step || node.event;
      const cls = ["event", kind, node.malformed ? "malformed" : "", node.event === "error" || node.status === "failed" ? "error" : ""].join(" ");
      const toggle = hasChildren ? '<button class="toggle" data-toggle="' + escapeHtml(node.key) + '">' + (collapsed ? "+" : "-") + '</button>' : '<span class="toggle muted">·</span>';
      const risk = node.toolName === "start_generation_pipeline" ? '<span class="badge bad">完整生成管线</span>' : "";
      const body = '<div class="' + cls + '" data-select="' + escapeHtml(node.key) + '">' +
        '<div class="event-head"><div class="event-main">' + toggle + '<span class="event-title">' + escapeHtml(node.label || node.toolName || node.event) + '</span>' + risk + '</div><span class="badge">' + escapeHtml(node.event) + '</span></div>' +
        '<div class="muted">event #' + escapeHtml(node.startEventId || "-") + (node.endEventId ? " -> #" + escapeHtml(node.endEventId) : "") + ' · id=' + escapeHtml(node.businessId || "-") + ' · parent=' + escapeHtml(node.parentId || "-") + ' · exec=' + escapeHtml(node.nodeExecutionId || "-") + ' · ' + escapeHtml(node.status || "") + '</div>' +
        (state.showRaw ? '<details open><summary>raw</summary><pre>' + pretty(node.raw) + '</pre></details>' : '') +
      '</div>';
      const children = hasChildren && !collapsed ? '<div class="tree-children">' + node.children.map((child) => renderTreeNode(child)).join("") + '</div>' : "";
      return body + children;
    }

    function renderDetail(node) {
      if (!node) return '<aside class="panel detail"><p class="muted">请选择一个事件节点查看详情。</p></aside>';
      return '<aside class="panel detail">' +
        '<h3 style="margin-top:0">事件详情</h3>' +
        '<p><span class="badge">' + escapeHtml(node.event) + '</span> <span class="badge">' + escapeHtml(node.status || "unknown") + '</span></p>' +
        '<pre>' + pretty({ id: node.businessId, parentId: node.parentId, eventId: node.startEventId, endEventId: node.endEventId, nodeExecutionId: node.nodeExecutionId, toolName: node.toolName, input: node.input, output: node.output, instruction: node.instruction, raw: node.raw }) + '</pre>' +
      '</aside>';
    }

    function renderTools(summary) {
      if (!summary.tools.length) return '<p class="muted">暂无工具调用。</p>';
      return summary.tools.map((tool, index) =>
        '<details open><summary>' + escapeHtml(index + 1) + '. ' + escapeHtml(tool.name) + ' <span class="badge">' + escapeHtml(tool.status) + '</span></summary>' +
        '<pre>' + pretty({ input: tool.input, output: tool.output, elapsedTime: tool.elapsedTime }) + '</pre></details>'
      ).join("");
    }

    function renderAgents(summary) {
      if (!summary.agents.length) return '<p class="muted">暂无子 Agent。</p>';
      return summary.agents.map((agent, index) =>
        '<details open><summary>' + escapeHtml(index + 1) + '. ' + escapeHtml(agent.name) + ' <span class="badge">' + escapeHtml(agent.status) + '</span></summary>' +
        '<pre>' + pretty(agent) + '</pre></details>'
      ).join("");
    }

    function renderAnswer(summary) {
      const link = summary.tutorialUrl ? '<p><a href="' + escapeHtml(summary.tutorialUrl) + '" target="_blank" rel="noreferrer">打开预览：' + escapeHtml(summary.tutorialTitle || summary.tutorialUrl) + '</a></p>' : "";
      return link + '<div class="answer">' + escapeHtml(summary.answer || "暂无最终回复流。") + '</div>';
    }

    function renderErrors(summary) {
      const all = [...summary.errors, ...state.frames.filter((f) => f.malformed).map((f) => ({ event: f.event, message: f.data }))];
      if (!all.length) return '<p class="muted">暂无错误或坏帧。</p>';
      return all.map((error) => '<div class="event error"><b>' + escapeHtml(error.event) + '</b><pre>' + escapeHtml(error.message) + '</pre></div>').join("");
    }

    function renderRaw(frames) {
      return '<pre>' + pretty(frames.map((frame) => ({ event: frame.event, id: frame.id, malformed: frame.malformed, payload: frame.payload }))) + '</pre>';
    }

    function render() {
      const summary = summarize(state.frames);
      if (summary.sessionId) $("sessionId").value ||= summary.sessionId;
      if (summary.conversationId) $("conversationId").value ||= summary.conversationId;
      renderSummary(summary);
      const view = $("view");
      if (state.tab === "timeline") view.innerHTML = renderTimeline(state.frames);
      if (state.tab === "tools") view.innerHTML = renderTools(summary);
      if (state.tab === "agents") view.innerHTML = renderAgents(summary);
      if (state.tab === "diagnosis") view.innerHTML = renderDiagnosis(summary);
      if (state.tab === "answer") view.innerHTML = renderAnswer(summary);
      if (state.tab === "errors") view.innerHTML = renderErrors(summary);
      if (state.tab === "raw") view.innerHTML = renderRaw(state.frames);
    }

    function renderDiagnosis(summary) {
      const diagnosis = classifyRun(state.frames, summary);
      const sessionInput = $("sessionId").value;
      const conversationInput = $("conversationId").value;
      const sessionMismatch = sessionInput && summary.sessionId && sessionInput !== summary.sessionId;
      const rows = [
        ["本轮类型", diagnosis.label],
        ["调用 start_generation_pipeline", diagnosis.evidence.hasGenerationTool ? "是" : "否"],
        ["调用 workspace_read + editor", diagnosis.evidence.hasEditToolChain ? "是" : "否"],
        ["调用 reassemble_app", diagnosis.evidence.hasReassemble ? "是" : "否"],
        ["出现生成阶段 phase", diagnosis.evidence.hasGenerationPhases ? diagnosis.evidence.phases.join(", ") : "否"],
        ["输出 tutorialUrl", diagnosis.evidence.hasTutorialUrl ? summary.tutorialUrl : "否"],
        ["sessionId 输入", sessionInput || "空"],
        ["conversationId 输入", conversationInput || "空"],
        ["返回 session_id", summary.sessionId || "无"],
        ["sessionId 是否不一致", sessionMismatch ? "是，请核对是否误填 conversationId" : "否"],
      ];
      const warn = diagnosis.kind === "mixed_or_suspicious"
        ? '<div class="event generation-risk"><b>检测到完整生成管线</b><p class="muted">你当前选择的是后续编辑，但事件流出现 start_generation_pipeline 或完整生成 phase。本轮不是纯编辑。</p></div>'
        : "";
      return warn + '<div class="timeline">' + rows.map(([k, v]) => '<div class="event"><div class="event-head"><b>' + escapeHtml(k) + '</b><span class="badge">' + escapeHtml(v) + '</span></div></div>').join("") + '</div>';
    }

    async function listReplay() {
      saveSettings();
      const dir = $("replayDir").value || "scripts/edit";
      const res = await fetch("/api/replay/list?dir=" + encodeURIComponent(dir));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "无法读取回看目录");
      const files = data.entries.filter((entry) => entry.type === "file");
      $("replayFileSelect").innerHTML = files.map((entry) => '<option value="' + escapeHtml(entry.path) + '">' + escapeHtml(entry.name) + '</option>').join("");
      if (files.length === 0) {
        $("replayFileSelect").innerHTML = '<option value="">该目录没有事件流文件</option>';
      }
    }

    async function loadReplay() {
      const path = $("replayFileSelect").value;
      if (!path) return;
      const res = await fetch("/api/replay/file?path=" + encodeURIComponent(path));
      const text = await res.text();
      if (!res.ok) throw new Error(text);
      state.frames = parseSseText(text);
      state.streamBuffer = "";
      state.selectedNode = null;
      render();
    }

    function buildPayload() {
      const fileIds = $("fileIds").value.split(",").map((s) => s.trim()).filter(Boolean);
      const rawFileUrls = $("fileUrls").value.trim();
      let fileUrls;
      if (rawFileUrls) {
        fileUrls = JSON.parse(rawFileUrls);
        if (!Array.isArray(fileUrls)) throw new Error("fileUrls 必须是 JSON 对象数组");
      }
      const common = {
        conversationId: $("conversationId").value || undefined,
        sessionId: $("sessionId").value || undefined,
      };
      return {
        ...common,
        message: $("message").value,
        databaseId: $("databaseId").value || undefined,
        smartSearch: $("smartSearch").value === "true",
        fileIds: fileIds.length ? fileIds : undefined,
        fileUrls: fileUrls?.length ? fileUrls : undefined,
      };
    }

    async function sendStream() {
      saveSettings();
      state.frames = [];
      state.streamBuffer = "";
      state.abort = new AbortController();
      $("sendBtn").disabled = true;
      $("stopBtn").disabled = false;
      render();
      try {
        if ($("runMode").value === "edit" && !$("sessionId").value) {
          throw new Error("后续编辑模式必须填写 sessionId，否则会创建新工作区并极可能被当成重新生成。");
        }
        const res = await fetch("/api/stream/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: $("token").value, payload: buildPayload() }),
          signal: state.abort.signal,
        });
        if (!res.ok && !res.body) throw new Error("HTTP " + res.status);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          appendSseChunk(decoder.decode(value, { stream: true }));
        }
        if (state.streamBuffer.trim()) state.frames.push(parseSseBlock(state.streamBuffer.trim()));
      } catch (err) {
        if (err.name !== "AbortError") {
          state.frames.push({ event: "error", id: "", data: String(err.message || err), payload: { event: "error", data: { message: String(err.message || err) } }, malformed: false, raw: String(err) });
        }
      } finally {
        $("sendBtn").disabled = false;
        $("stopBtn").disabled = true;
        state.abort = null;
        render();
      }
    }

    document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.tab = btn.dataset.tab;
      render();
    }));
    $("sendBtn").addEventListener("click", sendStream);
    $("stopBtn").addEventListener("click", () => state.abort?.abort());
    $("clearBtn").addEventListener("click", () => { state.frames = []; state.streamBuffer = ""; render(); });
    $("defaultPromptBtn").addEventListener("click", () => { $("message").value = INITIAL_CONFIG.defaultPrompt; saveSettings(); });
    $("listReplayBtn").addEventListener("click", () => listReplay().catch((err) => alert(err.message || err)));
    $("loadReplayBtn").addEventListener("click", () => loadReplay().catch((err) => alert(err.message || err)));
    $("rawBtn").addEventListener("click", () => { state.showRaw = !state.showRaw; render(); });
    $("hideNoise").addEventListener("change", render);
    $("view").addEventListener("click", (event) => {
      const toggle = event.target.closest("[data-toggle]");
      if (toggle) {
        const key = toggle.getAttribute("data-toggle");
        if (state.collapsed.has(key)) state.collapsed.delete(key);
        else state.collapsed.add(key);
        render();
        return;
      }
      const selected = event.target.closest("[data-select]");
      if (selected) {
        const tree = buildTree(state.frames.filter((frame) => !isNoise(frame)));
        state.selectedNode = tree.nodes.find((node) => node.key === selected.getAttribute("data-select")) || null;
        render();
        return;
      }
      const action = event.target.closest("[data-action]")?.getAttribute("data-action");
      if (action === "expand-all") state.collapsed.clear();
      if (action === "collapse-all") buildTree(state.frames).nodes.forEach((node) => state.collapsed.add(node.key));
      if (action === "filter-tools") state.treeFilter = state.treeFilter === "tools" ? "all" : "tools";
      if (action) render();
    });

    loadSettings();
    listReplay().catch(() => {}).then(render);
  </script>
</body>
</html>`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const opts = parseArgs();
  const server = createTesterServer(opts);
  server.listen(opts.port, "127.0.0.1", () => {
    console.log(`Interactive tutorial tester: http://127.0.0.1:${opts.port}`);
    console.log(`Target API: ${opts.target}`);
  });
}
