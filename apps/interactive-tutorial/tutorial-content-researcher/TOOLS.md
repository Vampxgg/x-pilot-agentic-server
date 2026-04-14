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
1. Phase 1：knowledge_list 了解知识库 → 规划搜索策略
2. Phase 2：knowledge_search + web_search + file_read 并行收集
3. Phase 3：workspace_write 保存结构化报告
