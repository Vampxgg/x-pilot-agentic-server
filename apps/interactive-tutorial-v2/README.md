# interactive-tutorial-v2

**v2 DSL 应用智能体管线** — 与老 `apps/interactive-tutorial/`（TSX 生成体系）完全独立。

## 概览

```
用户对话 → /api/business/interactive-tutorial-v2/chat-stream
       → dsl-director（编排，agent name 由目录名推导）
       → pipeline：clarify → research → pedagogy → data-pack → visual → blueprint → save-skeleton → scenes(fan-out) → merge → validate → publish（`publish` 内可对校验失败循环调用 `v2-dsl-fixer`）
       → data/dsl-tutorials/{sessionId}/dsl.json
       → 浏览器：runtime.html?dslUrl=/api/business/interactive-tutorial-v2/sessions/{sid}/dsl
       → SceneRuntime 解释执行 DSL → 用户看到完整交互式应用
```

## 与 v1 完全隔离

| 资源 | v1 | v2 |
|---|---|---|
| Agent 目录 | `apps/interactive-tutorial/` | `apps/interactive-tutorial-v2/` |
| Director name | `interactive-tutorial-director` | `dsl-director` |
| Domain metadata | `interactive-tutorial` | `interactive-tutorial-v2` |
| Code 模块 | `apps/interactive-tutorial/code/` | `apps/interactive-tutorial-v2/code/` |
| API 路由前缀 | `/api/business/interactive-tutorial/*` | `/api/business/interactive-tutorial-v2/*` |
| Workspace 子目录 | `data/tutorials/` | `data/dsl-tutorials/` |
| 渲染端入口 | `react-code-rander/index.html` | `react-code-rander/runtime.html` |
| 渲染端 React 入口 | `src/main.tsx` | `src/runtime-entry.tsx` |
| 渲染端业务代码 | `src/sdk/` + `src/App.tsx` | `src/runtime/` + `src/runtime-kit/` |
| Director 私有工具 | `start_generation_pipeline` / `reassemble_app` | `start_dsl_pipeline` / `apply_dsl_patch` / `hot_reload_runtime` |
| 模板目录解析器 | `template-dir.ts` | `runtime-dir.ts` |

**v2 不导入 v1 的任何文件。** 仅共享 langgraph 框架代码（`src/core/*`），这些是与业务无关的工程基础设施。

## Agent 一览

| Agent name | 职责 | 输出形态 |
|---|---|---|
| `dsl-director` | 对话入口 + 编排 | 自然语言 + 工具调用 |
| `v2-intent-clarifier` | 意图结构化 | ClarifiedIntent JSON |
| `v2-content-researcher` | 知识素材研究 | ResearchPack JSON |
| `v2-pedagogy-planner` | 教纲与学习证据 | `artifacts/pedagogy-plan.json` |
| `v2-data-steward` | 结构化数据条目（带 useInScenes） | `artifacts/data-pack.json` |
| `v2-visual-designer` | shell + theme + layoutRationale | `artifacts/visual-system.json` |
| `v2-blueprint-architect` | DSL 骨架（无 ui 树；合并 visual） | DslSkeleton JSON |
| `v2-scene-author` | 单 scene 的 ui 树（fan-out） | SceneFragment JSON |
| `v2-dsl-fixer` | 校验失败时修复 | RFC 6902 patches |
| `v2-dsl-edit-planner` | 编辑指令翻译 | RFC 6902 patches |

## 跨体系桥梁（仅一处）

- `dsl-director` 通过通用 `subAgentTool` 跨域调起冻结的老 `tutorial-component-coder`，作为「自定义组件逃生口」实现者。
- 信息流单向：v2 → v1（消费），不存在 v1 → v2。

## 相关文档

- [DSL-SCHEMA.md](./DSL-SCHEMA.md) — DSL 语法 + 组件清单（LLM prompt 真理来源）
- [code/dsl/component-manifest.ts](./code/dsl/component-manifest.ts) — 32 个可被 DSL 引用的组件契约
- [code/dsl/schema.ts](./code/dsl/schema.ts) — Node 端 zod schema（与 react-code-rander/src/runtime/dsl/schema.ts 镜像）
- [code/dsl/validator.ts](./code/dsl/validator.ts) — 语义校验
- [dsl-director/agent.config.yaml](./dsl-director/agent.config.yaml) — pipeline 完整定义

## 运行

启动主 server 后，前端调用：

```http
POST /api/business/interactive-tutorial-v2/chat-stream
{
  "message": "为汽车专业大一学生做一个发动机原理交互应用，要求 industrial 风格，5-7 个 scene，含 3D 拆装与故障诊断。"
}
```

完成后 SSE 最后一条 `task_finished` 事件的 `outputs.runtimeUrl` 即可在浏览器打开。

## 测试沙盒（暂无）

后续会增加 `apps/interactive-tutorial-v2/test/` 目录与 e2e 测试脚本。
