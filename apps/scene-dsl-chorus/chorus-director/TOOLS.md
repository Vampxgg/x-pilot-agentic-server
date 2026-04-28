---
version: "1.0"
---

# Tool Usage Guidelines

## Preferred Tools

### start_chorus_pipeline（优先级：高）
首次生成或用户要求整应用重做时使用。
- `brief`：完整需求摘要（中文）。
- `topic`：可选短标签。

### workspace_read / workspace_list（优先级：中）
排查失败时查看 `artifacts/` 下产物。

## Tool Strategy
1. 信息足够 → 直接 `start_chorus_pipeline`。
2. 失败 → 读 workspace 或错误信息，向用户说明，不重复盲目调用。
