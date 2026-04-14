---
name: SSE事件流协议重构
overview: 重构底层事件流体系，建立统一、规范、可预测的 SSE 事件协议，解决当前格式不统一、生命周期标记缺失、子智能体/工具事件不可追踪等严重问题。
todos:
  - id: discuss-protocol
    content: 与用户讨论确认事件协议设计 (事件类型、数据结构、子智能体策略、EventBus 合并策略)
    status: completed
  - id: define-types
    content: 在 src/core/types.ts 中定义统一的 StreamEvent 类型体系，替换 AgentStreamEvent 和 AgentEvent
    status: in_progress
  - id: create-stream-protocol
    content: 新建 src/core/stream-protocol.ts -- 事件工厂函数 + 事件枚举
    status: pending
  - id: create-sse-writer
    content: 新建 src/core/sse-writer.ts -- 统一 SSE 写入器 (格式 + 心跳 + 断线检测)
    status: pending
  - id: refactor-agent-runtime
    content: 重构 agent-runtime.ts streamAgent 方法，yield 新事件类型 (lifecycle + node + message + tool + sub-agent)
    status: pending
  - id: refactor-agent-graph
    content: 重构 agent-graph.ts act 节点，为每个工具调用添加 started/finished 事件
    status: pending
  - id: refactor-sub-agent
    content: 重构 sub-agent-manager.ts，改用 streamAgent 支持子智能体事件转发
    status: pending
  - id: unify-event-bus
    content: 重构 event-bus.ts 统一使用 StreamEvent 类型，合并 progress 事件到主流
    status: pending
  - id: adapt-routes
    content: 适配 agent.routes.ts 和业务路由，使用统一 SSEWriter
    status: pending
  - id: update-docs
    content: 更新 docs/api.md 和 README 中的事件流文档
    status: pending
isProject: false
---

# SSE 事件流协议重构方案 (v2 修订版)

## 一、当前问题诊断 (保持不变，见前文)

---

## 二、设计原则

1. **基座能力优先** -- 协议是 `src/core/` 的一部分，业务路由零样板代码即可接入
2. **统一信封** -- SSE / WebSocket / EventBus 共用同一事件结构
3. **可预测生命周期** -- 每个层级有明确 start/end，客户端永远知道当前状态
4. **ID 可追溯** -- 每个事件、每个工具调用、每个子智能体都有自己的 ID 和请求者 ID，支持并发追踪
5. **标准 SSE 格式** -- 始终 `event:` + `id:` + `data:\n\n`
6. **内置心跳** -- 核心层 15s `ping`，业务层无需关心

---

## 三、事件信封结构

### 3.1 TypeScript 类型

```typescript
interface StreamEvent {
  event: string;         // 事件类型
  id: number;            // 递增序列号 (per-connection，支持 Last-Event-ID 断线重连)
  task_id: string;       // 本次调用的唯一 ID，贯穿整个调用链
  session_id: string;    // 会话/工作区 ID，每个事件都带，便于客户端自包含解析
  created_at: number;    // Unix 时间戳 (秒，含小数)
  data: Record<string, unknown>;  // 事件具体负载，按事件类型变化
}

interface TokenUsage {
  prompt_tokens?: number;       // 输入 token
  completion_tokens?: number;   // 输出 token
  total_tokens?: number;        // 总计
  model?: string;               // 使用的模型 (如 "deepseek-v3", "gpt-4o")
}
```

**为什么 `session_id` 放在顶层：** 客户端拿到任何一条事件都能立即知道它属于哪个会话，无需记住 `task_started` 的内容。日志聚合、多会话并行管理也更简单。每条事件增加的冗余仅几十字节，可忽略。

**为什么不需要 `message_id`：** 我们的模型是"任务调用"而非"聊天消息"。`task_id` 已唯一标识一次调用，`id` (序列号) 保证事件有序。

**为什么工具事件不用 label 区分 call / response：** `tool_started` 和 `tool_finished` 的 data 结构不同（前者有 `arguments`，后者有 `output` + `status`），用独立事件类型可以做到 TypeScript 精确类型推导，合成一个靠 label 运行时判断反而更复杂。这也是 OpenAI / Anthropic / LangGraph 的通行做法。

### 3.2 SSE 传输线格式

```
event: task_started
id: 1
data: {"event":"task_started","id":1,"task_id":"a1b2c3","session_id":"sess_01","created_at":1710000000.000,"data":{...}}

```

- `event:` -- 客户端 `EventSource.addEventListener("task_started", ...)` 精确监听
- `id:` -- 断线重连 `Last-Event-ID`
- `data:` JSON 中冗余 `event` + `id` -- WebSocket 等非 SSE 通道也能统一解析

### 3.3 WebSocket 传输格式

直接发送 JSON，与 `data:` 行中的 JSON 完全一致：

```json
{"event":"task_started","id":1,"task_id":"a1b2c3","session_id":"sess_01","created_at":1710000000.000,"data":{...}}
```

---

## 四、事件类型完整定义

### 4.1 生命周期事件

`**task_started**` -- 任务开始，流的第一个事件

```
data.agent_name    : string   -- 执行的智能体名称
data.thread_id     : string?  -- 线程 ID (多轮对话，LangGraph 用它加载历史)
```

注意：`session_id` 已在信封顶层，此处不再重复。

`**task_finished**` -- 任务结束，携带最终结果和统计

```
data.status        : "succeeded" | "failed" | "cancelled" | "paused"
data.output        : string?  -- 最终输出文本
data.error         : string?  -- 失败时的错误信息
data.elapsed_time  : number   -- 总耗时 (秒)
data.usage         : TokenUsage?  -- 整个任务的 token 用量汇总 (替代原 total_tokens)
data.metadata      : object?  -- 业务层可扩展的额外元数据 (如产物路径、文件 URL 等)
```

