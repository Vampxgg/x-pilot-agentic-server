import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const SAMPLE_DIR = join(SCRIPT_DIR, "edit");
export const DEFAULTS = {
  target: "http://127.0.0.1:3000",
  token: "x-pilot-default-key",
  port: 3100,
};

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = { ...DEFAULTS };
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    const value = rest.join("=");
    if (key === "target" && value) opts.target = value.replace(/\/+$/, "");
    if (key === "token" && value) opts.token = value;
    if (key === "port" && value) {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }
      opts.port = port;
    }
  }
  return opts;
}

export function resolveSamplePath(name) {
  if (basename(name) !== name || !name.endsWith(".jsonl")) {
    throw new Error("Invalid sample name");
  }
  const sampleDir = resolve(SAMPLE_DIR);
  const filePath = resolve(sampleDir, name);
  if (filePath !== sampleDir && !filePath.startsWith(`${sampleDir}${sep}`)) {
    throw new Error("Invalid sample name");
  }
  return filePath;
}

export function parseSseText(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(parseSseBlock);
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const frame = {
    event: "",
    id: "",
    data: "",
    payload: null,
    malformed: false,
    raw: block,
  };

  for (const line of lines) {
    if (line.startsWith("event:")) frame.event = line.slice(6).trim();
    else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
    else if (line.startsWith("data:")) {
      frame.data += `${frame.data ? "\n" : ""}${line.slice(5).trimStart()}`;
    }
  }

  if (!frame.data) {
    frame.payload = {};
    return frame;
  }

  try {
    frame.payload = JSON.parse(frame.data);
  } catch {
    frame.malformed = true;
    frame.payload = { raw: frame.data };
  }
  return frame;
}

export function tryParseNestedJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function summarizeEvents(frames) {
  const summary = {
    answer: "",
    status: "running",
    query: "",
    taskId: "",
    sessionId: "",
    conversationId: "",
    tutorialUrl: "",
    tutorialTitle: "",
    elapsedTime: null,
    totalEvents: frames.length,
    malformedCount: frames.filter((f) => f.malformed).length,
    errors: [],
    tools: [],
    agents: [],
  };

  for (const frame of frames) {
    const payload = frame.payload ?? {};
    const event = payload.event ?? frame.event;
    const data = payload.data ?? {};
    summary.taskId ||= payload.task_id ?? payload.taskId ?? "";
    summary.sessionId ||= payload.session_id ?? payload.conversation_id ?? "";
    summary.conversationId ||= payload.conversation_id ?? "";

    if (event === "workflow_started" || event === "task_started") {
      summary.query ||= data?.inputs?.["sys.query"] ?? payload.query ?? "";
    }

    if (event === "message") {
      summary.answer += payload.answer ?? data.delta ?? data.answer ?? "";
    }

    if (event === "error" || data?.error || payload.error) {
      summary.errors.push({
        event,
        message: data?.message ?? payload.message ?? data?.error ?? payload.error ?? "Unknown error",
      });
    }

    if (event === "agent_log" && (data.node_type === "tool" || data.data?.tool_name || data.label?.startsWith("CALL "))) {
      const output = data.data?.output ?? {};
      summary.tools.push({
        name: data.data?.tool_name ?? output.tool_call_name ?? data.label?.replace(/^CALL\s+/, "") ?? "tool",
        status: data.status ?? "unknown",
        input: data.data?.tool_input,
        output: tryParseNestedJson(output.tool_response ?? output ?? data.data?.output),
        elapsedTime: data.elapsed_time,
      });
    }

    if (event === "tool_finished") {
      summary.tools.push({
        name: data.tool_name ?? "tool",
        status: data.status ?? "unknown",
        input: data.arguments,
        output: tryParseNestedJson(data.output),
        elapsedTime: data.elapsed_time,
      });
    }

    if (event === "agent_log" && data.node_type === "agent") {
      summary.agents.push({
        name: data.data?.agent_name ?? data.label ?? "agent",
        status: data.status ?? "unknown",
        instruction: data.data?.instruction ?? "",
        childTaskId: data.data?.child_task_id ?? "",
      });
    }

    if (event === "workflow_finished" || event === "task_finished" || event === "node_finished") {
      summary.status = data.status ?? payload.status ?? summary.status;
      summary.elapsedTime = data.elapsed_time ?? payload.elapsed_time ?? summary.elapsedTime;
      const outputs = data.outputs ?? payload.outputs ?? {};
      summary.tutorialUrl ||= outputs.tutorialUrl ?? outputs.url ?? "";
      summary.tutorialTitle ||= outputs.tutorialTitle ?? outputs.title ?? "";
    }
  }

  if (summary.errors.length > 0 && summary.status === "running") summary.status = "failed";
  return summary;
}
