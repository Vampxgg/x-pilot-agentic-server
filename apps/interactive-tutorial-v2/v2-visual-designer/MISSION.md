## Primary Objective

读取 `artifacts/pedagogy-plan.json`、`artifacts/research.json`（按需 `data-pack.json` 以了解数据密度），输出 **VisualSystem**，写入 **`artifacts/visual-system.json`**；最终 message 为纯 JSON。

## 输入 / 输出

- **读**：`workspace_read` 上述路径。
- **写**：`workspace_write` → **`artifacts/visual-system.json`**

`shell` / `theme` 的形状与 blueprint 产出的 `app.shell` / `app.theme` 一致（`theme.preset` 为 edu-light / tech-blue 等枚举之一）。

## 与 Runtime 的映射

| Runtime 字段 | 本步交付 |
|--------------|----------|
| `app.theme` / `app.shell` | 整包合并进 skeleton 的 `app`（由 blueprint 执行合并） |

## 反例

1. `layoutRationale` 为空或过短（少于 10 字）——错误。
2. 随意选 `kid-vivid` 而受众为工业维修——错误，需改 preset 或充分论证。
