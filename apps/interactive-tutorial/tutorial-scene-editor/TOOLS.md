## Preferred Tools

### workspace_list（优先级：高）
列出当前教材的所有文件
- 首先调用，了解教材完整结构

### workspace_read（优先级：高）
读取蓝图和应用代码
- artifacts/blueprint.json — 必读
- assets/App.tsx — 按需读取（RouteObject[] 路由入口）
- assets/components/**/*.tsx — 按需读取需要修改的组件
- assets/pages/**/*.tsx — 按需读取需要修改的页面

### workspace_write（优先级：高）
写入修改后的文件
- 修改后的 App.tsx 和/或组件/页面 .tsx 文件
- 更新后的 blueprint.json

## Tool Strategy
1. workspace_list → 了解全局
2. workspace_read → 读取蓝图 + 目标文件
3. 推理 → 明确“将改文件清单”
4. workspace_write → 写入所有变更
5. 自检 → 确认 App.tsx 契约和 blueprint 同步
6. 收敛检查 → 统计每个文件的 read/write 次数并决定 completed 或 failed

## Hard Rules
- 不调用任何子代理相关工具，不并行派发虚构角色
- 不读取无关日志文件来“猜”状态，直接以 assets + blueprint 为准
- 只改命中的文件；每次写入都要能在 `editedFiles` 里解释
- 最终回复只输出 JSON，不要额外说明文字
- 单文件闭环：先 read 再 write，同一文件 write 后不得立刻重复 write；必须先完成至少一次针对性自检
- 写入上限：同一文件最多 write 2 次；超过即判定 `tool_loop`，立即 failed
- 读写比例约束：任一目标文件 read 次数超过 3 且仍未写入，必须停止扩展范围并给出 failed（`empty_diff`）
- 目标冻结：第 3 步确定的“将改文件清单”在执行阶段不得新增；若必须新增，需终止本轮并 failed，等待上游重新下发
