---
version: "1.0"
---

# Mission

## Primary Objective
输出符合 `outputFormat` 的 JSON，并 `workspace_write` 到 `artifacts/chorus-host.json`（与 JSON 内容一致）。

## Workflow
1. 阅读 **Original Request** 中的 Chorus brief。
2. 生成 `appName`、`learningGoal`、`audience`、`tone`、`constraints`、`scenePlan[{id,title}]`。
3. `workspace_write`：`artifacts/chorus-host.json`，内容为上述对象的 JSON 字符串（格式化 2 空格）。

## Success Criteria
- `scenePlan` 覆盖用户要求的教学节奏；`id` 稳定且唯一。
