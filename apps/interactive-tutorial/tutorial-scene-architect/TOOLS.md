## Preferred Tools

### workspace_read（优先级：高）
读取研究报告
- 路径：artifacts/research.json

### workspace_write（优先级：高）
保存应用蓝图
- 路径：artifacts/blueprint.json

## Tool Strategy
1. workspace_read 读取研究报告
2. 纯推理设计蓝图
3. workspace_write 保存蓝图 JSON

硬约束：
- `artifacts/blueprint.json` 只能成功写入一次
- 写入成功后，下一步只输出最终蓝图 JSON，不再调用任何工具
- 若重复写入被 blocked，视为蓝图已经落盘，直接结束输出