`**done**` -- 流终结信号，`task_finished` 之后的最后一个事件

```
data: {}   -- 空负载，纯信号
```

`**ping**` -- 心跳 (核心层每 15s 自动发送)

```
data: {}
```

### 4.2 图节点事件

`**node_started**` -- LangGraph 节点开始执行

```
data.node_type     : "perceive" | "think" | "act" | "reflect"
data.iteration     : number   -- 当前所处的推理轮次
```

`**node_finished**` -- LangGraph 节点执行结束

```
data.node_type     : "perceive" | "think" | "act" | "reflect"
data.status        : "succeeded" | "failed"
data.elapsed_time  : number   -- 节点耗时 (秒)
data.iteration     : number
data.usage         : TokenUsage?  -- 该节点内所有 LLM 调用的 token 汇总
```

### 4.3 内容流事件

`**message**` -- LLM 增量文本输出 (token streaming)

```
data.role          : "assistant"
data.delta         : string   -- 增量文本片段
```

`**message_end**` -- 一次 LLM 生成完成

```
data.role          : "assistant"
data.content       : string   -- 完整文本
data.usage         : TokenUsage?  -- 本次 LLM 调用的 token 用量
```

### 4.4 工具事件

`**tool_started**` -- 工具调用发起 (在工具实际执行之前)

```
data.tool_call_id  : string   -- 本次工具调用的唯一 ID (来自 LLM tool_call)
data.tool_name     : string   -- 工具名称
data.arguments     : object   -- 调用参数 (工具业务参数，结构随工具变化)
data.metadata      : object?  -- 基础设施/扩展元数据 (如沙箱 ID、重试次数、工具版本等)
```

`**tool_finished**` -- 工具调用完成

```
data.tool_call_id  : string   -- 与 tool_started 配对
data.tool_name     : string
data.status        : "succeeded" | "failed"
data.output        : unknown? -- 工具返回值 (工具业务结果，结构随工具变化)
data.error         : string?  -- 失败时的错误
data.elapsed_time  : number   -- 工具执行耗时 (秒)
data.metadata      : object?  -- 基础设施/扩展元数据 (如命中率、缓存状态、重试信息等)
```

`arguments` 和 `output` 保持纯粹的工具业务数据，`metadata` 承载基础设施层面的扩展信息，两者职责分离。工具的输入/输出结构变化不会影响协议，新字段直接在 `arguments` / `output` 内自然扩展。

### 4.5 子智能体事件

`**agent_started**` -- 子智能体被 spawn

```
data.child_task_id  : string  -- 子智能体自己的任务 ID
data.parent_task_id : string  -- 发起请求的父任务 ID (= 当前 task_id)
data.agent_name     : string  -- 子智能体名称
data.instruction    : string  -- 下发的指令摘要
data.metadata       : object? -- 扩展元数据 (如子智能体配置、优先级、超时设置等)
```

`**agent_message**` -- 子智能体文本流转发

```
data.child_task_id  : string  -- 哪个子智能体在输出
data.agent_name     : string
data.delta          : string  -- 增量文本
```

`**agent_tool_started**` -- 子智能体开始调用工具

```
data.child_task_id  : string
data.agent_name     : string
data.tool_call_id   : string  -- 子智能体内部的工具调用 ID
data.tool_name      : string
data.arguments      : object
data.metadata       : object?  -- 扩展元数据
```

`**agent_tool_finished**` -- 子智能体工具调用完成

```
data.child_task_id  : string
data.agent_name     : string
data.tool_call_id   : string
data.tool_name      : string
data.status         : "succeeded" | "failed"
data.output         : unknown?
data.error          : string?
data.elapsed_time   : number
data.metadata       : object?  -- 扩展元数据
```

`**agent_finished**` -- 子智能体完成

```
data.child_task_id  : string
data.parent_task_id : string
data.agent_name     : string
data.status         : "succeeded" | "failed"
data.output         : unknown?
data.error          : string?
data.elapsed_time   : number
data.usage          : TokenUsage?  -- 子智能体的 token 用量汇总
data.metadata       : object?      -- 扩展元数据
```

### 4.6 反思 & 进度 & 错误（可选事件，按实际发生才发送）

`**thinking**` -- Agent 内部推理/反思

```
data.content       : string
```

触发条件：`reflect` 节点产出文本时、支持思考链的模型输出推理内容时。
典型场景：Agent 完成一轮后的自我评估，如 "内容已覆盖要求的 5 个知识点，质量达标"。
参见：场景 1 第 19 号事件。

`**progress**` -- 业务进度通知 (来自 emit_event 工具或业务路由)

```
data.message       : string   -- 人类可读的进度描述
data.percentage    : number?  -- 0.0~1.0
data.phase         : string?  -- 当前阶段标识
data.metadata      : object?  -- 可扩展
```

触发条件：

- 业务路由主动调用 `writer.write({ event: "progress", ... })`
- Agent 内置工具 `emit_event` 被调用时
- EventBus 收到 progress 类型消息时

典型场景：长任务中告知前端进度，如 "正在生成第 3 节... 60%"、"正在拼装最终文档... 95%"。
参见：场景 5 业务路由代码示例。

`**error**` -- 错误事件

```
data.code          : string   -- 错误码 (如 "TOOL_EXECUTION_FAILED")
data.message       : string   -- 错误描述
data.recoverable   : boolean  -- 流是否会继续
```

触发条件：工具执行失败、外部 API 超时、LLM 调用异常、子智能体崩溃等。
`recoverable: true` 表示 Agent 会尝试自行恢复（如换用其他工具），流继续。
`recoverable: false` 表示致命错误，随后会收到 `task_finished: status="failed"`。
参见：场景 4 第 5 号事件。

