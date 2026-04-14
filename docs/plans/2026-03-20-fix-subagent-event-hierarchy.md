# Fix Sub-Agent Event Hierarchy & Missing Events Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix concurrent sub-agent event corruption caused by stack-based frame management, fix missing "LLM Thought started" events, and correct all parent_id linkages.

**Architecture:** Replace the single `executionStack: ExecutionFrame[]` in `DifyStreamAdapter` with a `mainFrame` + `childFrames: Map<string, ExecutionFrame>` approach. Tag forwarded child events with `_childTaskId` so the adapter can route events to the correct frame. Add "LLM Thought started" emission.

**Tech Stack:** TypeScript, Node.js, SSE streaming

---

## Root Cause Analysis

The `DifyStreamAdapter` uses `executionStack: ExecutionFrame[]` as a LIFO stack. When 8 sub-agents are spawned concurrently via `spawnParallel`:

1. `onAgentStarted(group-01)` pushes child1 frame → stack = [main, child1]
2. `onAgentStarted(group-02)` sees `currentFrame()` = child1 (wrong! should be main), pushes child2 → stack = [main, child1, child2]
3. ...repeat for all 8 sub-agents

This causes:
- **Wrong `node_id`/`node_execution_id`** on sub-agent events (attributed to wrong frame)
- **Wrong `parent_id`** on ROUND, perceive, think events (using wrong frame's roundId)
- **Wrong frame pop order** in `onAgentFinished` (concurrent agents finish in arbitrary order)
- **Multiple sub-agents' perceive events increment the same frame's round counter**, causing burst of ROUND 1, ROUND 2, ROUND 3... which are actually from different sub-agents

Additionally, `forwardChildEvent` in `sub-agent-manager.ts` forwards `node_started`/`node_finished` events as raw native events without any child identity info, so the adapter cannot distinguish which sub-agent they belong to.

---

## Issues to Fix

| # | Issue | Root Cause | File(s) |
|---|-------|-----------|---------|
| 1 | Missing "LLM Thought started" event between `think started` and `LLM Thought succeeded` | `onNodeStarted` only emits step-level `started`, not inner LLM phase | `stream-adapter.ts` |
| 2 | Sub-agent events have wrong `node_id`/`node_execution_id` | Stack corruption: `currentFrame()` returns wrong child | `stream-adapter.ts` |
| 3 | Sub-agent ROUND events have `parent_id: null` instead of linking to sub-agent's started event | Stack corruption + no tracking of agentStartedEventId | `stream-adapter.ts` |
| 4 | Sub-agent started event has wrong `parent_id` (should link to tool call event) | No tracking of last tool call event id | `stream-adapter.ts` |
| 5 | Sub-agent internal events (perceive/think/act) have wrong `parent_id` | Using corrupted frame's `currentRoundId` | `stream-adapter.ts` |
| 6 | Sub-agent `message` events have wrong `parent_id` | Using corrupted frame's `nodeExecutionId` | `stream-adapter.ts` |
| 7 | Sub-agent finished events have mismatched `node_id`/`node_execution_id` vs started | Stack pop order doesn't match start order | `stream-adapter.ts` |
| 8 | Forwarded `node_started`/`node_finished` from children carry no child identity | `forwardChildEvent` passes events as-is | `sub-agent-manager.ts` |
| 9 | `outputs.answer` empty in `node_finished` and `workflow_finished` | `accumulatedAnswer` not reaching adapter | `stream-adapter.ts`, `routes.ts` |
| 10 | `message_end.metadata.usage` still empty despite previous fix | `lastUsage` not captured from native event | `routes.ts` |

---

## Task 1: Tag forwarded child events with childTaskId

**Files:**
- Modify: `src/core/sub-agent-manager.ts:226-233`

**Step 1: Add `_childTaskId` to forwarded native events**

In the `forwardChildEvent` method, for `node_started`, `node_finished`, `thinking`, and `progress` events that are forwarded as-is, enrich the event data with `_childTaskId`:

```typescript
// In forwardChildEvent, replace the existing case block:
case "node_started":
case "node_finished":
case "thinking":
case "progress": {
  const enriched = {
    ...event,
    data: { ...(event.data as Record<string, unknown>), _childTaskId: childTaskId },
  };
  cb(enriched as StreamEvent<StreamEventTypeName>);
  break;
}
```

**Step 2: Verify no other forwarding paths exist**

Confirm that `message`, `tool_started`, `tool_finished` are already converted to `agent_*` events (which carry `child_task_id` in their data). The `task_started` and `task_finished` from the child are NOT forwarded (handled by `spawnStreaming` itself).

---

## Task 2: Refactor ExecutionFrame storage from stack to map

**Files:**
- Modify: `src/core/dify/stream-adapter.ts` (entire frame management)

**Step 1: Update ExecutionFrame interface**

Add fields for tracking the agent-started event id and the last tool-call event id:

```typescript
interface ExecutionFrame {
  nodeId: string;
  nodeExecutionId: string;
  parentExecutionId: string;
  agentName: string;
  startTime: number;
  currentRoundId: string;
  currentRound: number;
  isSubAgent: boolean;
  /** The event id of the agent_log(started) that created this frame */
  agentStartedEventId: string;
  /** The event id of the last tool_call agent_log (for linking agent_started to its spawning tool) */
  lastToolEventId: string;
}
```

**Step 2: Replace stack with mainFrame + childFrames map**

Replace:
```typescript
private executionStack: ExecutionFrame[] = [];
```

With:
```typescript
private mainFrame: ExecutionFrame | undefined;
private childFrames = new Map<string, ExecutionFrame>();
```

**Step 3: Add frame lookup helpers**

Replace `currentFrame()` with targeted lookup methods:

```typescript
private getMainFrame(): ExecutionFrame | undefined {
  return this.mainFrame;
}

private getChildFrame(childTaskId: string): ExecutionFrame | undefined {
  return this.childFrames.get(childTaskId);
}

/**
 * Resolve the correct frame for a native event that may have been forwarded from a child.
 * If the event data contains `_childTaskId`, look up the child frame; otherwise use mainFrame.
 */
private resolveFrame(data: Record<string, unknown>): ExecutionFrame | undefined {
  const childTaskId = data._childTaskId as string | undefined;
  if (childTaskId) {
    return this.childFrames.get(childTaskId);
  }
  return this.mainFrame;
}
```

---

## Task 3: Update all event handlers to use correct frame lookup

**Files:**
- Modify: `src/core/dify/stream-adapter.ts`

### Step 1: Update `onTaskStarted`

Replace `this.executionStack.push(...)` with `this.mainFrame = ...`:

```typescript
private onTaskStarted(data: TaskStartedData, ts: number): DifyEvent[] {
  const nodeId = this.makeNodeId(data.agent_name);

  this.mainFrame = {
    nodeId,
    nodeExecutionId: nodeId,
    parentExecutionId: "",
    agentName: data.agent_name,
    startTime: ts,
    currentRoundId: "",
    currentRound: 0,
    isSubAgent: false,
    agentStartedEventId: "",
    lastToolEventId: "",
  };

  const idx = this.nextIndex();

  return [
    {
      ...this.envelope(ts),
      event: DifyEventType.WORKFLOW_STARTED,
      data: {
        id: this.ctx.workflowRunId,
        workflow_run_id: this.ctx.workflowRunId,
        agent_name: data.agent_name,
        inputs: {
          ...this.inputContext.inputs,
          "sys.query": this.inputContext.query,
          "sys.user_id": this.inputContext.userId,
          "sys.tenant_id": this.inputContext.tenantId,
        },
        thread_id: data.thread_id,
        created_at: ts,
      },
    } as DifyEvent,
    {
      ...this.envelope(ts),
      event: DifyEventType.NODE_STARTED,
      data: {
        id: nodeId,
        node_id: nodeId,
        node_execution_id: nodeId,
        node_type: "agent" as const,
        title: data.agent_name,
        parent_id: "",
        index: idx,
        inputs: null,
        created_at: ts,
      },
    } as DifyEvent,
  ];
}
```

### Step 2: Update `onTaskFinished`

Replace `this.executionStack.pop()` with reading and clearing `this.mainFrame`:

```typescript
private onTaskFinished(data: TaskFinishedData, ts: number): DifyEvent[] {
  const frame = this.mainFrame;
  this.mainFrame = undefined;
  const nodeId = frame?.nodeId ?? "";
  const execId = frame?.nodeExecutionId ?? "";
  const idx = this.nextIndex();
  const now = Math.floor(Date.now() / 1000);

  return [
    {
      ...this.envelope(ts),
      event: DifyEventType.NODE_FINISHED,
      data: {
        id: execId,
        node_id: nodeId,
        node_execution_id: execId,
        node_type: "agent" as const,
        title: frame?.agentName ?? "",
        parent_id: frame?.parentExecutionId ?? "",
        index: idx,
        inputs: null,
        status: data.status === "succeeded" ? "succeeded" : "failed",
        outputs: data.outputs ?? {},
        error: data.error,
        elapsed_time: data.elapsed_time,
        usage: data.usage,
        created_at: ts,
      },
    } as DifyEvent,
    {
      ...this.envelope(ts),
      event: DifyEventType.WORKFLOW_FINISHED,
      data: {
        id: this.ctx.workflowRunId,
        workflow_run_id: this.ctx.workflowRunId,
        status: data.status as any,
        outputs: data.outputs ?? {},
        error: data.error ?? null,
        elapsed_time: data.elapsed_time,
        total_tokens: data.usage?.total_tokens ?? 0,
        total_steps: frame?.currentRound ?? 0,
        created_at: ts,
        finished_at: now,
        exceptions_count: 0,
        files: [],
      },
    } as DifyEvent,
  ];
}
```

### Step 3: Update `onNodeStarted` — use resolveFrame + add "LLM Thought started"

```typescript
private onNodeStarted(data: NodeStartedData, ts: number): DifyEvent[] {
  const frame = this.resolveFrame(data as unknown as Record<string, unknown>);
  const events: DifyEvent[] = [];
  const step = data.node_type as AgentLogStep;

  if (step === "perceive" && frame) {
    frame.currentRound++;
    const roundId = randomUUID();
    frame.currentRoundId = roundId;

    events.push(
      this.buildAgentLog(frame, {
        id: roundId,
        label: `ROUND ${frame.currentRound}`,
        step: "round",
        status: "started",
        parentId: frame.isSubAgent ? frame.agentStartedEventId : null,
      }, ts),
    );
  }

  // Emit phase-level started
  const phaseEventId = randomUUID();
  events.push(
    this.buildAgentLog(frame, {
      id: phaseEventId,
      label: step,
      step,
      status: "started",
      parentId: frame?.currentRoundId || null,
    }, ts),
  );

  // For "think" phase, also emit "LLM Thought started" sub-event
  if (step === "think") {
    events.push(
      this.buildAgentLog(frame, {
        id: randomUUID(),
        label: `${this.getModelName()} Thought`,
        step: "think",
        status: "started",
        parentId: frame?.currentRoundId || null,
      }, ts),
    );
  }

  return events;
}
```

### Step 4: Update `onNodeFinished` — use resolveFrame

```typescript
private onNodeFinished(data: NodeFinishedData, ts: number): DifyEvent[] {
  const frame = this.resolveFrame(data as unknown as Record<string, unknown>);
  const step = data.node_type as AgentLogStep;
  const label = step === "think" ? `${this.getModelName()} Thought` : step;

  return [
    this.buildAgentLog(frame, {
      id: randomUUID(),
      label,
      step,
      status: (data.status as AgentLogStatus) || "succeeded",
      parentId: frame?.currentRoundId || null,
      output: data.output ?? "",
      elapsed_time: data.elapsed_time,
    }, ts),
  ];
}
```

### Step 5: Update `onMessage` — use mainFrame only (main agent messages)

```typescript
private onMessage(data: MessageData, ts: number): DifyEvent[] {
  const frame = this.mainFrame;
  return [
    {
      ...this.envelope(ts),
      event: DifyEventType.MESSAGE,
      id: this.ctx.messageId,
      answer: data.delta,
      parent_id: frame?.agentStartedEventId || null,
    } as DifyEvent,
  ];
}
```

### Step 6: Update `onToolStarted` — track lastToolEventId on frame

```typescript
private onToolStarted(data: ToolStartedData, ts: number): DifyEvent[] {
  const frame = this.mainFrame;
  const eventId = randomUUID();

  // Track this tool event id so child agent_started can link to it
  if (frame) {
    frame.lastToolEventId = eventId;
  }

  return [
    this.buildAgentLog(frame, {
      id: eventId,
      label: `CALL ${data.tool_name}`,
      step: "act",
      status: "started",
      parentId: frame?.currentRoundId || null,
      nodeType: "tool",
      data: {
        tool_name: data.tool_name,
        tool_call_id: data.tool_call_id,
        tool_input: data.arguments,
      },
    }, ts),
  ];
}
```

### Step 7: Update `onToolFinished` — use mainFrame

```typescript
private onToolFinished(data: ToolFinishedData, ts: number): DifyEvent[] {
  const frame = this.mainFrame;
  return [
    this.buildAgentLog(frame, {
      id: randomUUID(),
      label: `CALL ${data.tool_name}`,
      step: "act",
      status: data.status as AgentLogStatus,
      parentId: frame?.currentRoundId || null,
      nodeType: "tool",
      data: {
        output: {
          tool_call_id: data.tool_call_id,
          tool_call_name: data.tool_name,
          tool_response: data.output,
        },
      },
      error: data.error || null,
      elapsed_time: data.elapsed_time,
    }, ts),
  ];
}
```

### Step 8: Update `onAgentStarted` — store in childFrames map, link to tool event

```typescript
private onAgentStarted(data: AgentStartedData, ts: number): DifyEvent[] {
  const parentFrame = this.mainFrame;
  const childNodeId = this.makeNodeId(data.agent_name);
  const childExecId = `exec_${randomUUID().slice(0, 8)}`;
  const agentStartedEventId = randomUUID();

  const logEvent = this.buildAgentLog(parentFrame, {
    id: agentStartedEventId,
    label: data.agent_name,
    step: "act",
    status: "started",
    // Link to the tool call that spawned this sub-agent
    parentId: parentFrame?.lastToolEventId || parentFrame?.currentRoundId || null,
    nodeType: "agent",
    data: {
      agent_name: data.agent_name,
      child_task_id: data.child_task_id,
      instruction: data.instruction,
    },
  }, ts);

  // Store child frame keyed by child_task_id
  this.childFrames.set(data.child_task_id, {
    nodeId: childNodeId,
    nodeExecutionId: childExecId,
    parentExecutionId: parentFrame?.nodeExecutionId ?? "",
    agentName: data.agent_name,
    startTime: ts,
    currentRoundId: "",
    currentRound: 0,
    isSubAgent: true,
    agentStartedEventId,
    lastToolEventId: "",
  });

  return [logEvent];
}
```

### Step 9: Update `onAgentMessage` — look up child frame by child_task_id

```typescript
private onAgentMessage(data: AgentMessageData, ts: number): DifyEvent[] {
  const childFrame = this.childFrames.get(data.child_task_id);
  return [
    {
      ...this.envelope(ts),
      event: DifyEventType.MESSAGE,
      id: this.ctx.messageId,
      answer: data.delta,
      parent_id: childFrame?.agentStartedEventId ?? null,
    } as DifyEvent,
  ];
}
```

### Step 10: Update `onAgentToolStarted` — look up child frame by child_task_id

```typescript
private onAgentToolStarted(data: AgentToolStartedData, ts: number): DifyEvent[] {
  const childFrame = this.childFrames.get(data.child_task_id);
  const eventId = randomUUID();
  if (childFrame) {
    childFrame.lastToolEventId = eventId;
  }
  return [
    this.buildAgentLog(childFrame, {
      id: eventId,
      label: `CALL ${data.tool_name}`,
      step: "act",
      status: "started",
      parentId: childFrame?.currentRoundId || null,
      nodeType: "tool",
      data: {
        tool_name: data.tool_name,
        tool_call_id: data.tool_call_id,
        tool_input: data.arguments,
      },
    }, ts),
  ];
}
```

### Step 11: Update `onAgentToolFinished` — look up child frame by child_task_id

```typescript
private onAgentToolFinished(data: AgentToolFinishedData, ts: number): DifyEvent[] {
  const childFrame = this.childFrames.get(data.child_task_id);
  return [
    this.buildAgentLog(childFrame, {
      id: randomUUID(),
      label: `CALL ${data.tool_name}`,
      step: "act",
      status: data.status as AgentLogStatus,
      parentId: childFrame?.currentRoundId || null,
      nodeType: "tool",
      data: {
        output: {
          tool_call_id: data.tool_call_id,
          tool_call_name: data.tool_name,
          tool_response: data.output,
        },
      },
      error: data.error || null,
      elapsed_time: data.elapsed_time,
    }, ts),
  ];
}
```

### Step 12: Update `onAgentFinished` — look up and remove child frame, use mainFrame for node refs

```typescript
private onAgentFinished(data: AgentFinishedData, ts: number): DifyEvent[] {
  const childFrame = this.childFrames.get(data.child_task_id);
  this.childFrames.delete(data.child_task_id);
  const parentFrame = this.mainFrame;

  // Use parentFrame for node_id/node_execution_id (consistent with started event)
  return [
    this.buildAgentLog(parentFrame, {
      id: randomUUID(),
      label: data.agent_name,
      step: "act",
      status: (data.status as AgentLogStatus) || "succeeded",
      // Link to the tool call that spawned this sub-agent (same as started)
      parentId: parentFrame?.lastToolEventId || parentFrame?.currentRoundId || null,
      nodeType: "agent",
      data: {
        agent_name: data.agent_name,
        child_task_id: data.child_task_id,
        child_execution_id: childFrame?.nodeExecutionId,
      },
      output: data.output,
      error: data.error || null,
      elapsed_time: data.elapsed_time,
    }, ts),
  ];
}
```

### Step 13: Remove old `currentFrame()` method

Delete the old `currentFrame()` method entirely since it's replaced by `getMainFrame()`, `getChildFrame()`, and `resolveFrame()`.

---

## Task 4: TypeScript compilation check

**Step 1: Run tsc**

```bash
cd x-pilot-agentic-server && npx tsc --noEmit 2>&1
```

Expected: 0 errors. If errors appear, fix type issues (likely around `data` casting in `resolveFrame`).

---

## Task 5: Integration verification

**Step 1: Start dev server**

```bash
cd x-pilot-agentic-server && npm run dev
```

**Step 2: Send test request and capture output**

```bash
curl -X POST http://localhost:7800/api/business/document-generation/generate-stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer x-pilot-default-key" \
  -d '{"select_knowledge_unit":"测试主题","prompt":"简短测试","sessionId":"test-hierarchy-fix"}'
```

**Step 3: Verify event hierarchy**

Check the output for:
- [ ] `workflow_started` has correct `sys.user_id`, `sys.tenant_id`
- [ ] Main agent `ROUND 1` has `parent_id: null`
- [ ] `perceive started` has `parent_id` = ROUND 1 id
- [ ] `think started` has `parent_id` = ROUND 1 id
- [ ] `LLM Thought started` appears after `think started` (NEW)
- [ ] `LLM Thought succeeded` has `output` field with content
- [ ] Tool call events have `parent_id` = ROUND id
- [ ] Sub-agent started events have `parent_id` = tool call (spawn) event id
- [ ] Sub-agent ROUND events have `parent_id` = sub-agent started event id
- [ ] Sub-agent internal events have `parent_id` = sub-agent's ROUND id
- [ ] Sub-agent message events have `parent_id` = sub-agent started event id
- [ ] Sub-agent finished events have same `node_id`/`node_execution_id` as their started events
- [ ] Different sub-agents have independent ROUND counters (each starts at ROUND 1)
- [ ] `workflow_finished.outputs.answer` contains accumulated message content
- [ ] `message_end.metadata.usage` has token data

---

## Expected Event Hierarchy (document-generation)

```
workflow_started
└─ node_started(agent: document-generator, id=N1)
   ├─ ROUND 1 (parent_id=null)
   │  ├─ perceive started/succeeded (parent_id=ROUND1)
   │  ├─ think started (parent_id=ROUND1)
   │  │  └─ LLM Thought started (parent_id=ROUND1) ← NEW
   │  ├─ LLM Thought succeeded (parent_id=ROUND1, output="...")
   │  ├─ act started (parent_id=ROUND1)
   │  │  ├─ CALL workspace_read started/succeeded
   │  │  └─ CALL knowledge_search started/succeeded
   │  ├─ act succeeded (parent_id=ROUND1)
   │  └─ observe started/succeeded (parent_id=ROUND1)
   │
   ├─ ROUND 2 (parent_id=null)
   │  ├─ ...perceive/think/act...
   │  ├─ act started (parent_id=ROUND2)
   │  │  ├─ CALL spawn_parallel_agents started (id=TOOL1, parent_id=ROUND2)
   │  │  ├─ section-writer started (id=SW1, parent_id=TOOL1) ← links to tool call
   │  │  │  ├─ ROUND 1 (parent_id=SW1) ← links to sub-agent started
   │  │  │  │  ├─ perceive started/succeeded
   │  │  │  │  ├─ think started
   │  │  │  │  │  └─ LLM Thought started
   │  │  │  │  ├─ LLM Thought succeeded (output="...")
   │  │  │  │  ├─ message("我将...") (parent_id=SW1)
   │  │  │  │  ├─ act started → tool calls...
   │  │  │  │  └─ observe...
   │  │  │  └─ ROUND 2 (parent_id=SW1)
   │  │  │     └─ ...
   │  │  ├─ section-writer succeeded (parent_id=TOOL1)
   │  │  │
   │  │  ├─ section-writer started (id=SW2, parent_id=TOOL1) [concurrent]
   │  │  │  └─ ROUND 1 (parent_id=SW2)
   │  │  │     └─ ...independent rounds...
   │  │  ├─ section-writer succeeded (parent_id=TOOL1)
   │  │  │
   │  │  └─ CALL spawn_parallel_agents succeeded
   │  └─ act succeeded
   │
   └─ node_finished(agent: document-generator)

workflow_finished (outputs.answer="全部message内容", outputs.url="...")
message_end (metadata.usage={...})
```

---

## Execution Options

**Plan complete and saved to `docs/plans/2026-03-20-fix-subagent-event-hierarchy.md`.**

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
