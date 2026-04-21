# `web_search` 工具使用文档

> 内置网页搜索工具，底层由 [Tavily](https://docs.tavily.com) 提供。
> 支持文本搜索、图片搜索、AI 摘要、网页正文抽取、域名过滤、时间过滤等能力。

- **文件位置**：`src/tools/built-in/web-search.ts`
- **工具名（LLM 调用名）**：`web_search`
- **测试脚本**：
  - `scripts/test-tavily-search.ts`（完整测试套件，17 个用例）
  - `scripts/test-web-search.ts`（基础冒烟测试）
  - `tests/tools/web-search.test.ts`

---

## 目录

- [1. 快速开始](#1-快速开始)
- [2. 配置（环境变量）](#2-配置环境变量)
- [3. 输入参数](#3-输入参数)
- [4. 输出结构](#4-输出结构)
- [5. 错误返回](#5-错误返回)
- [6. 使用场景示例](#6-使用场景示例)
- [7. 行为细节与限制](#7-行为细节与限制)
- [8. 测试](#8-测试)
- [9. 迁移说明（从 SearchApi.io → Tavily）](#9-迁移说明从-searchapiio--tavily)

---

## 1. 快速开始

### 在 Agent 框架内调用（LLM tool call）

```json
{
  "name": "web_search",
  "arguments": {
    "query": "LangChain Agent 最佳实践 2026",
    "num": 5,
    "extract_content": true
  }
}
```

### 在 TypeScript 代码中直接调用

```ts
import { webSearchTool } from "./src/tools/built-in/web-search.js";

const raw = await webSearchTool.invoke({
  query: "Vue3 组合式 API 教程",
  num: 5,
  extract_content: true,
});

const data = JSON.parse(raw as string);
console.log(data.ai_overview);
for (const r of data.organic_results) {
  console.log(`${r.title}\n  ${r.link}\n  ${r.snippet}\n`);
}
```

> 工具返回值始终是 **JSON 字符串**，调用方需自行 `JSON.parse()`。

---

## 2. 配置（环境变量）

| 变量 | 必填 | 说明 |
|------|------|------|
| `TAVILY_API_KEY` | 推荐 | Tavily API key，格式 `tvly-xxxxxxxx` |
| `SEARCH_API_KEY` | ❌ | 兼容旧配置：如果它的值也以 `tvly-` 开头则会被使用 |

**优先级**：`TAVILY_API_KEY` → `SEARCH_API_KEY`（仅当 `tvly-` 开头）→ 内置 fallback key。

代码中的 key 解析逻辑（`src/tools/built-in/web-search.ts`）：

```26:38:E:\Vampxgg\E2B\agentic-sever\x-pilot-agentic-server\src\tools\built-in\web-search.ts
const FALLBACK_TAVILY_KEY = "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";

function resolveTavilyKey(): string {
  // Pick the first env var that looks like a Tavily key (`tvly-...`).
  // SEARCH_API_KEY is consulted for back-compat in case the user reused it.
  const candidates = [process.env.TAVILY_API_KEY, process.env.SEARCH_API_KEY];
  for (const k of candidates) {
    if (typeof k === "string" && k.startsWith("tvly-")) return k;
  }
  return FALLBACK_TAVILY_KEY;
}
```

> 生产环境**强烈建议**显式设置 `TAVILY_API_KEY`，不要依赖代码 fallback。

`.env` 示例：

```bash
TAVILY_API_KEY=tvly-prod-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 3. 输入参数

完整 zod schema 定义在 `src/tools/built-in/web-search.ts` 末尾。

### 3.1 核心参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | string | ✅ | — | 搜索关键词，至少 1 个字符 |
| `num` | int (1-20) | ❌ | 5 | 返回结果数量（超过会被钳到 [1,20]） |
| `search_type` | `"text"` \| `"image"` | ❌ | `"text"` | 搜索模式 |
| `extract_content` | boolean | ❌ | false | 是否抓取每条结果的网页正文（markdown 格式） |
| `timeout` | number | ❌ | 30000 | 单次请求超时（毫秒） |

### 3.2 Tavily 高级参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `search_depth` | `"basic"` \| `"advanced"` | `"basic"` | `"advanced"` 更深更准但更慢 |
| `topic` | `"general"` \| `"news"` \| `"finance"` | `"general"` | 搜索主题域 |
| `time_period` | 见下表 | — | 时间范围过滤 |
| `gl` | string | — | 国家代码（映射到 Tavily `country`，如 `"us"`、`"cn"`） |
| `include_domains` | string[] | — | 仅返回这些域名的结果 |
| `exclude_domains` | string[] | — | 排除这些域名 |

**`time_period` 取值与映射**（Tavily 仅支持 day/week/month/year，更细粒度统一映射为 `day`）：

| 输入值 | 实际生效 |
|---|---|
| `last_year` | `year` |
| `last_month` | `month` |
| `last_week` | `week` |
| `last_day`, `last_hour`, `last_30_minutes`, `last_15_minutes`, `last_5_minutes`, `last_1_minute` | `day` |

### 3.3 已废弃但仍接受的参数（向后兼容）

| 参数 | 状态 | 说明 |
|---|---|---|
| `hl` | ⚠️ 忽略 | 旧 SearchApi.io 的语言参数，Tavily 不支持 |
| `image_size` | ⚠️ 忽略 | Tavily 图片搜索不支持尺寸过滤 |
| `image_color` | ⚠️ 忽略 | Tavily 图片搜索不支持颜色过滤 |
| `image_type` | ⚠️ 忽略 | Tavily 图片搜索不支持类型过滤 |
| `aspect_ratio` | ⚠️ 忽略 | Tavily 图片搜索不支持宽高比过滤 |

> 当传入这些图片过滤参数时会打印一条 `warn` 日志，方便排查迁移残留。

---

## 4. 输出结构

### 4.1 成功（文本搜索）

```json
{
  "query": "LangChain Agent 最佳实践 2026",
  "ai_overview": "LangChain Agent 的最佳实践包括...（Tavily 生成的简短回答）",
  "organic_results": [
    {
      "title": "Building Production-Ready LangChain Agents",
      "link": "https://blog.langchain.dev/...",
      "source": "blog.langchain.dev",
      "domain": "blog.langchain.dev",
      "snippet": "Tavily 给出的相关性摘要片段...",
      "date": "2026-03-12",
      "thumbnail": "",
      "images": [],
      "content": "（仅 extract_content=true 时填充）# 标题\n\n正文 markdown ...",
      "extracted_content": "（与 content 相同，向后兼容字段）",
      "score": 0.94
    }
  ],
  "response_time": 1.34
}
```

字段含义：

| 字段 | 类型 | 说明 |
|---|---|---|
| `query` | string | 实际执行的查询字符串 |
| `ai_overview` | string \| null | Tavily 生成的 AI 摘要回答（基础模式） |
| `organic_results` | array | 搜索结果列表 |
| `organic_results[].title` | string | 网页标题 |
| `organic_results[].link` | string | 网页 URL |
| `organic_results[].source` / `domain` | string | 网页所属域名（从 link 解析） |
| `organic_results[].snippet` | string | Tavily 给出的相关性片段 |
| `organic_results[].date` | string | 发布日期（若 Tavily 提供） |
| `organic_results[].content` | string | **仅** `extract_content=true` 时为完整 markdown 正文，否则为空串 |
| `organic_results[].extracted_content` | string | 与 `content` 内容相同（向后兼容旧调用方） |
| `organic_results[].score` | number | Tavily 给出的相关性分数 (0-1) |
| `response_time` | number | Tavily 服务端耗时（秒） |

### 4.2 成功（图片搜索）

`search_type: "image"` 时同样使用 `organic_results` 字段，但每条记录是图片：

```json
{
  "query": "red panda",
  "ai_overview": null,
  "organic_results": [
    {
      "title": "A red panda curled up on a mossy branch...",
      "link": "https://upload.wikimedia.org/.../Red_Panda.jpg",
      "source": "upload.wikimedia.org",
      "domain": "upload.wikimedia.org",
      "snippet": "A red panda curled up on a mossy branch...",
      "date": "",
      "thumbnail": "https://upload.wikimedia.org/.../Red_Panda.jpg",
      "images": ["https://upload.wikimedia.org/.../Red_Panda.jpg"],
      "content": "",
      "extracted_content": ""
    }
  ],
  "response_time": 7.36
}
```

> `link`、`thumbnail`、`images[0]` 三个字段是同一个图片 URL，`title` 和 `snippet` 都是 Tavily 生成的图片描述。这与 `image-fetch-service.ts` 的现有读取路径完全兼容。

### 4.3 输出大小限制

返回的 JSON 字符串总长度上限为 **50,000 字符**。超过时按以下规则**结构化裁剪**（始终保证仍是合法 JSON）：

1. 把每条结果的 `content`/`extracted_content` 截断到 2000 字符并追加 `…[truncated]`，整体加 `truncated: true` 标记；
2. 仍然超长时，把所有 `content`/`extracted_content` 清空。

---

## 5. 错误返回

错误时返回的 JSON 包含 `error` 字段，调用方应**优先检查**：

| 场景 | 返回示例 |
|---|---|
| API key 缺失/格式错误 | `{ "error": "Tavily API key is missing or invalid. Set TAVILY_API_KEY in the environment." }` |
| Tavily 接口非 200 | `{ "status": 401, "error": "Invalid API key" }` |
| 超时（`timeout` 触发 abort） | `{ "error": "This operation was aborted" }` |
| 非 JSON 响应（极少见） | `{ "error": "Unexpected response format from Tavily: ..." }` |
| 其他未知异常 | `{ "error": "<exception.message>" }` |

推荐处理范式：

```ts
const data = JSON.parse(raw as string);
if (data.error) {
  logger.warn(`web_search failed: ${data.error}`);
  return [];
}
// 正常处理 data.organic_results
```

---

## 6. 使用场景示例

### 6.1 简单事实查询（不抓正文）

```json
{
  "name": "web_search",
  "arguments": {
    "query": "Bun 1.2 release date",
    "num": 3
  }
}
```

适用：只看 `snippet` + `ai_overview` 即可作答的场景。**速度最快**（≤2s）。

### 6.2 深度研究（抓取正文）

```json
{
  "name": "web_search",
  "arguments": {
    "query": "LangGraph 最佳实践",
    "num": 5,
    "extract_content": true,
    "search_depth": "advanced"
  }
}
```

适用：教程整理、技术调研、需要原文级引用。耗时 5-15s。

### 6.3 限定域名（如官方文档）

```json
{
  "name": "web_search",
  "arguments": {
    "query": "useState behavior across re-renders",
    "num": 5,
    "include_domains": ["react.dev", "developer.mozilla.org"]
  }
}
```

### 6.4 排除某些域名

```json
{
  "name": "web_search",
  "arguments": {
    "query": "javascript closure tutorial",
    "num": 10,
    "exclude_domains": ["w3schools.com"]
  }
}
```

### 6.5 时间过滤的新闻

```json
{
  "name": "web_search",
  "arguments": {
    "query": "AI regulation EU",
    "num": 5,
    "topic": "news",
    "time_period": "last_week"
  }
}
```

### 6.6 图片搜索

```json
{
  "name": "web_search",
  "arguments": {
    "query": "golden retriever puppy",
    "search_type": "image",
    "num": 6
  }
}
```

> Tavily 不支持尺寸/颜色/类型/比例过滤；如有需要请在拿到 URL 后再做后处理。

### 6.7 在代码中并发调用

```ts
const queries = ["Bun runtime", "Deno runtime", "Node.js runtime"];
const results = await Promise.all(
  queries.map((q) =>
    webSearchTool.invoke({ query: q, num: 3 }).then((s) => JSON.parse(s as string)),
  ),
);
```

工具内部使用 `PQueue({ concurrency: 3 })` 限制并发，超出会自动排队，无需调用方关心。

---

## 7. 行为细节与限制

### 7.1 并发控制
- 全局 `PQueue` 并发上限 **3**，避免触发 Tavily 速率限制。
- 5 个并发请求实测约 4 秒完成（见 `scripts/test-tavily-search.ts` 的 `[concurrent]` 用例）。

### 7.2 超时
- 默认 30s，使用 `AbortController` 实现，**不会**抛异常打断进程，会被捕获并返回 `{ error: "..." }`。

### 7.3 `num` 边界
- 通过 zod 限制到 [1, 20]，超出范围的传值会被框架在调用前拒绝。

### 7.4 `query` 校验
- 空字符串会被 zod schema 拒绝（不会发出网络请求）。

### 7.5 `ai_overview` 触发条件
- 仅文本搜索（`search_type !== "image"`）时启用 `include_answer: "basic"`；
- Tavily 对部分查询不返回 answer，此时字段为 `null`。

### 7.6 `extract_content` 性能
- 启用后 Tavily 会把每个结果页的 markdown 一并返回，单次请求耗时通常增长 2-5 倍；
- 如果只是判断结果是否相关，建议保持 `false`。

### 7.7 域名过滤的相关性
- `include_domains` 会大幅缩小召回集；如果该域名对该 query 没有内容，可能返回 0 条。建议查询词避免过窄。

---

## 8. 测试

### 8.1 跑完整测试套件

```bash
npx tsx scripts/test-tavily-search.ts
```

预期输出：

```
Summary  17 passed  0 failed  (~12s total)
```

### 8.2 只跑特定分组

```bash
# 只跑 text 和 image 两组
npx tsx scripts/test-tavily-search.ts --only=text,image

# 详细模式（打印请求/响应 JSON）
npx tsx scripts/test-tavily-search.ts --verbose
```

可用分组：`text`、`extract`、`image`、`advanced`、`concurrent`、`errors`。

### 8.3 基础冒烟测试

```bash
npx tsx scripts/test-web-search.ts
```

---

## 9. 迁移说明（从 SearchApi.io → Tavily）

本工具是一次**接口兼容的底层替换**，绝大多数下游调用无需改动。

### 9.1 兼容保留
| 项 | 状态 |
|---|---|
| 工具名 `web_search` | ✅ 保留 |
| 输入字段 `query / num / search_type / extract_content / timeout / time_period / gl / hl` | ✅ 保留 |
| 输入字段 `image_size / image_color / image_type / aspect_ratio` | ⚠️ 接受但忽略（打 warn 日志） |
| 输出字段 `query / ai_overview / organic_results[].{title,link,source,domain,snippet,date,thumbnail,images,content,extracted_content}` | ✅ 保留 |
| 错误返回结构（`{ error }` / `{ status, error }`） | ✅ 保留 |
| `image-fetch-service.ts` 通过 `r.link` / `r.thumbnail` 读取的图片字段 | ✅ 保留 |

### 9.2 行为差异
| 场景 | 旧（SearchApi.io / Google） | 新（Tavily） |
|---|---|---|
| 默认结果数 | 10 | 5（避免输出过大） |
| `time_period` 粒度 | 支持小时/分钟级 | 仅 day/week/month/year（自动降级） |
| `extract_content` 的实现 | 工具自行 fetch + Readability 抽取 | Tavily 直接返回 `raw_content`（更快、更稳） |
| 图片过滤 | Google Images 支持 size/color/type/aspect | Tavily 不支持，参数被忽略 |
| `ai_overview` | Google 的 AI Overview（仅部分 query 有） | Tavily `answer` 字段（覆盖率更高） |
| 输出截断方式 | 直接 `.slice(0, 50000)`（可能切坏 JSON） | **结构化裁剪** `content` 字段，永远是合法 JSON |
| 环境变量 | `SEARCH_API_KEY` | `TAVILY_API_KEY`（兼容 `SEARCH_API_KEY` 若为 tvly-* 格式） |

### 9.3 升级清单
1. 在 `.env` 把 `SEARCH_API_KEY=...` 改/加为 `TAVILY_API_KEY=tvly-...`。
2. 检查 Researcher 类 Agent 的 prompt 中是否提到 "Google" / "SearchApi"，可换为 "Tavily" 或保留通用描述 "网页搜索"。
3. 如果代码里有读取 `position` 字段，请替换为 `score` 字段（Tavily 没有 position，提供了相关性分数）。
4. 如果代码里依赖 `knowledge_graph` / `inline_images` / `related_questions` 等 Google 特有字段，需要改用 `ai_overview` + `organic_results` 组合表达。

---

## 附：相关文件

- 实现：`src/tools/built-in/web-search.ts`
- 注册：`src/core/agent-registry.ts`（搜索 `web_search`）
- 调用方：`src/services/image-fetch-service.ts`、`apps/interactive-tutorial/tutorial-content-researcher/`
- 配置：`.env.example`
- 测试：`scripts/test-tavily-search.ts`、`scripts/test-web-search.ts`、`tests/tools/web-search.test.ts`
- 总览索引：`docs/tools/tools_api.md` §2.2
- Tavily 官方文档：<https://docs.tavily.com/documentation/api-reference/endpoint/search>
