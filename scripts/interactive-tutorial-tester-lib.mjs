import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_REPLAY_ROOT = SCRIPT_DIR;
export const SAMPLE_DIR = join(SCRIPT_DIR, "edit");
export const DEFAULT_AVM_PROMPT = `你是一名智能网联汽车技术专业的老师，现在准备汽车全景环视系统工作原理的课程，同学们理解视频拼接是一个难题，想做一个关于汽车全景环视系统工作原理互动小程序。为了让抽象的拼接原理变得直观，小程序的核心是“拆解原理 → 动手调节 → 观察变化”的交互逻辑。
可以考虑以下几个核心功能： 虚拟布景与摄像头 展示核心：在一个3D虚拟场景中放置一个清晰的3D汽车模型，并在其前、后、左、后视镜下方等标准位置，用半透明的“视锥”标示出4个广角摄像头，并注明每个摄像头的视野范围（如190度），帮助学生建立对硬件布局和视场角的直观认知。
交互方式：用户可以用鼠标拖拽旋转、缩放3D场景，从任意角度观察摄像头的安装位置和视野覆盖。 分步原理演示（核心模块） 这个模块是教学的关键，建议设计几个互动的步骤按钮：
第一步：鱼眼原图：当用户点击某方向摄像头（如车头）时，显示其拍摄的原始“桶形畸变”图像。最好能设计一个滑块，让学生滑动查看畸变校正前后的效果对比。
第二步：畸变矫正：点击后，图像上的畸变被修复，可以设计一个“矫正开关”，让学生来回对比，理解算法对原始图像的修正过程。
第三步：透视变换：点击后，图像从“侧视”被“压平”为俯视的“鸟瞰图”。这里也可以设计一个切换按钮，对比“侧视”和“鸟瞰”效果，讲解投影变换的原理。
第四步：图像拼接：将四张处理好的鸟瞰图合成为一张完整的全景图。可以设计一个带“融合效果”滑块的步骤，演示相邻图像是如何通过“图像融合”技术（如渐入渐出）实现无缝衔接的。
第五步：3D车模叠加：在拼接好的全景图中央，动态地叠加一个汽车3D模型，最终呈现完整的环视效果。 交互式小练习 可以设计一些小练习来巩固所学。例如，展示一幅有拼接瑕疵（如错位、色差）的全景图，让学生通过滑块或画笔来调整拼接参数，直到画面完美。这种“玩中学”的方式能极大地加深理解。`;
export const DEFAULTS = {
  target: "http://127.0.0.1:3000",
  token: "x-pilot-default-key",
  port: 3100,
  replayRoot: "scripts",
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
    if (key === "replay-root" && value) opts.replayRoot = value.replace(/\\/g, "/").replace(/\/+$/, "");
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

function toPosixPath(pathValue) {
  return pathValue.split(sep).join("/");
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveReplayRoot(replayRoot = DEFAULTS.replayRoot) {
  const root = replayRoot.startsWith("scripts")
    ? resolve(WORKSPACE_ROOT, replayRoot)
    : resolve(DEFAULT_REPLAY_ROOT, replayRoot);
  return root;
}

export function resolveReplayDir(dir = DEFAULTS.replayRoot, opts = {}) {
  const replayRoot = resolveReplayRoot(opts.replayRoot ?? DEFAULTS.replayRoot);
  const absolutePath = dir.startsWith("scripts")
    ? resolve(WORKSPACE_ROOT, dir)
    : resolve(replayRoot, dir);
  if (!isInside(replayRoot, absolutePath)) {
    throw new Error("Replay path is outside replay root");
  }
  return {
    absolutePath,
    relativePath: toPosixPath(relative(WORKSPACE_ROOT, absolutePath)),
  };
}

export function resolveReplayFile(pathValue, opts = {}) {
  const replayRoot = resolveReplayRoot(opts.replayRoot ?? DEFAULTS.replayRoot);
  const absolutePath = pathValue.startsWith("scripts")
    ? resolve(WORKSPACE_ROOT, pathValue)
    : resolve(replayRoot, pathValue);
  if (!isInside(replayRoot, absolutePath)) {
    throw new Error("Replay path is outside replay root");
  }
  if (!/\.(jsonl|sse|txt)$/i.test(pathValue)) {
    throw new Error("Replay file must be .jsonl, .sse, or .txt");
  }
  return {
    absolutePath,
    relativePath: toPosixPath(relative(WORKSPACE_ROOT, absolutePath)),
  };
}

export function resolveReplaySavePath(dir, filename, opts = {}) {
  if (!filename || basename(filename) !== filename || /[\\/]/.test(filename)) {
    throw new Error("Invalid replay filename");
  }
  if (!/\.(jsonl|sse|txt)$/i.test(filename)) {
    throw new Error("Replay file must be .jsonl, .sse, or .txt");
  }

  const resolvedDir = resolveReplayDir(dir, opts);
  const absolutePath = resolve(resolvedDir.absolutePath, filename);
  const replayRoot = resolveReplayRoot(opts.replayRoot ?? DEFAULTS.replayRoot);
  if (!isInside(replayRoot, absolutePath)) {
    throw new Error("Replay path is outside replay root");
  }

  return {
    absolutePath,
    relativePath: toPosixPath(relative(WORKSPACE_ROOT, absolutePath)),
  };
}

export function normalizeFrame(frame) {
  const payload = frame.payload ?? {};
  const data = payload.data ?? {};
  const event = payload.event ?? frame.event;
  const logData = event === "agent_log" ? data : {};
  const toolOutput = logData.data?.output ?? {};
  const toolName = logData.data?.tool_name
    ?? toolOutput.tool_call_name
    ?? data.tool_name
    ?? (logData.label?.startsWith("CALL ") ? logData.label.replace(/^CALL\s+/, "") : "");
  const toolCallId = logData.data?.tool_call_id
    ?? toolOutput.tool_call_id
    ?? data.tool_call_id
    ?? "";
  const nodeType = logData.node_type
    ?? (event === "tool_started" || event === "tool_finished" ? "tool" : "")
    ?? "";
  const phase = data.phase ?? data.metadata?.stage ?? "";

  return {
    event,
    eventId: String(payload.id ?? frame.id ?? ""),
    businessId: String(logData.id ?? data.id ?? payload.id ?? frame.id ?? ""),
    parentId: logData.parent_id ?? data.parent_id ?? data.parentId ?? null,
    label: logData.label ?? data.title ?? data.message ?? event,
    step: logData.step ?? data.node_type ?? phase ?? event,
    status: logData.status ?? data.status ?? "",
    nodeType,
    nodeId: logData.node_id ?? data.node_id ?? "",
    nodeExecutionId: logData.node_execution_id ?? data.node_execution_id ?? "",
    toolName,
    toolCallId,
    input: logData.data?.tool_input ?? data.arguments,
    output: tryParseNestedJson(toolOutput.tool_response ?? data.output ?? logData.data?.output),
    agentName: logData.data?.agent_name ?? data.agent_name ?? "",
    childTaskId: logData.data?.child_task_id ?? data.child_task_id ?? "",
    instruction: logData.data?.instruction ?? data.instruction ?? "",
    phase,
    elapsedTime: logData.elapsed_time ?? data.elapsed_time,
    malformed: frame.malformed,
    raw: payload,
  };
}

export function buildEventTree(frames) {
  const nodes = [];
  const byBusinessId = new Map();
  const byToolCallId = new Map();

  for (const frame of frames) {
    const normalized = normalizeFrame(frame);
    const node = {
      ...normalized,
      id: `${normalized.eventId || nodes.length}-${normalized.businessId || normalized.event}`,
      startEventId: normalized.eventId,
      endEventId: "",
      endBusinessId: "",
      children: [],
    };

    if (node.toolCallId) {
      const existing = byToolCallId.get(node.toolCallId);
      if (existing) {
        if (node.status && node.status !== "started") existing.status = node.status;
        existing.endEventId = node.eventId;
        existing.endBusinessId = node.businessId;
        existing.output = node.output ?? existing.output;
        existing.elapsedTime = node.elapsedTime ?? existing.elapsedTime;
        continue;
      }
      byToolCallId.set(node.toolCallId, node);
    }

    nodes.push(node);
    if (node.businessId) byBusinessId.set(node.businessId, node);
  }

  const roots = [];
  for (const node of nodes) {
    const parent = node.parentId ? byBusinessId.get(node.parentId) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  return { roots, nodes };
}

export function classifyRun(frames, summary = summarizeEvents(frames), opts = {}) {
  const normalized = frames.map(normalizeFrame);
  const tools = new Set(summary.tools.map((tool) => tool.name).filter(Boolean));
  for (const frame of normalized) {
    if (frame.toolName) tools.add(frame.toolName);
  }
  const phases = new Set(normalized.map((frame) => frame.phase).filter(Boolean));
  const hasGenerationTool = tools.has("start_generation_pipeline");
  const hasEditToolChain = tools.has("workspace_read") && (tools.has("spawn_sub_agent") || normalized.some((frame) => frame.agentName === "tutorial-scene-editor"));
  const hasReassemble = tools.has("reassemble_app");
  const hasGenerationPhases = ["research", "architect", "code", "assemble"].some((phase) => phases.has(phase));
  const hasTutorialUrl = Boolean(summary.tutorialUrl);
  const evidence = {
    tools: Array.from(tools),
    phases: Array.from(phases),
    hasGenerationTool,
    hasEditToolChain,
    hasReassemble,
    hasGenerationPhases,
    hasTutorialUrl,
  };

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
  if (opts.expectedMode === "edit" && (hasGenerationTool || hasGenerationPhases)) {
    kind = "mixed_or_suspicious";
    label = "疑似误生成：编辑期触发完整生成管线";
  }

  return { kind, label, evidence };
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
