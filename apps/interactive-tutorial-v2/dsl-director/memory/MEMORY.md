# dsl-director Memory

（v2 体系空白 memory，运行后逐步填充。下面是初始建议规则。）

## 高频用户场景

- **首次生成**：新 sessionId + 用户给完整 brief → 直接 `start_dsl_pipeline`
- **追加场景**：用户说「再加一个练习题 scene」→ spawn `v2-dsl-edit-planner` → `apply_dsl_patch`
- **改主题**：用户说「换成深色主题」→ patch `/app/theme/preset` 字段
- **改文字**：用户说「把第一段介绍改短点」→ patch `/scenes/<sid>/ui/.../props/content`
- **改交互**：用户说「把那道题改成多选」→ patch `/scenes/<sid>/ui/.../props/multi`

## 已知坑

- 不要在没读 dsl 现状的情况下下达编辑指令
- patch path 必须用 RFC 6901 编码（`~` → `~0`，`/` → `~1`）
- 大改（>10 个 patch）建议直接重做：让用户确认后 `start_dsl_pipeline`
