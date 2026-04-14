# 故障排查指南

根据 `logs/combined.log` 和 `logs/error.log` 的常见问题及处理方式。

---

## 1. 401 User not found（LLM 调用失败）

**现象**：
```
Teaching resource generation failed: Error: 401 User not found.
Troubleshooting URL: https://js.langchain.com/docs/troubleshooting/errors/MODEL_AUTHENTICATION/
```

**原因**：OpenRouter 或 OpenAI API 认证失败。模型如 `gpt-4o` 等调用失败。

**处理步骤**：

1. 打开 https://openrouter.ai/settings/keys
2. 确认账号有效，余额充足
3. 新建或复制有效的 API Key
4. 在 `.env` 中更新：
   ```
   OPENAI_API_KEY=sk-...
   ```
5. 重启服务

---

## 2. Dify API 超时（知识检索失败）

**现象**：
```
Dify API POST /datasets/xxx/retrieve timed out — retrying (1/2)
Dify API POST /datasets/xxx/retrieve timed out — retrying (2/2)
```

**原因**：
- Dify 服务 `DIFY_API_BASE_URL` 不可达或响应慢
- 未指定 `database_id` 时，会对**全部数据集**并发检索，请求过多导致超时

**处理步骤**：

1. **延长超时时间**：在 `.env` 中添加或修改
   ```
   KNOWLEDGE_TIMEOUT=90000
   ```
   （默认 45000ms，可改为 60000～120000）

2. **指定知识库**：在请求中传入 `database_id`，限制检索范围，例如：
   ```json
   {
     "database_id": "目标知识库ID",
     "select_knowledge_unit": "...",
     "docTemplate": "..."
   }
   ```

3. **检查 Dify 连通性**：在服务器所在环境测试
   ```bash
   curl -I "http://119.45.167.133:5125/v1/datasets"
   -H "Authorization: Bearer YOUR_DIFY_DATASET_API_KEY"
   ```

---

## 3. 日志重复（启动信息多次出现）

**现象**：`Config loaded`、`Tool registered`、`Agent registered` 等在日志中重复多次。

**可能原因**：
- 使用 `npm run dev` 时，文件变更触发了多次重启
- 多次手动启动服务

**处理**：属正常情况，不影响运行。生产环境建议使用 `npm start` 单进程运行。

---

## 4. EADDRINUSE（端口占用）

**现象**：
```
Server failed to start: Error: listen EADDRINUSE: address already in use 0.0.0.0:3000
```

**处理**：

1. 结束占用 3000 端口的进程：
   ```powershell
   netstat -ano | findstr :3000
   taskkill /PID <进程ID> /F
   ```
2. 或修改 `.env` 中的 `PORT=3001` 等改用其他端口

---

## 5. 流式请求 Connection was reset

**现象**：
```
curl: (56) Recv failure: Connection was reset
```

**原因**：
- 流式接口（`generate-stream`）执行时间很长（如大量图片生成），连接被客户端或代理超时断开
- 智能体任务耗时过长（知识检索、图片生成等）

**处理步骤**：

1. **改用同步接口**：若不需要实时看流，使用 `POST /api/business/document-generation/generate`，等待完整响应
2. **减少图片生成**：在 prompt 中避免要求「图片 N 张以上」等超额要求；系统按骨架标注的 image 位置按需生成
3. **增加 SSE 超时**：服务端默认 10 分钟。可在 `.env` 中配置 `SSE_KEEPALIVE_TIMEOUT_MS=600000`（毫秒）
4. **客户端超时**：curl 等客户端或反向代理可能断开；检查代理超时设置
5. **检查服务端**：确认服务未因内存或长时间运行而异常退出，查看 `logs/error.log`

---

## 环境变量速查

| 变量 | 用途 | 示例 |
|------|------|------|
| OPENROUTER_API_KEY | OpenRouter 调用 | sk-or-v1-xxx |
| DIFY_API_BASE_URL | Dify 知识库地址 | http://119.45.167.133:5125/v1 |
| DIFY_DATASET_API_KEY | Dify 数据集 API Key | dataset-xxx |
| KNOWLEDGE_TIMEOUT | 知识检索超时(ms) | 90000 |
| SSE_KEEPALIVE_TIMEOUT_MS | SSE 流式连接保持时间(ms)，默认 10 分钟 | 600000 |
