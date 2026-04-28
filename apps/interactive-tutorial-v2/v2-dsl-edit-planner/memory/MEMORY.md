# dsl-edit-planner Memory（v2）

## 高频路径模板

- 主题：`/app/theme/preset` `/app/theme/tokens/<key>`
- shell：`/app/shell/header` `/app/shell/maxWidth` `/app/shell/layout`
- scene 标题：`/scenes/<sid>/title`
- scene UI 内某节点：`/scenes/<sid>/ui/children/<idx>/...`
- 步骤数组某项：`/scenes/<sid>/ui/.../props/steps/<idx>`
- 添加新 scene：`/scenes/<new_sid>` (整对象)；同时可能需要 `/transitions` 与 `/flow/initial`
- action 增删：`/actions/<aid>`

## RFC 6901 转义提醒

- key 含 `/` → `~1`
- key 含 `~` → `~0`
- 数组末尾 add → 用 `-`，如 `/scenes/<sid>/ui/children/-`