---

## 五、完整事件流示例 (不省略)

### 场景 1：单智能体 + 单工具调用

一个 `document-generator` 智能体执行知识搜索后输出文本。

```
event: task_started
id: 1
data: {"event":"task_started","id":1,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000000.000,"data":{"agent_name":"document-generator","thread_id":"thd_01"}}

event: node_started
id: 2
data: {"event":"node_started","id":2,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000000.100,"data":{"node_type":"perceive","iteration":1}}

event: node_finished
id: 3
data: {"event":"node_finished","id":3,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000000.600,"data":{"node_type":"perceive","status":"succeeded","elapsed_time":0.5,"iteration":1}}

event: node_started
id: 4
data: {"event":"node_started","id":4,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000000.610,"data":{"node_type":"think","iteration":1}}

event: message
id: 5
data: {"event":"message","id":5,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000001.000,"data":{"role":"assistant","delta":"我将为您搜索"}}

event: message
id: 6
data: {"event":"message","id":6,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000001.100,"data":{"role":"assistant","delta":"关于光合作用的资料"}}

event: message_end
id: 7
data: {"event":"message_end","id":7,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000001.200,"data":{"role":"assistant","content":"我将为您搜索关于光合作用的资料"}}

event: node_finished
id: 8
data: {"event":"node_finished","id":8,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000002.700,"data":{"node_type":"think","status":"succeeded","elapsed_time":2.09,"iteration":1}}

event: node_started
id: 9
data: {"event":"node_started","id":9,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000002.710,"data":{"node_type":"act","iteration":1}}

event: tool_started
id: 10
data: {"event":"tool_started","id":10,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000002.720,"data":{"tool_call_id":"call_k1","tool_name":"knowledge_search","arguments":{"query":"光合作用原理","database_id":"db_bio"}}}

event: tool_finished
id: 11
data: {"event":"tool_finished","id":11,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000003.920,"data":{"tool_call_id":"call_k1","tool_name":"knowledge_search","status":"succeeded","output":"光合作用是植物利用光能将二氧化碳和水转化为有机物的过程...","elapsed_time":1.2}}

event: node_finished
id: 12
data: {"event":"node_finished","id":12,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000003.930,"data":{"node_type":"act","status":"succeeded","elapsed_time":1.22,"iteration":1}}

event: node_started
id: 13
data: {"event":"node_started","id":13,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000003.940,"data":{"node_type":"think","iteration":2}}

event: message
id: 14
data: {"event":"message","id":14,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000004.500,"data":{"role":"assistant","delta":"# 光合作用\n\n## 基本原理\n\n光合作用是..."}}

event: message
id: 15
data: {"event":"message","id":15,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000004.700,"data":{"role":"assistant","delta":"植物利用光能将二氧化碳和水转化为有机物的过程。"}}

event: message_end
id: 16
data: {"event":"message_end","id":16,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000004.800,"data":{"role":"assistant","content":"# 光合作用\n\n## 基本原理\n\n光合作用是植物利用光能将二氧化碳和水转化为有机物的过程。","usage":{"prompt_tokens":520,"completion_tokens":380,"total_tokens":900,"model":"deepseek-v3"}}}

event: node_finished
id: 17
data: {"event":"node_finished","id":17,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000005.000,"data":{"node_type":"think","status":"succeeded","elapsed_time":1.06,"iteration":2,"usage":{"prompt_tokens":520,"completion_tokens":380,"total_tokens":900}}}

event: node_started
id: 18
data: {"event":"node_started","id":18,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000005.010,"data":{"node_type":"reflect","iteration":2}}

event: thinking
id: 19
data: {"event":"thinking","id":19,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000005.500,"data":{"content":"任务已完成，内容覆盖了光合作用的基本原理，质量达标。"}}

event: node_finished
id: 20
data: {"event":"node_finished","id":20,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000005.600,"data":{"node_type":"reflect","status":"succeeded","elapsed_time":0.59,"iteration":2}}

event: task_finished
id: 21
data: {"event":"task_finished","id":21,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000005.700,"data":{"status":"succeeded","output":"# 光合作用\n\n## 基本原理\n\n光合作用是植物利用光能将二氧化碳和水转化为有机物的过程。","elapsed_time":5.7,"usage":{"prompt_tokens":820,"completion_tokens":700,"total_tokens":1520,"model":"deepseek-v3"}}}

event: done
id: 22
data: {"event":"done","id":22,"task_id":"task_8f3a","session_id":"sess_01","created_at":1710000005.710,"data":{}}

```

---

### 场景 2：多工具并发调用

`act` 节点同时执行 3 个工具（知识搜索 + 图片生成 + HTTP 请求），客户端通过 `tool_call_id` 配对 started/finished。

