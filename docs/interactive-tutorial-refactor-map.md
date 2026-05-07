# 互动教材生成智能体 — 调整地图（代码事实源）

> 本文描述 `apps/interactive-tutorial` 域及相关核心编排、构建链路的改造范围，便于评审、交接与回归。路径均相对于仓库根目录 `x-pilot-agentic-server`。

## 1. 文档目的与范围

- **目的**：把围绕「总生成时间最短」的架构与工程改造，按**模块 → 文件 → 行为变化**串成可导航地图。
- **范围**：本仓库内 `apps/interactive-tutorial`、`src/core/pipeline-executor.ts`，以及与构建相关的模板仓库 `react-code-rander`（仅说明耦合点）。

## 2. 流水线拓扑（Director）

**配置文件**：`apps/interactive-tutorial/interactive-tutorial-director/agent.config.yaml`

| 顺序 | Step 名 | 类型 | 说明 |
|------|---------|------|------|
| 1 | `research` | Handler `researchWithCache` | 可选；带磁盘缓存的研究 |
| 2 | `architect` | Agent `tutorial-scene-architect` | 蓝图设计（常通过工具写入 workspace） |
| 3 | `save-blueprint` | Handler `saveBlueprint` | 规范化并确保 `artifacts/blueprint.json` |
| 4a | `components` | Agent `tutorial-component-coder` | **并行 fan-out**，逐项生成单组件 |
| 4b | `app-shell` | Agent `tutorial-app-shell-coder` | 与 4a **同批并行**，生成 `App.tsx` 壳 |
| 5 | `assemble` | Handler `assembleApp` | 模板准备、同步 workspace、Vite 构建与 AI 修复 |

**并行与 fan-out 要点**：

- `components`：`parallel: true`，`fanOutFrom: save-blueprint.components`。
- **为何不是 `architect.components`**：Architect 的 Mission 要求优先 `workspace_write` 写入 `artifacts/blueprint.json`，此时 **pipeline 中 `architect` step 的原始返回值可能是自然语言总结而非 JSON**。`saveBlueprint` 已实现「workspace 已有蓝图优先 → 解析 architect 输出 → 落 raw」三级逻辑，因此 fan-out 必须基于 **`save-blueprint` 的返回对象**上的 `components` 数组。

## 3. Agent 资产地图

### 3.1 新增子 Agent

| 目录 | 职责 | 配置 |
|------|------|------|
| `apps/interactive-tutorial/tutorial-component-coder/` | 每个 fan-out 实例生成**一个** `.tsx` 组件 | `agent.config.yaml`：偏 worker 模型、工具限 `workspace_read` / `workspace_write`、JSON 输出 schema |
| `apps/interactive-tutorial/tutorial-app-shell-coder/` | 生成 `App.tsx`（导入、错误边界等） | 同上 |

每个目录通常含：`IDENTITY.md`、`SOUL.md`、`MISSION.md`、`TOOLS.md`、`memory/MEMORY.md`。

### 3.2 强化 Architect

**文件**：`apps/interactive-tutorial/tutorial-scene-architect/agent.config.yaml`

- `components`：`minItems: 3`、`maxItems: 12`
- `file_name`：`pattern: ^[A-Z][A-Za-z0-9]+\.tsx$`（PascalCase + `.tsx`）

**文件**：`apps/interactive-tutorial/tutorial-scene-architect/MISSION.md` — 与上述 schema 对齐的文案约束（唯一 `file_name`、组件数量等）。

### 3.3 Researcher（指引类改动）

**文件**：`tutorial-content-researcher/MISSION.md`、`tutorial-content-researcher/TOOLS.md` — 强调单轮内**并行**调用检索类工具，减少串行等待。

## 4. 域内注册（`code/index.ts`）

**文件**：`apps/interactive-tutorial/code/index.ts`

Pipeline Handler 注册：

- `saveBlueprint`、`assembleApp`、`reassembleApp`、`researchWithCache`（新增）

动态工具注册：

- `start_generation_pipeline`、`reassemble_app`

路由：`registerInteractiveTutorialRoutes`（`code/routes.ts`）。

## 5. `handlers.ts` 能力分区

**文件**：`apps/interactive-tutorial/code/handlers.ts`（大文件，按块阅读）

### 5.1 `prepareSourceDir`

- **目标**：避免每次全量递归复制整个 React 模板（尤其 `node_modules`、`public`、`src/sdk`）。
- **做法**：
  - 对大体量、相对静态目录使用 **Windows junction** 链接到模板侧同源目录。
  - 常量 `JUNCTIONED_DIRS`：**`public`、`src/sdk`、`script`**。
    - **`script` 必选原因**：模板 `react-code-rander/vite.config.ts` 将 `script/sdk-showcase.html` 配置为 rollup 多入口之一；若 per-session `source/` 下缺少 `script/`，Vite 会报错：`Could not resolve entry module "script/sdk-showcase.html"`。
  - 根目录与 `src` 小文件白名单拷贝（`ROOT_TEMPLATE_FILES`、`SRC_TEMPLATE_FILES`）。
  - 清空并重建 `src/components/`，供后续 workspace 同步写入。

### 5.2 `normalizeBlueprint` + `saveBlueprint`

