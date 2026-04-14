# Workflow YAML 声明式工作流引擎 — 设计文档

> 日期: 2026-03-19
> 状态: 已确认，待实施

## 一、设计目标

将 `workflow.yaml` 打造为工作流执行的**唯一驱动定义**：

- 设计好 YAML + 配置 prompt .md 文件 = 新 agent 立即可用
- 事件流完全由 YAML 节点定义驱动（节点事件契约）
- 通用格式支持 ReAct / Pipeline / 双模 / 自定义拓扑（含环形）
- Dify 适配器根据策略选择不同转换逻辑（方案 C）

---

## 二、文件位置与结构

### 存放位置

```
apps/<domain>/<agent-name>/
  ├── workflow.yaml          ← 完整工作流定义（吸收 agent.config.yaml）
  ├── agent.config.yaml      ← 可选（向后兼容，无 workflow.yaml 时使用）
  ├── IDENTITY.md            ← prompt 文件
  ├── MISSION.md
  ├── SOUL.md
  ├── TOOLS.md
  └── memory/MEMORY.md
```

### 加载优先级

1. `workflow.yaml` 存在 → 从中读取 config + graph（完整驱动）
2. `workflow.yaml` 不存在 → 读 `agent.config.yaml` + 硬编码 ReAct（向后兼容）

---

## 三、workflow.yaml 顶层格式

```yaml
version: "1.0"
kind: agent-workflow

agent:
  id: <string>                # 全局唯一标识
  label: <string>             # 显示名称
  description: <string>       # 描述
  strategy: react | pipeline | dual | custom

config:                       # 吸收自 agent.config.yaml
  model: <string>
  workerModel: <string>
  fallbackModels: [<string>]
  maxTokens: <number>
  maxIterations: <number>
  maxConcurrency: <number>
  timeout: <number>
  streamMode: block | stream
  allowedTools: [<string>]
  heartbeat: { enabled: <bool>, intervalMs: <number> }
  evolution: { enabled: <bool>, requireApproval: <bool> }
  retry: { maxAttempts: <number>, backoffMs: <number> }
  metadata: { <key>: <value> }

prompts:                      # 引用 prompt 文件（相对路径）
  identity: IDENTITY.md
  mission: MISSION.md
  soul: SOUL.md
  tools: TOOLS.md

# 单模式 agent: 直接使用 graph
graph:
  nodes: [...]
  edges: [...]

# 双模式 agent: 使用 modes
modes:
  default: <mode-name>
  <mode-name>:
    strategy: react | pipeline
    graph:
      nodes: [...]
      edges: [...]
```

---

## 四、节点类型体系

### 通用节点字段

```yaml
- id: <string>                # 稳定唯一 ID（跨执行不变）
  type: <node-type>           # 节点类型
  data:
    title: <string>           # 显示标题
    description: <string>     # 描述（可选）
    # ...type-specific 字段
```

### 节点类型枚举

| type | 说明 | 适用策略 | 产出事件 |
|------|------|----------|----------|
| `start` | 工作流入口 | 全部 | `workflow_started` |
| `end` | 工作流出口 | 全部 | `workflow_finished` + `message_end` |
| `phase` | ReAct 阶段 | react | `agent_log(label, started/succeeded)` |
| `agent_call` | 调用子 agent | pipeline / react | `node_started` + 子事件 + `node_finished` |
| `handler` | 调用注册函数 | pipeline | `node_started` + `node_finished` |
| `llm` | 直接 LLM 调用 | pipeline / custom | `node_started` + `message` + `node_finished` |
| `tool` | 直接工具调用 | pipeline / custom | `node_started` + `node_finished` |
| `iteration` | 迭代容器 | pipeline / custom | `iteration_started/next/completed` |
| `condition` | 条件分支 | custom | (不产出事件，仅路由) |
| `parallel_gateway` | 并行网关 | custom | (预留) |

### phase 节点 step 枚举

| step | 实现函数 | 说明 |
|------|----------|------|
| perceive | `createPerceiveNode()` | 感知输入 |
| think | `createThinkNode()` | LLM 推理 |
| act | `createActNode()` | 执行工具 |
| observe | `createObserveNode()` | 观察结果 |
| reflect | `createReflectNode()` | 反思总结 |

---

## 五、边定义

```yaml
edges:
  - id: <string>             # 边 ID（可选）
    source: <node-id>        # 源节点 ID
    target: <node-id>        # 目标节点 ID
    data:
      type: sequential | conditional | cycle
      condition: <condition-name>    # 条件路由（type 非 sequential 时必填）
      description: <string>          # 描述（可选）
```

### 内置条件注册表

| 条件名 | 含义 | 实现 |
|--------|------|------|
| `has_tool_calls` | 最后 AI 消息有 tool_calls | `routeAfterThink → "act"` |
| `no_tool_calls` | 最后 AI 消息无 tool_calls | `routeAfterThink → "reflect"` |
| `continue_iteration` | iteration < max 且无连续失败 | `routeAfterObserve → "think"` |
| `should_exit` | iteration >= max 或连续失败或 done | `routeAfterObserve → "reflect"` |
| `always` | 无条件通过 | 默认 |

---

## 六、节点事件契约（核心映射关系）

### YAML 字段 → 事件字段 映射