```
event: task_started
id: 1
data: {"event":"task_started","id":1,"task_id":"task_b7e2","session_id":"sess_02","created_at":1710000010.000,"data":{"agent_name":"document-generator","thread_id":"thd_02"}}

event: node_started
id: 2
data: {"event":"node_started","id":2,"task_id":"task_b7e2","session_id":"sess_02","created_at":1710000010.500,"data":{"node_type":"act","iteration":1}}

event: tool_started
id: 3
data: {"event":"tool_started","id":3,"task_id":"task_b7e2","session_id":"sess_02","created_at":1710000010.510,"data":{"tool_call_id":"call_a1","tool_name":"knowledge_search","arguments":{"query":"量子计算基础"}}}

event: tool_started
id: 4
data: {"event":"tool_started","id":4,"task_id":"task_b7e2","session_id":"sess_02","created_at":1710000010.520,"data":{"tool_call_id":"call_a2","tool_name":"image_generate","arguments":{"prompt":"量子计算概念图","style":"diagram"}}}

event: tool_started
id: 5
data: {"event":"tool_started","id":5,"task_id":"task_b7e2","session_id":"sess_02","created_at":1710000010.530,"data":{"tool_call_id":"call_a3","tool_name":"http_request","arguments":{"url":"https://api.example.com/quantum","method":"GET"}}}

event: tool_finished
id: 6
data: {"event":"tool_finished","id":6,"task_id":"task_b7e2","session_id":"sess_02","created_at":1710000011.200,"data":{"tool_call_id":"call_a3","tool_name":"http_request","status":"succeeded","output":{"statusCode":200,"body":"..."},"elapsed_time":0.67}}

event: tool_finished
id: 7
data: {"event":"tool_finished","id":7,"task_id":"task_b7e2","session_id":"sess_02","created_at":1710000011.800,"data":{"tool_call_id":"call_a1","tool_name":"knowledge_search","status":"succeeded","output":"量子计算利用量子力学原理进行信息处理...","elapsed_time":1.29}}

event: tool_finished
id: 8
data: {"event":"tool_finished","id":8,"task_id":"task_b7e2","session_id":"sess_02","created_at":1710000013.500,"data":{"tool_call_id":"call_a2","tool_name":"image_generate","status":"succeeded","output":{"imageUrl":"https://...","width":1024,"height":768},"elapsed_time":2.98}}

event: node_finished
id: 9
data: {"event":"node_finished","id":9,"task_id":"task_b7e2","session_id":"sess_02","created_at":1710000013.510,"data":{"node_type":"act","status":"succeeded","elapsed_time":3.01,"iteration":1}}

event: task_finished
id: 10
data: {"event":"task_finished","id":10,"task_id":"task_b7e2","session_id":"sess_02","created_at":1710000015.000,"data":{"status":"succeeded","output":"...","elapsed_time":5.0,"usage":{"prompt_tokens":1100,"completion_tokens":1000,"total_tokens":2100}}}

event: done
id: 11
data: {"event":"done","id":11,"task_id":"task_b7e2","session_id":"sess_02","created_at":1710000015.010,"data":{}}

```

客户端并发追踪逻辑：

- 收到 `tool_started` 时按 `tool_call_id` 建立 Map 条目，显示"正在执行 XXX"
- 收到 `tool_finished` 时按 `tool_call_id` 匹配移除，显示结果
- 三个工具乱序完成，但 `tool_call_id` 保证配对正确

---

### 场景 3：多子智能体并发 (spawn_parallel_agents)

父智能体 `document-generator`(task_8f3a) 并行 spawn 两个子智能体 `section-writer`，每个子智能体各自调用工具、流式输出文本。