- **normalizeBlueprint**：清洗 `components[]`、`file_name` 合法化与去重改名，降低 fan-out 文件碰撞风险。
- **saveBlueprint**：优先读 workspace `artifacts/blueprint.json`；否则解析 architect step 输出；再否则保存 raw 并记录告警。

### 5.3 `buildWithAIRepair` 与组装路径

- **并发 AI 修复**：`p-queue`，并发度 `REPAIR_CONCURRENCY`（环境变量 `TUTORIAL_REPAIR_CONCURRENCY` 可覆盖）。
- **TSC**：在 Vite 多轮修复仍失败后作为 **fallback**，不再默认每次构建前全量 `tsc`。
- **分阶段预览**：首次构建成功时通过 `eventBus` 发 **`preview_ready`**（含 URL 等元数据，具体见 handlers 内 `assembleApp` 与 `buildWithAIRepair` 的 hooks）。
- **`assembleApp` / `firstAssembly` / `reassembleForSession`**：统一使用 `prepareSourceDir`；可写 `logs/assemble-metrics.json` 等耗时埋点（以代码为准）。

### 5.4 `researchWithCache`

- 缓存目录：`data/cache/research/`（`RESEARCH_CACHE_DIR`）
- TTL：`RESEARCH_CACHE_TTL_MS`（默认 7 天）
- 键：`normalizeTopic(topic)` + `databaseId` 的 SHA256 摘要
- 命中：恢复 workspace 中研究产物并跳过后续 researcher 调用

## 6. Director 工具与可观测性（`code/tools.ts`）

**文件**：`apps/interactive-tutorial/code/tools.ts`

- `createStartGenerationPipelineTool` 在 `PipelineExecutor.execute` 执行期间：
  - `eventBus.onSession(sessionId, …)` 收集 `type === "progress"` 事件为 `timeline`
  - 识别 `stage === "preview_ready"` 计算 **`firstPreviewMs`**
  - 返回 JSON 含 **`metrics`**（如 `totalMs`、`firstPreviewMs`）

与 HTTP SSE 同源：`GET /api/sessions/:sessionId/events`（`src/api/routes/agent.routes.ts`）。

## 7. 编排引擎（`src/core/pipeline-executor.ts`）

- 每步开始/结束发送 **`progress`**：`stage` 为 `step_started` / `step_finished`，`phase` 为 step 名，`durationMs` 等。
- **`executeFanOut`**：发送 fan-out 开始/结束类进度（`count`、`successCount`、`durationMs` 等，以实现为准）。

## 8. 模板路径与 Vite 耦合

- **解析**：`apps/interactive-tutorial/code/template-dir.ts` — 环境变量 `TUTORIAL_TEMPLATE_DIR` 或 director `metadata.templateDir` 或默认 `../react-code-rander`。
- **多入口**：`react-code-rander/vite.config.ts` 中 `build.rollupOptions.input` 含 `index.html` 与 `script/sdk-showcase.html` → per-session `source` 必须可见 **`script/`**（由 `JUNCTIONED_DIRS` 保证）。

## 9. 基准脚本

**文件**：`scripts/benchmark-tutorial.ts`

- 进程内 `agentRegistry.initialize()` + `PipelineExecutor.execute(interactive-tutorial-director, …)`，用于测端到端管线耗时（不经由 Director LLM 再包一层）。
- 用法示例：`npx tsx scripts/benchmark-tutorial.ts --only=binary_search --tag=new2`
- 报告默认写入 `reports/benchmark-<tag>-<iso>.json`。

## 10. 已知风险与待办检查

1. **`components` 形态**：若 Architect 写入的 `artifacts/blueprint.json` 中 `components` 为 **对象** 而非数组，`fanOutFrom` 仍会失败（`got object`）。可在 `normalizeBlueprint` / `saveBlueprint` 增加「对象键序 → 数组」兼容（待产品决策）。
2. **Architect 双轨输出**：文本总结 + 文件落盘并存；管线已用 `save-blueprint` 对齐 fan-out，但仍依赖蓝图 JSON 结构合法。
3. **Windows junction**：权限或策略异常时会走 copy 回退（见 `prepareSourceDir`）。
4. **OpenRouter / LangChain Zod 警告**：与 structured output 约束相关，需与线上模型行为分开观测。

## 11. 按文件索引（快速跳转）

| 路径 | 说明 |
|------|------|
| `apps/interactive-tutorial/interactive-tutorial-director/agent.config.yaml` | 管线、fan-out、模板元数据 |
| `apps/interactive-tutorial/tutorial-component-coder/**` | 单组件并行 coder |
| `apps/interactive-tutorial/tutorial-app-shell-coder/**` | App 壳 coder |
| `apps/interactive-tutorial/tutorial-scene-architect/**` | Architect schema + Mission |
| `apps/interactive-tutorial/tutorial-content-researcher/**` | 并行工具指引 |
| `apps/interactive-tutorial/code/handlers.ts` | 模板、蓝图、构建、研究缓存 |
| `apps/interactive-tutorial/code/tools.ts` | timeline / metrics |
| `apps/interactive-tutorial/code/index.ts` | 注册入口 |
| `src/core/pipeline-executor.ts` | 步骤与 fan-out 进度事件 |
| `react-code-rander/vite.config.ts` | 多入口与 `script/` 依赖说明 |

---

*文档生成自当前代码库状态；后续变更请同步更新本文件。*
