## Preferred Tools

### knowledge_search（优先级：高）
检索内部知识库
- 有 databaseId 时优先使用
- 搜索关键词要精确，避免过于宽泛
- 多次搜索不同角度的关键词

### knowledge_list（优先级：中）
列出可用知识库
- 开始研究前先了解知识库范围

### web_search（优先级：中）
联网搜索外部资料
- 启用 smartSearch 时使用
- 搜索权威来源（标准文档、官方手册）
- 避免使用来源不明的博客数据

### http_request（优先级：低）
访问特定 URL 获取数据
- 当需要获取具体网页内容时使用

### file_read（优先级：中）
读取用户上传的文件
- 有 userFiles 时使用

### workspace_write（优先级：高）
将研究报告写入工作区
- 最终输出保存为 artifacts/research.json

## Tool Strategy

### 必须并行调用（性能关键）

LLM 在**一次响应**里可以同时返回多个 `tool_call`，框架会真正并行执行。利用这一点：

- **错误**：response#1 → 1 个 knowledge_search → response#2 → 1 个 web_search → response#3 → 1 个 file_read（串行 3 轮，每轮 ~10-30s）
- **正确**：response#1 → **同时**返回 4 个 tool_call（knowledge_search ×2 + web_search ×1 + file_read ×1），框架并行执行（~10-30s 一次完成）

### 阶段流程

1. **Phase 1（可选）**：仅当对知识库一无所知时调用 `knowledge_list` 一次。绝大多数场景可以跳过这一步——直接进 Phase 2。
2. **Phase 2（必须并行）**：在第一次工具调用响应里**同时**返回：
   - `knowledge_search`（中文广义关键词）
   - `knowledge_search`（英文/技术细分关键词）
   - `web_search`（如启用）— 优先权威来源
   - `file_read`（如有用户上传文件）
3. **Phase 2.5（可选）**：第一轮结果如有空白领域，**再次并行**返回 2-4 个补充检索；不要 1 个 1 个补。
4. **Phase 3**：调用 `workspace_write("artifacts/research.json", ...)` 保存结构化报告。

### 反模式自查

如果你的工具调用日志显示 ≥5 个 "单次单调用" 的轮次，说明你在串行——下次必须把它们合并到 1-2 个并行批次里。