```
event: task_started
id: 1
data: {"event":"task_started","id":1,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000020.000,"data":{"agent_name":"document-generator","thread_id":"thd_03"}}

event: node_started
id: 2
data: {"event":"node_started","id":2,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000021.000,"data":{"node_type":"act","iteration":1}}

event: tool_started
id: 3
data: {"event":"tool_started","id":3,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000021.010,"data":{"tool_call_id":"call_sp1","tool_name":"spawn_parallel_agents","arguments":{"agents":[{"agentName":"section-writer","instruction":"撰写第一章：光合作用的发现历史"},{"agentName":"section-writer","instruction":"撰写第二章：光合作用的化学反应"}]}}}

event: agent_started
id: 4
data: {"event":"agent_started","id":4,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000021.100,"data":{"child_task_id":"task_c1a1","parent_task_id":"task_8f3a","agent_name":"section-writer","instruction":"撰写第一章：光合作用的发现历史"}}

event: agent_started
id: 5
data: {"event":"agent_started","id":5,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000021.110,"data":{"child_task_id":"task_c2b2","parent_task_id":"task_8f3a","agent_name":"section-writer","instruction":"撰写第二章：光合作用的化学反应"}}

event: agent_message
id: 6
data: {"event":"agent_message","id":6,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000022.000,"data":{"child_task_id":"task_c1a1","agent_name":"section-writer","delta":"# 第一章 光合作用的发现历史\n\n"}}

event: agent_tool_started
id: 7
data: {"event":"agent_tool_started","id":7,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000022.100,"data":{"child_task_id":"task_c2b2","agent_name":"section-writer","tool_call_id":"call_c2_t1","tool_name":"knowledge_search","arguments":{"query":"光合作用化学方程式"}}}

event: agent_message
id: 8
data: {"event":"agent_message","id":8,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000022.500,"data":{"child_task_id":"task_c1a1","agent_name":"section-writer","delta":"1771年，英国化学家约瑟夫·普里斯特利发现..."}}

event: agent_tool_finished
id: 9
data: {"event":"agent_tool_finished","id":9,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000023.300,"data":{"child_task_id":"task_c2b2","agent_name":"section-writer","tool_call_id":"call_c2_t1","tool_name":"knowledge_search","status":"succeeded","output":"6CO2 + 6H2O → C6H12O6 + 6O2","elapsed_time":1.2}}

event: agent_message
id: 10
data: {"event":"agent_message","id":10,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000023.500,"data":{"child_task_id":"task_c2b2","agent_name":"section-writer","delta":"# 第二章 光合作用的化学反应\n\n光合作用的总反应方程式为：\n\n"}}

event: agent_message
id: 11
data: {"event":"agent_message","id":11,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000024.000,"data":{"child_task_id":"task_c1a1","agent_name":"section-writer","delta":"这一发现奠定了光合作用研究的基础。"}}

event: agent_tool_started
id: 12
data: {"event":"agent_tool_started","id":12,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000024.100,"data":{"child_task_id":"task_c1a1","agent_name":"section-writer","tool_call_id":"call_c1_t1","tool_name":"workspace_write","arguments":{"path":"sections/chapter-01.md","content":"..."}}}

event: agent_message
id: 13
data: {"event":"agent_message","id":13,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000024.500,"data":{"child_task_id":"task_c2b2","agent_name":"section-writer","delta":"$$6CO_2 + 6H_2O \\xrightarrow{光能} C_6H_{12}O_6 + 6O_2$$"}}

event: agent_tool_finished
id: 14
data: {"event":"agent_tool_finished","id":14,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000024.600,"data":{"child_task_id":"task_c1a1","agent_name":"section-writer","tool_call_id":"call_c1_t1","tool_name":"workspace_write","status":"succeeded","output":{"path":"sections/chapter-01.md","bytesWritten":1024},"elapsed_time":0.5}}

event: agent_finished
id: 15
data: {"event":"agent_finished","id":15,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000025.000,"data":{"child_task_id":"task_c1a1","parent_task_id":"task_8f3a","agent_name":"section-writer","status":"succeeded","output":"# 第一章 光合作用的发现历史\n\n1771年...","elapsed_time":3.9,"usage":{"prompt_tokens":600,"completion_tokens":550,"total_tokens":1150}}}

event: agent_tool_started
id: 16
data: {"event":"agent_tool_started","id":16,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000025.500,"data":{"child_task_id":"task_c2b2","agent_name":"section-writer","tool_call_id":"call_c2_t2","tool_name":"workspace_write","arguments":{"path":"sections/chapter-02.md","content":"..."}}}

event: agent_tool_finished
id: 17
data: {"event":"agent_tool_finished","id":17,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000026.000,"data":{"child_task_id":"task_c2b2","agent_name":"section-writer","tool_call_id":"call_c2_t2","tool_name":"workspace_write","status":"succeeded","output":{"path":"sections/chapter-02.md","bytesWritten":856},"elapsed_time":0.5}}

event: agent_finished
id: 18
data: {"event":"agent_finished","id":18,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000026.500,"data":{"child_task_id":"task_c2b2","parent_task_id":"task_8f3a","agent_name":"section-writer","status":"succeeded","output":"# 第二章 光合作用的化学反应\n\n...","elapsed_time":5.39,"usage":{"prompt_tokens":700,"completion_tokens":650,"total_tokens":1350}}}

event: tool_finished
id: 19
data: {"event":"tool_finished","id":19,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000026.510,"data":{"tool_call_id":"call_sp1","tool_name":"spawn_parallel_agents","status":"succeeded","output":{"results":[{"agent":"section-writer","child_task_id":"task_c1a1","success":true},{"agent":"section-writer","child_task_id":"task_c2b2","success":true}]},"elapsed_time":5.5}}

event: node_finished
id: 20
data: {"event":"node_finished","id":20,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000026.520,"data":{"node_type":"act","status":"succeeded","elapsed_time":5.52,"iteration":1}}

event: task_finished
id: 21
data: {"event":"task_finished","id":21,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000027.000,"data":{"status":"succeeded","output":"文档生成完成","elapsed_time":7.0,"usage":{"prompt_tokens":2300,"completion_tokens":2200,"total_tokens":4500}}}

event: done
id: 22
data: {"event":"done","id":22,"task_id":"task_8f3a","session_id":"sess_03","created_at":1710000027.010,"data":{}}

```

并发子智能体 ID 追踪关系图：

```
task_8f3a (document-generator)        <-- 父 task_id，贯穿所有事件
├── call_sp1 (spawn_parallel_agents)  <-- 父的工具调用 ID
│   ├── task_c1a1 (section-writer)    <-- 子智能体 1 的 child_task_id
│   │   ├── call_c1_t1 (workspace_write)  <-- 子智能体 1 内部的 tool_call_id
│   │   └── (agent_message events)
│   └── task_c2b2 (section-writer)    <-- 子智能体 2 的 child_task_id
│       ├── call_c2_t1 (knowledge_search)
│       ├── call_c2_t2 (workspace_write)
│       └── (agent_message events)
```

客户端通过 `child_task_id` 区分哪个子智能体在干什么，通过 `tool_call_id` 区分子智能体内部的工具配对。所有事件的 `task_id` 都是父的 `task_8f3a`，保证整条流可聚合。

---

### 场景 4：工具执行失败 + 错误恢复