| YAML 字段 | 事件字段 | 影响范围 |
|------------|----------|----------|
| `node.id` | `data.node_id` | 该节点所有事件 |
| `node.data.title` | `data.title` | node_started / node_finished |
| `node.data.step` | `data.label` / `data.step` | agent_log 事件 |
| `node.data.stream_mode` | message 事件是否产出 | think 阶段 |
| `agent.strategy` | 整个事件模式 | 全部事件 |

### YAML 变更 → 事件影响

| YAML 操作 | 事件流变化 |
|------------|-----------|
| 修改 node.id | 该节点所有事件的 node_id 变化 |
| 修改 node.data.title | node_started/node_finished 的 title 变化 |
| 修改 node.data.step | agent_log 的 label 和 step 变化 |
| stream_mode: block → stream | 新增 message 事件（逐 token） |
| stream_mode: stream → block | message 事件消失 |
| strategy: react → pipeline | 整个事件模式重构 |
| 新增节点 | 新增对应事件对 |
| 删除节点 | 对应事件消失 |
| 修改 edge 条件 | 事件出现的路径/顺序变化 |

### 各节点类型事件契约

#### start 节点
```
→ workflow_started { workflow_id, inputs }
```

#### end 节点
```
→ workflow_finished { outputs, status, elapsed_time, error }
→ message_end { metadata.usage }
```

#### phase 节点 (step=perceive/observe)
```
→ agent_log(label=<step>, status=started)
→ agent_log(label=<step>, status=succeeded)
```

#### phase 节点 (step=think)
```
→ agent_log(label=think, status=started)
→ agent_log(label="LLM Thought", status=started)
→ [message × N]                                    # 仅 stream_mode=stream
→ agent_log(label="LLM Thought", status=succeeded, output="完整输出")
```

#### phase 节点 (step=act)
```
→ agent_log(label=act, status=started)
→ agent_log(label=act, node_type=tool, tool_name=xxx)     # 每个工具调用
→ agent_log(label=act, node_type=tool, status=succeeded)
→ agent_log(label=<agent-name>, node_type=agent, status=started)  # 子 agent
→   [子 agent 内部事件流]
→ agent_log(label=<agent-name>, node_type=agent, status=succeeded)
→ agent_log(label=act, status=succeeded)
```

#### phase 节点 (step=reflect)
```
→ agent_log(label=reflect, status=started)
→ agent_log(label=reflect, status=succeeded, output="反思总结")
```

#### agent_call 节点 (pipeline)
```
→ node_started(node_id, node_type=agent_call, title)
→   [被调用 agent 的完整事件流]
→ node_finished(node_id, node_type=agent_call, title, outputs)
```

#### handler 节点 (pipeline)
```
→ node_started(node_id, node_type=handler, title)
→ node_finished(node_id, node_type=handler, title, outputs)
```

#### iteration 节点 (pipeline/custom)
```
→ iteration_started(node_id, title, total)
→ iteration_next(node_id, index=0)
→   [子节点事件...]
→ iteration_next(node_id, index=1)
→   [子节点事件...]
→ iteration_completed(node_id, total)
```

---

## 七、Dify 适配器方案 C — 策略感知转换

### 架构

```
DifyStreamAdapter(session, task, context, workflow)
  │
  ├─ this.strategy = workflow.agent.strategy (或运行时 mode 的 strategy)
  │
  └─ transform(nativeEvent):
       if strategy == "react":
         → ReactTransformer.transform(event)      # 当前已有逻辑
       elif strategy == "pipeline":
         → PipelineTransformer.transform(event)    # 新增逻辑
       elif strategy == "dual":
         → 根据运行时 mode 委托
```

### React 转换规则（现有）

```
native                    → Dify
task_started              → workflow_started + node_started(agent)
node_started(think)       → agent_log(think, started) + agent_log(LLM Thought, started)
message                   → message(answer)
tool_started              → agent_log(act, tool_call)
agent_started             → agent_log(agent_name, started)
task_finished             → node_finished(agent) + workflow_finished + message_end
```

### Pipeline 转换规则（新增）

```
native                    → Dify
task_started              → workflow_started
step_started(agent_call)  → node_started(type=agent)
step_started(handler)     → node_started(type=code)
step_finished             → node_finished(outputs)
task_finished             → workflow_finished + message_end
```

---

## 八、完整示例

### document-generator（ReAct 模式）

见 `apps/document-generation/document-generator/workflow.yaml`（Task 7 创建）

### video-course-director（双模模式）

见 `apps/video-course/video-course-director/workflow.yaml`（后续创建）

### section-writer（ReAct 子 agent，stream 模式）

见 `apps/document-generation/section-writer/workflow.yaml`（Task 7 创建）

---

## 九、技术路线总图

```
输入层:     workflow.yaml + .md prompt 文件
               │
数据底座:   agent-loader.ts → 加载解析
            workflow-engine.ts → 动态构建 LangGraph StateGraph
               │
运行层:     LangGraph compiled.stream() → 执行节点 → 产出 native StreamEvent
               │
协议层:     STREAM_PROTOCOL 切换
            ├─ native → SSEWriter → 原生事件流
            └─ dify   → DifyStreamAdapter(strategy-aware) → Dify 事件流
```

---

## 十、向后兼容策略

- 无 `workflow.yaml` 的 agent → `agentDef.workflow = undefined`
- `buildGraph()`: 有 workflow → WorkflowEngine; 无 → 原始硬编码 `buildAgentGraph()`
- `DifyStreamAdapter`: 有 workflow → 稳定 node_id; 无 → 时间戳 fallback
- 零破坏: 所有现有 17 个 agent 无需改动即可继续工作
