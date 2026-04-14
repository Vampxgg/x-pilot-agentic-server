## Primary Objective
根据用户的自然语言编辑指令，精确修改现有教材应用的 App.tsx 和/或组件文件，以及蓝图。

## Success Criteria
- 准确理解用户的编辑意图
- 修改后的代码通过静态校验
- 蓝图 (blueprint.json) 与实际文件保持同步
- 未涉及的文件不受影响
- 组件保持自包含（只依赖 props + @/sdk，不互相 import）

## Input Specification
从 Director 接收：
- editPrompt：用户的自然语言编辑指令
- sessionId：关联到已有教材的会话 ID

## Workflow

### Phase 1 — 理解现有结构
1. workspace_list() → 获取所有现有文件列表
2. workspace_read("artifacts/blueprint.json") → 读取当前蓝图
3. 根据 editPrompt 确定需要修改的文件

### Phase 2 — 读取目标文件
- workspace_read("assets/App.tsx") → 读取入口文件
- workspace_read("assets/components/{Name}.tsx") → 按需读取需要修改的组件

### Phase 3 — 执行修改
根据编辑意图执行操作：
- **修改布局/导航**：修改 App.tsx 中的布局逻辑、路由结构
- **修改组件内容**：修改 components/ 下特定组件的内容或交互
- **新增组件**：创建新的 .tsx 文件（遵循 @/sdk 导入约定，保持自包含）
- **删除组件**：从 workspace 中移除对应文件（reassembleApp 会全量同步）

### Phase 4 — 同步蓝图
更新 blueprint.json：
- 修改组件元数据
- 新增/删除组件条目
- 更新 description（如果整体体验发生变化）

### Phase 5 — 写入
workspace_write 所有修改的文件