```
event: task_started
id: 1
data: {"event":"task_started","id":1,"task_id":"task_err1","session_id":"sess_04","created_at":1710000030.000,"data":{"agent_name":"document-generator","thread_id":"thd_04"}}

event: node_started
id: 2
data: {"event":"node_started","id":2,"task_id":"task_err1","session_id":"sess_04","created_at":1710000030.500,"data":{"node_type":"act","iteration":1}}

event: tool_started
id: 3
data: {"event":"tool_started","id":3,"task_id":"task_err1","session_id":"sess_04","created_at":1710000030.510,"data":{"tool_call_id":"call_f1","tool_name":"http_request","arguments":{"url":"https://api.unreachable.com","method":"GET"}}}

event: tool_finished
id: 4
data: {"event":"tool_finished","id":4,"task_id":"task_err1","session_id":"sess_04","created_at":1710000035.510,"data":{"tool_call_id":"call_f1","tool_name":"http_request","status":"failed","error":"ETIMEDOUT: Connection timed out after 5000ms","elapsed_time":5.0}}

event: error
id: 5
data: {"event":"error","id":5,"task_id":"task_err1","session_id":"sess_04","created_at":1710000035.520,"data":{"code":"TOOL_EXECUTION_FAILED","message":"http_request 工具执行超时","recoverable":true}}

event: node_finished
id: 6
data: {"event":"node_finished","id":6,"task_id":"task_err1","session_id":"sess_04","created_at":1710000035.530,"data":{"node_type":"act","status":"succeeded","elapsed_time":5.03,"iteration":1}}

event: node_started
id: 7
data: {"event":"node_started","id":7,"task_id":"task_err1","session_id":"sess_04","created_at":1710000035.540,"data":{"node_type":"think","iteration":2}}

event: message
id: 8
data: {"event":"message","id":8,"task_id":"task_err1","session_id":"sess_04","created_at":1710000036.000,"data":{"role":"assistant","delta":"外部接口暂时不可用，我将使用知识库中的已有资料为您完成任务。"}}

event: message_end
id: 9
data: {"event":"message_end","id":9,"task_id":"task_err1","session_id":"sess_04","created_at":1710000036.200,"data":{"role":"assistant","content":"外部接口暂时不可用，我将使用知识库中的已有资料为您完成任务。"}}

event: node_finished
id: 10
data: {"event":"node_finished","id":10,"task_id":"task_err1","session_id":"sess_04","created_at":1710000036.300,"data":{"node_type":"think","status":"succeeded","elapsed_time":0.76,"iteration":2}}

event: task_finished
id: 11
data: {"event":"task_finished","id":11,"task_id":"task_err1","session_id":"sess_04","created_at":1710000038.000,"data":{"status":"succeeded","output":"基于知识库的输出内容...","elapsed_time":8.0,"usage":{"prompt_tokens":950,"completion_tokens":850,"total_tokens":1800}}}

event: done
id: 12
data: {"event":"done","id":12,"task_id":"task_err1","session_id":"sess_04","created_at":1710000038.010,"data":{}}

```

---

### 场景 5：业务路由接入示例 (document-generation)

展示业务层如何用最少代码接入基座事件流：

```typescript
// apps/document-generation/code/routes.ts
import { SSEWriter } from "../../../src/core/sse-writer.js";

app.post("/api/business/document-generation/generate-stream", async (request, reply) => {
  const writer = SSEWriter.create(reply, { taskId, sessionId });

  // 基座 streamAgent 直接 yield StreamEvent，writer 透传写入
  for await (const event of agentRuntime.streamAgent(AGENT_NAME, instruction, opts)) {
    writer.write(event);
  }

  // 业务层可以在流结束前注入自己的事件
  writer.write({
    event: "progress",
    task_id: taskId,
    session_id: sessionId,
    data: { message: "正在生成最终文档...", percentage: 0.95, phase: "assembly" },
  });

  writer.end();
});
```

业务路由不需要关心：

- SSE 格式 (`event:` / `id:` / `data:`)
- 心跳 (SSEWriter 自动管理)
- 事件序列号 (SSEWriter 自增)
- `session_id` 注入 (SSEWriter 自动为每个事件填充)
- 断线检测 (SSEWriter 监听 socket close)

---

## 六、核心概念：三层 ID 体系

### 6.1 task_id / session_id / thread_id 分工定义

```
thread_id   ─── 对话上下文线程 (LangGraph 历史消息)
                 多轮对话中保持不变，LangGraph 用它加载历史
                 生命周期：跨多次请求，直到对话结束

session_id  ─── 会话容器 / 工作区
                 关联 workspace、产物文件、日志
                 生命周期：一次业务会话 (可能包含多个 task)

task_id     ─── 单次调用 (一次 invoke/stream 请求)
                 贯穿该次调用产生的所有事件
                 生命周期：从 task_started 到 done
```

关系图：

```
session_id: "sess_001" (一次文档生成会话)
├── task_id: "task_r1" (第1轮对话/第1次生成)
│   └── thread_id: "thd_001"
├── task_id: "task_r2" (第2轮对话/重试/续写)
│   └── thread_id: "thd_001" (同一线程，保留上下文)
└── task_id: "task_r3" (第3轮)
    └── thread_id: "thd_001"
```

在事件流中的体现：

- `task_id` 在信封顶层，每个事件都带
- `session_id` 在信封顶层，每个事件都带（方便客户端自包含解析、日志聚合、多会话管理）
- `thread_id` 在 `task_started` 的 `data` 中出现一次（主要是服务端用来加载 LangGraph 历史，客户端一般不需要在每条事件里获取）

### 6.2 子智能体 spawn 作为工具调用的设计依据

在 LangGraph 中，`spawn_sub_agent` / `spawn_parallel_agents` 本身就是注册的工具。LLM 在 think 节点做出调用决策，与 `knowledge_search` 等工具走相同路径。事件流如实反映执行模型：

```
tool_started (spawn_parallel_agents)  ← LLM 的工具调用决策
  ├── agent_started (child A)         ← 工具执行内部：创建子智能体
  ├── agent_started (child B)
  ├── agent_message / agent_tool_*    ← 子智能体干活中
  ├── agent_finished (child A)
  ├── agent_finished (child B)
tool_finished (spawn_parallel_agents) ← 工具返回聚合结果
```

不单独设计 `spawn_started` 事件类型的原因：

- 一致性：所有工具调用走同一解析路径
- `tool_name: "spawn_parallel_agents"` 已足够区分
- `agent_*` 事件提供子智能体细粒度追踪
- 避免同一行为可从两条事件路径触发的歧义

---

## 七、多轮对话场景支撑

### 7.1 AI Chat 助手场景

