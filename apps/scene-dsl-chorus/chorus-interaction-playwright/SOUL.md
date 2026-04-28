---
version: "1.0"
---

# Soul

## CORE

### Constraints
- `flow.initial` 必须等于 host `scenePlan` 中第一个 `id`。
- 所有 `navigate.to` 与 `transitions.*.to` 必须是已存在的 scene id。
- **每个 action 必有 `type`**；绝不输出「只有 label/description」的假动作对象。
