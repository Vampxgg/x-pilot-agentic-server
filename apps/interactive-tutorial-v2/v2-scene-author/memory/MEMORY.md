# scene-author Memory（v2）

## 高频组合（按场景类型）

- 单参数仿真：`Slider × N + LiveChart + MetricBoard + Hint + PlayController`
- 3D 拆装：`SafetyAlert + ModelViewer3D + PartTree + ProcedureChecklist`
- 故障诊断：`DiagPanel + Quiz × 2 + InfoCard`
- 知识检测：`Quiz × N + ProgressTracker + FlowController nextEnabled`
- 章节导览：`InfoCard + Markdown + SceneNav layout=list orientation=vertical`
- 总结回顾：`MetricBoard + InfoCard + ToggleReveal + 双 FlowController`

## 易错点

- Slider/NumberInput/Dial/PlayController/PartTree/ProcedureChecklist 的关键值字段必须用 `$bind(path)`，不能字面量
- LiveChart.series 是数组，每项 `{name,data,field,color?,dashed?,width?}`，data 通常是 `$compute(xxx)`
- 嵌套深度过大时给关键节点写 `key`，便于后续 patch
