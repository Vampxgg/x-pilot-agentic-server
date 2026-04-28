/**
 * One-off / repeatable: materialize interactive-tutorial agent prompts into scripts/agent/prompts/*.md
 * Run from repo root: node scripts/agent/build-interactive-tutorial-prompt-docs.mjs
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const APP = join(REPO, "apps", "interactive-tutorial");
const OUT = join(REPO, "scripts", "agent", "prompts");

async function readMdBody(relPath) {
  const raw = await readFile(join(APP, relPath), "utf-8");
  return matter(raw).content.trim();
}

function buildStaticSystemPrompt({ identity, soul, mission, tools }) {
  const sections = [];
  if (identity) sections.push(`# Identity\n${identity}`);
  if (soul) sections.push(`# Soul\n${soul}`);
  if (mission) sections.push(`# Mission\n${mission}`);
  if (tools) sections.push(`# Tool Usage Guidelines\n${tools}`);
  return sections.join("\n\n---\n\n");
}

const SEP = "\n\n===================\n\n";

function docHeader(agentId, folder, extraNotes = "") {
  return (
    `# ${agentId}\n\n` +
    `**源码目录**：\`apps/interactive-tutorial/${folder}/\`\n\n` +
    "**系统提示词拼装**：`src/core/agent-graph.ts` → `buildSystemPrompt()`（各 Markdown 节之间用字面量换行 + `---` 分隔；另有动态节见下文）。\n\n" +
    (extraNotes ? `${extraNotes}\n\n` : "")
  );
}

function dynamicSystemSection() {
  return (
    "## 动态注入（追加到系统提示词末尾，与静态节之间仍为换行 + `---` 分隔）\n\n" +
    "1. **# Task Context** — 当 `invokeAgent` / `streamAgentV2` 传入 `options.context` 时，将整个 `context` 对象 `JSON.stringify(context, null, 2)` 注入。\n" +
    "2. **# Session** — 当存在 `sessionId` 时追加会话与工作区说明。\n" +
    "3. **# Long-term Memory** — 来自 MemoryManager 的长期记忆字符串（可能为空）。\n" +
    "4. **## Available Skills** — 若该 Agent 目录下 `skills/*.md` 非空，经 `formatSkillsForPrompt` 格式化追加（当前多数 tutorial Agent 无本地 skills）。\n" +
    "5. **输出格式**：`agent.config.yaml` 的 `outputFormat` 等由 `parseAgentOutput`（`src/core/output-parser.ts`）在收尾阶段处理，**不一定**出现在上述 system 字符串中。\n"
  );
}

function pipelineUserTemplate() {
  return (
    `You are executing pipeline step "\${stepName}".\n\n` +
    `【Original Request】\n\${initialInput}\n` +
    `\n【Pipeline Context】（仅当 context 含下列字段时逐行输出）\n` +
    `conversation_id: ...\nuser_id: ...\nsession_id: ...\n` +
    `\n【Context from Previous Steps】\n` +
    `--- \${depName} output ---\n\${serializedDepResult}   (每依赖一步至多 50_000 字符)\n` +
    `\n【Mapped Inputs】（仅当 step 配置了 inputMapping 时出现）\n`
  );
}

const AGENTS = [
  {
    id: "interactive-tutorial-director",
    folder: "interactive-tutorial-director",
    userBlocks: [
      {
        title: "用户提示词 — HTTP 对话（主路径）",
        body:
          "`POST /api/business/interactive-tutorial/chat-stream`：`streamAgentV2(DIRECTOR_AGENT, body.message, { skipPipeline: true, context: { businessType, conversationId, databaseId?, smartSearch? }, ... })`。\n\n" +
          "- **首轮 HumanMessage 内容**：`body.message`（用户原始输入）。\n" +
          "- **多轮**：同一 `threadId = conversationId` checkpoint 续写，后续轮次为用户新消息。",
      },
      {
        title: "用户提示词 — [DEPRECATED] generate-stream",
        body:
          "组装的 `message`：\n" +
          "- 有 `userPrompt`：`请生成一个关于「${topic}」的互动教材。\\n补充需求：${userPrompt}`\n" +
          "- 否则：`请生成一个关于「${topic}」的互动教材。`",
      },
      {
        title: "用户提示词 — [DEPRECATED] edit-stream",
        body: "`body.editPrompt` 原样作为 HumanMessage。",
      },
      {
        title: "用户提示词 — 工具 start_generation_pipeline 内部",
        body:
          "不经过 Director 的 LangGraph。`PipelineExecutor.execute(directorDef, initialInput, ...)` 其中：\n\n" +
          "```\ninitialInput = `【Generation Brief — 由总导演整理】\\n${params.brief}`\n```\n\n" +
          "该字符串作为整条管线的 `initialInput`，进入各 pipeline 子步骤的 `buildStepInstruction`（见下述子 Agent）。",
      },
      {
        title: "用户提示词 — spawn_sub_agent(tutorial-scene-editor, …)",
        body: "子 Agent 的 **instruction** 由 Director 在工具参数中编写，无固定模板。",
      },
    ],
  },
  {
    id: "tutorial-content-researcher",
    folder: "tutorial-content-researcher",
    userBlocks: [
      {
        title: "用户提示词 — 研究缓存命中（不调用本 Agent）",
        body:
          "`handlers.researchWithCache`：当 `(topic, databaseId)` 命中磁盘缓存时，直接把缓存结果写入 `artifacts/research.json` 并返回，**不会**执行 `invokeAgent('tutorial-content-researcher', ...)`，因此不存在本轮 HumanMessage / 系统提示词加载。",
      },
      {
        title: "用户提示词 — researchWithCache（缓存未命中，handler 调用）",
        body:
          "通常 `ctx.previousResults.size === 0`，故：\n\n" +
          "```\nHumanMessage = initialInput   // 即管线 initialInput（含「Generation Brief」整段）\n```\n\n" +
          "若未来某步在 research 之前写入 `previousResults` 且 size>0：\n\n" +
          "```\n${initialInput}\\n\\n【Context from Previous Steps】\\n- stepKey: 截取前 200 字符...\n```",
      },
      {
        title: "用户提示词 — 等价 pipeline 模板（若改为 pipeline agent 步）",
        body: "与 `buildStepInstruction` 一致，见文件末尾「管线通用用户提示模板」。",
      },
    ],
  },
  {
    id: "tutorial-scene-architect",
    folder: "tutorial-scene-architect",
    userBlocks: [
      {
        title: "用户提示词 — 正常管线 architect 步",
        body:
          "`buildStepInstruction`：`step.name=architect`，`dependsOn=[research]`。\n\n" +
          "- **【Original Request】**：整条管线的 `initialInput`。\n" +
          "- **【Context from Previous Steps】**：含 `--- research output ---` + research 步骤结果（字符串或 JSON 序列化，至多 50000 字符）。\n" +
          "  - research 为 handler 时：结果为缓存恢复/研究员输出的对象或字符串。",
      },
      {
        title: "用户提示词 — saveBlueprint 内联重试（retryArchitectOnce）",
        body:
          "```\n${initialInput}\\n\\n【RETRY】Previous architect run did not produce a parseable blueprint nor write artifacts/blueprint.json. \" +\n" +
          "`You MUST call workspace_write({name: \"artifacts/blueprint.json\", content: <stringified blueprint JSON>}) \" +\n" +
          "`before declaring the task complete. The blueprint MUST follow the schema in your MISSION (title, components[], teaching_guide).` +\n" +
          "`${researchExcerpt}`   // 若有 research.json：\\n\\n【Research Report ...】\\n 前 4000 字符\n```",
      },
    ],
  },
  {
    id: "tutorial-coder",
    folder: "tutorial-coder",
    userBlocks: [
      {
        title: "用户提示词 — 管线 code 步",
        body:
          "`buildStepInstruction`：`step.name=code`，`dependsOn=[save-blueprint]`。\n\n" +
          "- **【Original Request】**：`initialInput`。\n" +
          "- **【Context from Previous Steps】**：`--- save-blueprint output ---` + saveBlueprint 返回值（规范化后的 blueprint 对象 JSON）。",
      },
    ],
  },
  {
    id: "tutorial-component-coder",
    folder: "tutorial-component-coder",
    userBlocks: [
      {
        title: "用户提示词 — Pipeline fan-out（当前 director 管线未使用本 Agent）",
        body:
          "`PipelineExecutor.executeFanOut` 调用 `buildStepInstruction({...step, dependsOn: undefined}, new Map([['_item', item], ['_index', index]]), <item 字符串>, options)`。\n\n" +
          "当前实现下 **【Original Request】** 仅为第三个参数：单个 `components[]` 项的 `JSON.stringify(item, null, 2)`（或字符串 item）。`results` Map 中的 `_item` / `_index` **不会**自动拼进用户提示文本（与 MISSION 文档中「_item 在指令中」的表述可能不一致，以代码为准）。\n\n" +
          "```text\nYou are executing pipeline step \"<step.name>\".\n\n【Original Request】\n<单个组件 JSON>\n\n【Pipeline Context】（可选）\n```",
      },
    ],
  },
  {
    id: "tutorial-app-shell-coder",
    folder: "tutorial-app-shell-coder",
    userBlocks: [
      {
        title: "用户提示词 — 当前 director 管线未挂载本步",
        body: "若旧管线配置为 pipeline agent 步，则与 `tutorial-coder` 类似，使用 `buildStepInstruction`，依赖上游 `save-blueprint` 等。",
      },
    ],
  },
  {
    id: "tutorial-scene-editor",
    folder: "tutorial-scene-editor",
    userBlocks: [
      {
        title: "用户提示词 — spawn_sub_agent",
        body:
          "`instruction` 为 Director 组装的自然语言（须含修改意图、文件线索等）。无全局 `buildStepInstruction` 包装。\n\n" +
          "MISSION 中描述的 `editPrompt` / `sessionId` 为语义说明；运行时即上述 instruction + 会话 options。",
      },
    ],
  },
];

async function main() {
  await mkdir(OUT, { recursive: true });

  const pipelineTemplateBlock =
    `## 管线通用用户提示模板（buildStepInstruction）\n\n` +
    `源码：\`src/core/pipeline-executor.ts\`。\n\n` +
    "```text\n" +
    pipelineUserTemplate() +
    "```\n";

  for (const a of AGENTS) {
    const identity = await readMdBody(join(a.folder, "IDENTITY.md")).catch(() => "");
    const soul = await readMdBody(join(a.folder, "SOUL.md")).catch(() => "");
    const mission = await readMdBody(join(a.folder, "MISSION.md")).catch(() => "");
    const tools = await readMdBody(join(a.folder, "TOOLS.md")).catch(() => "");
    const staticSys = buildStaticSystemPrompt({ identity, soul, mission, tools });

    let extra =
      a.id === "interactive-tutorial-director"
        ? "该 Agent 在 `agent.config.yaml` 中配置了 **pipeline**；仅当 `skipPipeline: true` 时才会走 LangGraph 并加载下列静态系统提示。`skipPipeline: false` 时 `invokeAgent` 只执行管线，不加载 Director 的 LLM 系统提示词。\n"
        : "";

    const parts = [
      docHeader(a.id, a.folder, extra),
      "> 文中 **`===================`** 仅作文档分隔，对应「静态系统提示词 / 动态系统注入 / 各用户提示变体」等不同块。\n\n",
      "## 系统提示词（静态部分）\n\n以下等价于运行时 `buildSystemPrompt` 在 **无** Task Context / Session / Long-term Memory / Skills 时的主体。\n\n```\n" +
        staticSys +
        "\n```",
      SEP.trim(),
      dynamicSystemSection(),
      SEP.trim(),
    ];

    for (const ub of a.userBlocks) {
      parts.push(`## ${ub.title}\n\n${ub.body}`);
      parts.push(SEP.trim());
    }

    parts.push(pipelineTemplateBlock);

    const text = parts.join("\n\n") + "\n";
    await writeFile(join(OUT, `${a.id}.md`), text, "utf-8");
    console.log("wrote", a.id);
  }

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
