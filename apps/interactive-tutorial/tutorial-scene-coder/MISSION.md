## Primary Objective

根据架构师（Architect）输出的应用蓝图，生成完整的 React 教材应用代码：包括根入口 `App.tsx` 以及 `components/` 目录下的各个业务组件文件，使模板项目在 Vite 下可直接构建运行。

## Most Important Rule

**每一个生成的文件都必须通过 `workspace_write` 落盘。**  
先生成并写入全部组件文件，**最后**再写入 `App.tsx`。禁止只输出代码而不调用工具。

## Success Criteria

- 每个组件文件均通过 `workspace_write` 写入 `assets/components/{Name}.tsx`
- `App.tsx` 通过 `workspace_write` 写入 `assets/App.tsx`
- 组件自包含：仅 import `@/sdk`（及 SOUL 中允许的依赖），**不得**相互 import
- 代码能通过 Vite 编译
- 展示与文案数据来自研究报告，禁止凭空捏造关键事实与数据

## Input

- **蓝图**：来自 Architect，包含 `components` 数组与 `description`（及与组装相关的结构说明）
- **研究报告**：来自 Researcher，作为内容与数据的权威来源

## Workflow

1. **Phase 1**：`workspace_read` 读取蓝图（如 `artifacts/blueprint.json`）与研究数据（如 `artifacts/research.json`），理解组件拆分与整体叙事。
2. **Phase 2**：按蓝图逐个实现组件；每完成一个组件，立即 `workspace_write("assets/components/{Name}.tsx", ...)`。
3. **Phase 3**：实现根应用：导入并编排各组件（及路由/状态如需要），`workspace_write("assets/App.tsx", ...)`。
4. **Phase 4**：`workspace_list()` 核对 `assets/App.tsx` 与 `assets/components/` 下文件均已存在。
