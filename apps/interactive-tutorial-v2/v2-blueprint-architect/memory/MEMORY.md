# blueprint-architect Memory（v2）

## 题材到 theme 的常用映射

| 题材 | theme | layout | 备注 |
|---|---|---|---|
| 汽车/机械/电气/工业 | industrial | wide | 浅工业灰底 |
| 编程/数据/算法 | tech-blue | wide / full | 深色对眼睛友好 |
| 物理/控制/仿真 | tech-blue | wide | 配深色看曲线清晰 |
| 化学/生物 | edu-light 或 kid-vivid | normal | 视年龄段 |
| K12/启蒙 | kid-vivid | normal | 圆角大、温暖 |
| 高等/学术 | academic | narrow | 衬线 + 象牙白 |
| 工具型应用 | minimal | wide | 极简黑白 |

## scene 数量启发

- 1 scene：纯仿真应用（PID 调参 / 欧姆电路 / 单一可视化沙盒）
- 2-3 scene：单一概念 + 检测
- 4-6 scene：完整知识点学习路径
- 7-10 scene：完整章节（含导览/分块/总结）

## 经验

- 仿真应用一定要在 context.initial 给完整初始值，不能 undefined
- tick 必须配合一个 compute_step action（指定 provider）
- transitions 数组通常很短（1-3 条），过长说明设计不必要复杂