```
=== 用户第1轮 ===
POST /api/agents/chat-assistant/stream
Body: { input: "你好", threadId: "thd_001", sessionId: "sess_chat_01" }

event: task_started
id: 1
data: {"event":"task_started","id":1,"task_id":"task_r1","session_id":"sess_chat_01","created_at":1710000100.000,"data":{"agent_name":"chat-assistant","thread_id":"thd_001"}}

event: message
id: 2
data: {"event":"message","id":2,"task_id":"task_r1","session_id":"sess_chat_01","created_at":1710000100.500,"data":{"role":"assistant","delta":"你好！有什么可以帮你的？"}}

event: message_end
id: 3
data: {"event":"message_end","id":3,"task_id":"task_r1","session_id":"sess_chat_01","created_at":1710000100.600,"data":{"role":"assistant","content":"你好！有什么可以帮你的？"}}

event: task_finished
id: 4
data: {"event":"task_finished","id":4,"task_id":"task_r1","session_id":"sess_chat_01","created_at":1710000100.700,"data":{"status":"succeeded","output":"你好！有什么可以帮你的？","elapsed_time":0.7,"usage":{"prompt_tokens":25,"completion_tokens":25,"total_tokens":50}}}

event: done
id: 5
data: {"event":"done","id":5,"task_id":"task_r1","session_id":"sess_chat_01","created_at":1710000100.710,"data":{}}


=== 用户第2轮 (同一个 threadId，LangGraph 自动加载历史) ===
POST /api/agents/chat-assistant/stream
Body: { input: "帮我查一下量子计算", threadId: "thd_001", sessionId: "sess_chat_01" }

event: task_started
id: 1
data: {"event":"task_started","id":1,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000200.000,"data":{"agent_name":"chat-assistant","thread_id":"thd_001"}}

event: node_started
id: 2
data: {"event":"node_started","id":2,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000200.100,"data":{"node_type":"think","iteration":1}}

event: message
id: 3
data: {"event":"message","id":3,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000200.500,"data":{"role":"assistant","delta":"好的，让我帮你查一下量子计算的相关信息。"}}

event: message_end
id: 4
data: {"event":"message_end","id":4,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000200.700,"data":{"role":"assistant","content":"好的，让我帮你查一下量子计算的相关信息。"}}

event: node_finished
id: 5
data: {"event":"node_finished","id":5,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000200.800,"data":{"node_type":"think","status":"succeeded","elapsed_time":0.7,"iteration":1}}

event: node_started
id: 6
data: {"event":"node_started","id":6,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000200.810,"data":{"node_type":"act","iteration":1}}

event: tool_started
id: 7
data: {"event":"tool_started","id":7,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000200.820,"data":{"tool_call_id":"call_q1","tool_name":"knowledge_search","arguments":{"query":"量子计算基础原理"}}}

event: tool_finished
id: 8
data: {"event":"tool_finished","id":8,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000202.000,"data":{"tool_call_id":"call_q1","tool_name":"knowledge_search","status":"succeeded","output":"量子计算利用量子叠加和量子纠缠进行信息处理...","elapsed_time":1.18}}

event: node_finished
id: 9
data: {"event":"node_finished","id":9,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000202.010,"data":{"node_type":"act","status":"succeeded","elapsed_time":1.2,"iteration":1}}

event: node_started
id: 10
data: {"event":"node_started","id":10,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000202.020,"data":{"node_type":"think","iteration":2}}

event: message
id: 11
data: {"event":"message","id":11,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000202.500,"data":{"role":"assistant","delta":"根据查询结果，量子计算是利用量子力学原理进行信息处理的新型计算范式..."}}

event: message
id: 12
data: {"event":"message","id":12,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000202.800,"data":{"role":"assistant","delta":"它利用量子叠加和量子纠缠等特性，能够在特定问题上实现远超经典计算机的性能。"}}

event: message_end
id: 13
data: {"event":"message_end","id":13,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000203.000,"data":{"role":"assistant","content":"根据查询结果，量子计算是利用量子力学原理进行信息处理的新型计算范式。它利用量子叠加和量子纠缠等特性，能够在特定问题上实现远超经典计算机的性能。"}}

event: node_finished
id: 14
data: {"event":"node_finished","id":14,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000203.100,"data":{"node_type":"think","status":"succeeded","elapsed_time":1.08,"iteration":2}}

event: task_finished
id: 15
data: {"event":"task_finished","id":15,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000203.200,"data":{"status":"succeeded","output":"根据查询结果，量子计算是利用量子力学原理...","elapsed_time":3.2,"usage":{"prompt_tokens":350,"completion_tokens":330,"total_tokens":680}}}

event: done
id: 16
data: {"event":"done","id":16,"task_id":"task_r2","session_id":"sess_chat_01","created_at":1710000203.210,"data":{}}

```

注意：每轮的 `id` 序列号从 1 重新开始（per-connection），而 `task_id` 每轮不同，`thread_id` 始终不变。`session_id` 在每条事件的信封顶层都存在。

---

## 八、进阶需求的协议预留

### 8.1 task_finished 状态扩展

```typescript
data.status: "succeeded" | "failed" | "cancelled" | "paused"
```

- `succeeded` -- 正常完成
- `failed` -- 执行失败
- `cancelled` -- 人为取消 (用户点击"停止生成")
- `paused` -- 暂停 (预留，未来支持断点暂停)

### 8.2 错误重试场景

重试 = 新的 `task_id`，同一个 `session_id` / `thread_id`。

**完整重试流程：**

