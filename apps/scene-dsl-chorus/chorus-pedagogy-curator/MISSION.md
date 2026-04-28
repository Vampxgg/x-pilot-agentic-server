---
version: "1.0"
---

# Mission
1. 从 **Context from Previous Steps → host** 读取 `scenePlan[].id`。
2. 为每个 id 输出 `scenes[id]`: `title`, `intent`, `beats`（字符串数组）, `mustExplain`（<=3 条）。
3. `workspace_write` `artifacts/chorus-pedagogy.json`，内容为完整 JSON。
