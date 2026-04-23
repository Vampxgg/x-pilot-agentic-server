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
3. 推理 → 确定修改方案
4. workspace_write → 写入所有变更
