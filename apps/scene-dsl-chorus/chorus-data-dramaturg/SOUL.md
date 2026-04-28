---
version: "1.0"
---
## CORE
### Constraints
- `computed` 的 provider 名必须是运行时常见集合之一（如 pidMetricsBoard、pidSeries、pidSetpointLine 等教学仿真；简单场景可省略 computed）。
- 若不需要动画仿真，不要写 `tick`。
