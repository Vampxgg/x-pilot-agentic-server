#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULTS,
  SAMPLE_DIR,
  parseArgs,
  parseSseText,
  resolveSamplePath,
  summarizeEvents,
  tryParseNestedJson,
} from "./interactive-tutorial-tester-lib.mjs";

export {
  parseArgs,
  parseSseText,
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

      if (req.method === "POST" && url.pathname === "/api/stream/edit") {
        await proxySse(req, res, opts, "/api/business/interactive-tutorial/edit-stream");
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
  const initialConfig = JSON.stringify({ target: opts.target, token: opts.token });
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
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { padding: 18px 22px; border-bottom: 1px solid var(--line); background: linear-gradient(135deg, #111827, #09090b); }
    h1 { margin: 0 0 6px; font-size: 20px; }
    p { margin: 0; color: var(--muted); }
    main { display: grid; grid-template-columns: 380px minmax(0, 1fr); gap: 14px; padding: 14px; }
    .panel { background: rgba(17, 24, 39, 0.82); border: 1px solid var(--line); border-radius: 14px; padding: 14px; }
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
    .content { min-height: 640px; }
    .timeline { display: grid; gap: 8px; }
    .event { border: 1px solid var(--line); border-left: 3px solid #52525b; border-radius: 10px; padding: 10px; background: #0b1120; }
    .event.tool { border-left-color: var(--brand); }
    .event.error { border-left-color: var(--bad); }
    .event.message { border-left-color: var(--ok); }
    .event.malformed { border-left-color: var(--warn); }
    .event-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .event-title { font-weight: 700; }
    .muted { color: var(--muted); font-size: 12px; }
    .badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; color: var(--muted); font-size: 12px; }
    details { border: 1px solid var(--line); border-radius: 10px; padding: 8px; background: #09090b; }
    summary { cursor: pointer; color: var(--brand); }
    pre { overflow: auto; max-height: 420px; margin: 8px 0 0; white-space: pre-wrap; font-size: 12px; }
    .answer { white-space: pre-wrap; line-height: 1.55; background: #09090b; border: 1px solid var(--line); border-radius: 12px; padding: 12px; min-height: 180px; }
    .hidden { display: none; }
    .notice { color: var(--warn); font-size: 12px; }
    @media (max-width: 980px) { main { grid-template-columns: 1fr; } .summary { grid-template-columns: repeat(2, 1fr); } }
  </style>
</head>
<body>
  <header>
    <h1>互动教程编辑流测试页</h1>
    <p>用于替代 Apifox 手工看流：支持样例回放、实时 chat-stream/edit-stream、Dify 与原生 v2 SSE 解析。</p>
  </header>
  <main>
    <aside class="panel stack">
      <label>API Base URL <input id="target" /></label>
      <label>Bearer Token <input id="token" type="password" /></label>
      <div class="row">
        <label>Endpoint
          <select id="endpoint">
            <option value="chat">chat-stream 推荐</option>
            <option value="edit">edit-stream deprecated</option>
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
      <label>消息 / 编辑指令 <textarea id="message">修复遗漏了的核心业务组件（components/PerspectiveLabPage）</textarea></label>
      <div class="actions">
        <button id="sendBtn">发送实时请求</button>
        <button id="stopBtn" class="danger" disabled>停止</button>
        <button id="clearBtn" class="secondary">清空</button>
      </div>
      <div class="notice">默认通过本地 Node 代理调用目标服务，便于处理鉴权与长连接。</div>
      <hr style="width:100%;border-color:var(--line)" />
      <label>样例流
        <select id="sampleSelect"></select>
      </label>
      <div class="actions">
        <button id="loadSampleBtn" class="secondary">加载样例</button>
        <button id="rawBtn" class="secondary">显示/隐藏原始事件</button>
      </div>
      <label><input id="hideNoise" type="checkbox" checked /> 隐藏 ping、空 observe/perceive、空 thought</label>
    </aside>
    <section class="stack">
      <div class="summary" id="summary"></div>
      <div class="panel content">
        <div class="tabs">
          <button class="tab active" data-tab="timeline">时间线</button>
          <button class="tab" data-tab="tools">工具调用</button>
          <button class="tab" data-tab="agents">子 Agent</button>
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
      $("endpoint").value = saved.endpoint || "chat";
      $("smartSearch").value = saved.smartSearch ?? "true";
      $("fileUrls").value = saved.fileUrls || "";
    }

    function saveSettings() {
      localStorage.setItem("tutorialTester", JSON.stringify({
        target: $("target").value,
        token: $("token").value,
        sessionId: $("sessionId").value,
        conversationId: $("conversationId").value,
        databaseId: $("databaseId").value,
        endpoint: $("endpoint").value,
        smartSearch: $("smartSearch").value,
        fileUrls: $("fileUrls").value,
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
      return {
        event,
        id: payload.id || frame.id,
        createdAt: payload.created_at || data.created_at,
        taskId: payload.task_id || payload.taskId,
        sessionId: payload.session_id || payload.conversation_id,
        nodeId: data.node_id || data.node_execution_id,
        parentId: data.parent_id || data.parentId,
        label: data.label || data.title || event,
        step: data.step || data.node_type,
        status: data.status,
        malformed: frame.malformed,
        raw: payload,
      };
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
      $("summary").innerHTML = [
        ["状态", summary.status],
        ["事件", summary.totalEvents],
        ["工具", summary.tools.length],
        ["子 Agent", summary.agents.length],
        ["错误", summary.errors.length + summary.malformedCount],
        ["耗时", summary.elapsedTime == null ? "-" : summary.elapsedTime + "s"],
      ].map(([label, value]) => '<div class="metric"><span class="muted">' + label + '</span><b>' + escapeHtml(value) + '</b></div>').join("");
    }

    function renderTimeline(frames) {
      const visible = frames.filter((frame) => !isNoise(frame));
      return '<div class="timeline">' + visible.map((frame) => {
        const n = normalize(frame);
        const cls = ["event", n.event, frame.malformed ? "malformed" : "", n.event === "error" ? "error" : "", n.event.includes("tool") || n.label?.startsWith("CALL ") ? "tool" : ""].join(" ");
        const indent = n.parentId ? "margin-left:18px" : "";
        return '<div class="' + cls + '" style="' + indent + '">' +
          '<div class="event-head"><span class="event-title">' + escapeHtml(n.label) + '</span><span class="badge">' + escapeHtml(n.event) + '</span></div>' +
          '<div class="muted">#' + escapeHtml(n.id || "-") + ' ' + escapeHtml(n.step || "") + ' ' + escapeHtml(n.status || "") + '</div>' +
          (state.showRaw ? '<details open><summary>raw</summary><pre>' + pretty(n.raw) + '</pre></details>' : '') +
        '</div>';
      }).join("") + '</div>';
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
      if (state.tab === "answer") view.innerHTML = renderAnswer(summary);
      if (state.tab === "errors") view.innerHTML = renderErrors(summary);
      if (state.tab === "raw") view.innerHTML = renderRaw(state.frames);
    }

    async function loadSamples() {
      const res = await fetch("/api/samples");
      const { samples } = await res.json();
      $("sampleSelect").innerHTML = samples.map((name) => '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>').join("");
    }

    async function loadSample() {
      const name = $("sampleSelect").value;
      if (!name) return;
      const res = await fetch("/api/samples/" + encodeURIComponent(name));
      const text = await res.text();
      state.frames = parseSseText(text);
      state.streamBuffer = "";
      render();
    }

    function buildPayload() {
      const endpoint = $("endpoint").value;
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
      if (endpoint === "edit") {
        return { sessionId: common.sessionId, conversationId: common.conversationId, editPrompt: $("message").value };
      }
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
        const res = await fetch("/api/stream/" + $("endpoint").value, {
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
    $("loadSampleBtn").addEventListener("click", loadSample);
    $("rawBtn").addEventListener("click", () => { state.showRaw = !state.showRaw; render(); });
    $("hideNoise").addEventListener("change", render);

    loadSettings();
    loadSamples().then(render);
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