```
=== 第1次请求（失败）===
POST /api/agents/document-generator/stream
Body: { input: "生成量子计算文档", threadId: "thd_01", sessionId: "sess_01" }

event: task_started
id: 1
data: {"event":"task_started","id":1,"task_id":"task_v1","session_id":"sess_01","created_at":1710000300.000,"data":{"agent_name":"document-generator","thread_id":"thd_01"}}

event: node_started
id: 2
data: {"event":"node_started","id":2,"task_id":"task_v1","session_id":"sess_01","created_at":1710000300.500,"data":{"node_type":"think","iteration":1}}

event: error
id: 3
data: {"event":"error","id":3,"task_id":"task_v1","session_id":"sess_01","created_at":1710000330.000,"data":{"code":"LLM_TIMEOUT","message":"模型响应超时 (30s)","recoverable":false}}

event: node_finished
id: 4
data: {"event":"node_finished","id":4,"task_id":"task_v1","session_id":"sess_01","created_at":1710000330.050,"data":{"node_type":"think","status":"failed","elapsed_time":29.55,"iteration":1}}

event: task_finished
id: 5
data: {"event":"task_finished","id":5,"task_id":"task_v1","session_id":"sess_01","created_at":1710000330.100,"data":{"status":"failed","error":"模型响应超时","elapsed_time":30.1}}

event: done
id: 6
data: {"event":"done","id":6,"task_id":"task_v1","session_id":"sess_01","created_at":1710000330.110,"data":{}}


=== 第2次请求（重试，客户端带上同样的 threadId + sessionId）===
POST /api/agents/document-generator/stream
Body: { input: "生成量子计算文档", threadId: "thd_01", sessionId: "sess_01" }

event: task_started
id: 1
data: {"event":"task_started","id":1,"task_id":"task_v2","session_id":"sess_01","created_at":1710000340.000,"data":{"agent_name":"document-generator","thread_id":"thd_01"}}

event: node_started
id: 2
data: {"event":"node_started","id":2,"task_id":"task_v2","session_id":"sess_01","created_at":1710000340.500,"data":{"node_type":"think","iteration":1}}

event: message
id: 3
data: {"event":"message","id":3,"task_id":"task_v2","session_id":"sess_01","created_at":1710000341.000,"data":{"role":"assistant","delta":"# 量子计算概述\n\n..."}}

... (正常流程)

event: task_finished
id: 12
data: {"event":"task_finished","id":12,"task_id":"task_v2","session_id":"sess_01","created_at":1710000350.000,"data":{"status":"succeeded","output":"# 量子计算概述\n\n...","elapsed_time":10.0,"usage":{"prompt_tokens":1050,"completion_tokens":950,"total_tokens":2000}}}

event: done
id: 13
data: {"event":"done","id":13,"task_id":"task_v2","session_id":"sess_01","created_at":1710000350.010,"data":{}}

```

**重试要点：**

- 客户端在请求参数里带上**同样的** `threadId` 和 `sessionId`
- 服务端生成**新的** `task_id`（`task_v2`），但用 `threadId` 加载 LangGraph 历史继续
- `id`（序列号）在新连接中从 1 重新开始
- 客户端通过 `session_id` 聚合同一业务请求的多次尝试，通过 `task_id` 区分每次尝试

### 8.3 人为中断控制

```
客户端 → DELETE /api/tasks/:taskId   (已有端点)

服务端在 LangGraph 迭代循环中检查 cancelled 标记：
  → 安全退出当前节点
  → yield task_finished: status="cancelled"
  → yield done
```

### 8.4 断线重连 & 断点续传 (协议层预留)

**第一层：SSE 断线重连 (协议已内置)**

- 事件 `id` 递增序列号 → 客户端用 `Last-Event-ID` 请求重连
- 服务端维护事件缓冲区 (Ring Buffer / Redis)，从断点重放
- 协议层无需改动

**第二层：服务器重启后执行恢复 (未来扩展)**

需要的基础设施（不在本次实现范围，但协议已预留支撑）：

- LangGraph checkpoint 持久化 (按 `task_id` + `thread_id` 存储)
- 事件日志持久化 (按 `task_id` 存储已发送的所有 `StreamEvent`)
- 恢复流程：加载 checkpoint → 恢复 `streamAgent` → 从 `Last-Event-ID` 开始 yield

协议中支撑恢复的字段：

- `task_id` → 定位要恢复的任务
- `id` (序列号) → 定位客户端已收到的最后一个事件
- `node_type` + `iteration` → 定位恢复到的图节点位置

---

## 九、架构层次

### 9.1 核心层文件 (src/core/) -- 基座

- [src/core/types.ts](src/core/types.ts) -- `StreamEvent` 类型定义 + 所有事件的 `data` 子类型
- **新建** `src/core/stream-protocol.ts` -- 事件枚举 + 工厂函数 (`createTaskStarted()`, `createToolStarted()`, ...)
- **新建** `src/core/sse-writer.ts` -- SSE 写入器 (格式化 + 心跳 + 序列号 + 断线检测 + `done` 终结)
- [src/core/agent-runtime.ts](src/core/agent-runtime.ts) -- `streamAgent` 重构，yield 新 `StreamEvent`
- [src/core/agent-graph.ts](src/core/agent-graph.ts) -- act 节点拆分为 tool_started → 执行 → tool_finished
- [src/core/sub-agent-manager.ts](src/core/sub-agent-manager.ts) -- 改用 `streamAgent` 流式执行，转发子事件
- [src/core/event-bus.ts](src/core/event-bus.ts) -- 统一使用 `StreamEvent`，`emit_event` 注入主流

### 9.2 路由层适配

- [src/api/routes/agent.routes.ts](src/api/routes/agent.routes.ts) -- 使用 `SSEWriter`
- 所有 `apps/*/code/routes.ts` -- 复用 `SSEWriter`，删除自定义样板

### 9.3 向后兼容

- **破坏性变更** -- 响应头 `X-Stream-Protocol: 2.0` 标识新协议
- 文档同步更新

