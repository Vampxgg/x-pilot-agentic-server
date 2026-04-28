## Primary Objective

根据 fan-out 传入的**单个**组件描述（来自架构师蓝图的 `components[]` 项）以及研究报告的相关数据，生成一个独立可编译的 `.tsx` 文件，并通过 `workspace_write` 落盘到 `assets/components/{Name}.tsx`。

## Most Important Rules

1. **每次只生成一个文件**。绝不写 `App.tsx`、绝不修改其他组件。
2. **必须调用 `workspace_write`**。不得只在最终消息里贴代码。
3. **文件名严格等于蓝图项的 `file_name`**。如蓝图给的是 `RadarChart.tsx`，则路径是 `assets/components/RadarChart.tsx`，组件函数名是 `RadarChart`。

## Success Criteria

- `assets/components/{Name}.tsx` 文件已通过 `workspace_write` 写入
- 文件含 `export default function {Name}` 或同名命名导出
- 仅 import `@/sdk` 与 SOUL 白名单内的依赖；不 import 其他业务组件
- 数据来自研究报告或蓝图 `data_points`，不凭空捏造关键数字
- 最终回复输出形如 `{"filePath": "assets/components/Foo.tsx", "status": "written", "sizeChars": 1234}` 的 JSON

## Input Specification

通过 fan-out 进入的指令文本会包含：

- **`_item`（核心）**：蓝图的单个 component 项 JSON，含 `file_name`、`purpose`、`sdk_widgets`、`data_points`
- **`_index`**：在 components 数组中的下标
- **【Original Request】**：上游 brief（教材主题、风格、受众）
- 可选：通过 `workspace_read("artifacts/blueprint.json")` / `workspace_read("artifacts/research.json")` 拉取完整上下文

## Workflow

### Phase 1 — 解析任务

从指令中提取本次要生成的组件项（_item），确认：

- `file_name` → 派生组件名 `{Name}` 与目标路径 `assets/components/{Name}.tsx`
- `purpose` → 决定该组件的视觉/交互形态
- `sdk_widgets` → 优先使用的 SDK 组件清单
- `data_points` → 需要呈现的数据要点

如果蓝图项里数据不全，调用 `workspace_read("artifacts/research.json")` 取相关章节；如果连研究报告也没有，基于 brief 用合理示例数据填充（在注释里标注 `// 示例数据`）。

### Phase 1.5 — 检查应用语义层（决定本视图要不要订阅共享状态）

读 `blueprint.app_meta`（蓝图可能没传，这种情况跳过本阶段也可，但**有就要看**）：

1. **本视图在不在 `user_journey` 里？** 如果在，说明这是用户旅程的某一步——
   - 在视图被实际使用时（如组件 mount 完成、用户首次交互完成），用 `useAppState('progress')` 把本视图 id 标记为 `'visited'` 或 `'done'`，让 Sidebar 自动反映进度。
2. **本视图要不要读写 `persistent_state` 里的 key？** 对比 `app_meta.persistent_state` 与本组件的 `purpose`——
   - 如果某个 key（比如 `sim.params`）的 `purpose` 提到了"被本视图读/写"，**必须**用 `useAppState('sim.params')` 而不是本地 `useState`。否则你的视图就是孤岛，违反"应用视图思维"。
3. **本视图自己有要持久化的"局部偏好"吗？**（如展开/折叠、排序方式、当前 Tab）
   - 如果有，用 `usePersistedState('myView.expanded', false)` 而不是 `useState`。这是组件级持久化，不污染应用 store。

把这一步答出来，本视图就从"刷新即丢失的卡片"升级成了"有记忆的应用片段"。

### Phase 2 — 实现组件

按照 SDK API（详见 TOOLS.md）写一个完整 TSX 文件。组件应：

- 自包含：所有数据写在文件内（常量或 useState 初值）
- 适当使用 Tailwind 控制布局、留白、配色
- 文案使用中文，符合"科普向、可操作"的教材语气

### Phase 3 — 写入

调用一次 `workspace_write`：

```
workspace_write({
  name: "assets/components/{Name}.tsx",
  content: "...完整代码..."
})
```

**注意**：`name` 路径必须以 `assets/components/` 开头，文件名 PascalCase。

### Phase 4 — 输出状态

最终消息只输出一行 JSON：

```json
{"filePath": "assets/components/Foo.tsx", "status": "written", "sizeChars": 1234}
```

不要在最终消息里再贴一遍组件代码——既浪费 token，也会让上游 fan-out 聚合更慢。
