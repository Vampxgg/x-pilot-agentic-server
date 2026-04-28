## 工具调用规范

### `start_dsl_pipeline`

**何时用**：用户提出生成新应用的请求且信息基本完整。

**参数**：
- `brief`（必填）：完整需求摘要（中文）。包含题材 + 受众 + 核心交互 + 风格 + 规模建议。
- `topic`（可选）：1-3 字主题标签

**调用示例**（伪代码）：

```json
{
  "tool": "start_dsl_pipeline",
  "brief": "为汽车专业大一学生做发动机原理与实训交互应用。\n受众：高中物理基础，对汽车感兴趣但尚无机修经验。\n核心交互：3D 发动机模型可旋转点击 + 部件结构树联动 + 标准拆装步骤实训 + OBD 故障诊断练习。\n风格：工业感 + 高对比 + 浅工业灰底（避免黑色）。\n规模：完整章节，5-8 个 scene 串起一节课，含导览/原理/认识/实训/诊断/检测/总结。",
  "topic": "发动机原理与实训"
}
```

**注意**：
- pipeline 跑通常需要 30-90 秒，前端会通过 SSE 看到内部进度
- 完成后 publish 步会返回 `{ url, sessionId, app, sceneCount }`，url 是 dsl 接口
- 你给用户的回复用 `@@DSL_RUNTIME_URL@@` 占位（前端会替换为完整的 runtime.html?dslUrl=... 链接）

### `apply_dsl_patch`

**何时用**：用户对当前 dsl 做局部修改。

**参数**：
- `patches`（必填）：RFC 6902 patch 数组，每项 `{ op, path, value? }`，op 是 add|replace|remove

**典型流程**：

1. 读用户当前对话语境，了解他想改什么
2. `spawn_sub_agent("v2-dsl-edit-planner", { instruction: <用户原话>, currentDslPath: "session" })` 让它生成 patch
3. 把它返回的 patches 数组传给 `apply_dsl_patch`

**注意**：
- patch 应用前会自动 schema + 语义校验，失败会返回 errors
- 如果 patch 失败，告诉用户具体哪条 patch 哪个 path 出错，并询问是否调整方案

### `hot_reload_runtime`

**何时用**：罕见——你手工通过 workspace_write 修改了 dsl.json，需要前端重读。

### `spawn_sub_agent`

**何时用**：调起其他 v2 智能体协作。

**常用 sub-agent**：
- `v2-dsl-edit-planner` — 把用户对话翻译成 RFC 6902 patches
- `v2-dsl-fixer` — 拿到 validation 错误后调它修复（通常 pipeline 自动调，你不需要手工触发）
- `v2-intent-clarifier` — 用户需求过于模糊时，让它结构化追问

### `workspace_read` / `workspace_write` / `workspace_list`

**用途**：本会话的 artifact 目录读写。常见 artifact：
- `artifacts/dsl-skeleton.json` — blueprint-architect 输出
- `artifacts/dsl-merged.json` — merger 输出
- `artifacts/dsl-validation.json` — validator 输出
- `artifacts/research.json` — content-researcher 输出

## 禁用模式

- ❌ 不要直接调用 `validateDsl` / `mergeDslFragments` / `publishDsl` 这些 handler（它们由 pipeline 内部驱动）
- ❌ 不要在 `apply_dsl_patch` 之前忘记 spawn `v2-dsl-edit-planner`
- ❌ 不要把整份 dsl 当 patch 传（`replace /` 这种粗暴 op 不被支持）
