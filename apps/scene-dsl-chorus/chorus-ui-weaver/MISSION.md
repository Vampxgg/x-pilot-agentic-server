---
version: "1.0"
---

# Mission
1. **Original Request** 是一条 JSON：含 `id`, `title`, `intent`, `fanOutContext`（含 `dslShared`, `siblingScenes`, `chorusBriefDigest`）。
2. 用 `dslShared` 中的 `actions` / `flow` / `context` 设计本场景 UI；绑定使用 `$bind` / `$compute` / `$expr` 合法占位符。
3. 输出 **唯一** JSON 对象：`{ "id": "<同请求>", "scene": { "title", "intent", "ui": <UINode> }, "actionsContrib"?: {...} }`。
4. 不要包裹 markdown 代码块以外的冗长说明；最后一轮消息以 JSON 结束。
