# scene-dsl-chorus（Chorus）

与 `interactive-tutorial-v2` **目录隔离** 的 DSL 生成应用：多角色并行规划 → 融合 → 单场景 fan-out 织 UI → 合并校验 → 发布到 `data/dsl-chorus/{sessionId}/dsl.json`。

## API

- `POST /api/business/scene-dsl-chorus/chat-stream` — 对话，`chorus-director` 可调 `start_chorus_pipeline`
- `GET /api/business/scene-dsl-chorus/sessions/:sessionId/dsl` — 取 `dsl.json`
- `GET /api/business/scene-dsl-chorus/sessions/:sessionId/play` — 302 到同源 `/runtime/runtime.html?dslUrl=...`

## 预览

`react-code-rander` 需先 `npm run build`。**Chorus 不在本应用内注册 `/runtime/`**，避免与 `interactive-tutorial-v2` 的 `@fastify/static` 在 `listen` 阶段重复声明 `HEAD/GET` 而进程崩溃。请保证 **`interactive-tutorial-v2` 已加载**（其 `routes` 会挂载 `/runtime/`），或在 `server.ts` 里为 `dist` **只注册一次**静态服务；再用 `play` 短链或 `runtimeUrl` 打开预览。

## Schema 同步

`code/chorus/schema.ts` 与 `code/chorus/component-manifest.ts` 须与 `react-code-rander/src/runtime/dsl/schema.ts` 及 RuntimeKit 组件保持 **手动对齐**（本应用禁止 import v2 `code/dsl`）。

## 管线 Brief 里的「Action 范例」

`start_chorus_pipeline` 会在 initialInput 中注入 `buildChorusActionCookbook()`（见 `code/chorus/prompt-pack.ts`），用可复制 JSON 约束 `actions`/`transitions`，减少 `invalid_union` 类失败。发布失败时 `chorusPublishDsl` 会对每条 schema 错误附带中文修法提示。

## 代码入口

- `code/index.ts` → `register()`：pipeline handlers + `start_chorus_pipeline` + 路由
