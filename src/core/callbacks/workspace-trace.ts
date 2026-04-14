import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import type { AgentAction, AgentFinish } from "@langchain/core/agents";
import type { Document } from "@langchain/core/documents";
import { workspaceManager } from "../workspace.js";
import { logger } from "../../utils/logger.js";

export interface TraceRun {
  id: string;
  parentRunId?: string;
  type: "llm" | "tool" | "chain" | "agent";
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  children: TraceRun[];
}

export class WorkspaceTraceCallbackHandler extends BaseCallbackHandler {
  name = "workspace_trace_handler";
  
  private runs: Map<string, TraceRun> = new Map();
  private rootRuns: TraceRun[] = [];
  private tenantId: string;
  private userId: string;
  private sessionId: string;
  private agentName: string;

  constructor(tenantId: string, userId: string, sessionId: string, agentName: string) {
    super();
    this.tenantId = tenantId;
    this.userId = userId;
    this.sessionId = sessionId;
    this.agentName = agentName;
  }

  private addRun(run: TraceRun) {
    this.runs.set(run.id, run);
    if (run.parentRunId && this.runs.has(run.parentRunId)) {
      this.runs.get(run.parentRunId)!.children.push(run);
    } else {
      this.rootRuns.push(run);
    }
  }

  private completeRun(runId: string, outputs?: Record<string, unknown>, error?: string) {
    const run = this.runs.get(runId);
    if (run) {
      run.endTime = Date.now();
      run.durationMs = run.endTime - run.startTime;
      if (outputs) run.outputs = outputs;
      if (error) run.error = error;
    }
  }

  // --- LLM Events ---
  async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.addRun({
      id: runId,
      parentRunId,
      type: "llm",
      name: llm.id[llm.id.length - 1] ?? "LLM",
      startTime: Date.now(),
      inputs: { prompts, ...extraParams },
      children: [],
    });
  }

  async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const generations = output.generations.map(g => g.map(gen => gen.text));
    this.completeRun(runId, { generations, llmOutput: output.llmOutput });
  }

  async handleLLMError(err: any, runId: string): Promise<void> {
    this.completeRun(runId, undefined, err?.message ?? String(err));
  }

  // --- Tool Events ---
  async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.addRun({
      id: runId,
      parentRunId,
      type: "tool",
      name: tool.id[tool.id.length - 1] ?? "Tool",
      startTime: Date.now(),
      inputs: { input },
      children: [],
    });
  }

  async handleToolEnd(output: string, runId: string): Promise<void> {
    this.completeRun(runId, { output });
  }

  async handleToolError(err: any, runId: string): Promise<void> {
    this.completeRun(runId, undefined, err?.message ?? String(err));
  }

  // --- Chain/Graph Events ---
  async handleChainStart(
    chain: Serialized,
    inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    this.addRun({
      id: runId,
      parentRunId,
      type: "chain",
      name: chain.id[chain.id.length - 1] ?? "Chain",
      startTime: Date.now(),
      inputs,
      children: [],
    });
  }

  async handleChainEnd(outputs: Record<string, unknown>, runId: string): Promise<void> {
    this.completeRun(runId, outputs);
  }

  async handleChainError(err: any, runId: string): Promise<void> {
    this.completeRun(runId, undefined, err?.message ?? String(err));
  }

  // --- Agent Events ---
  async handleAgentAction(action: AgentAction, runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.outputs = { ...run.outputs, action };
    }
  }

  async handleAgentEnd(action: AgentFinish, runId: string): Promise<void> {
    this.completeRun(runId, { finish: action });
  }

  // --- Utility to Save Trace ---
  async saveTrace(): Promise<void> {
    try {
      const traceData = {
        sessionId: this.sessionId,
        agentName: this.agentName,
        timestamp: new Date().toISOString(),
        traces: this.rootRuns,
      };
      
      const fileName = `logs/trace_${this.agentName}_${Date.now()}.json`;
      await workspaceManager.writeArtifact(
        this.tenantId,
        this.userId,
        this.sessionId,
        fileName,
        JSON.stringify(traceData, null, 2)
      );
      
      logger.info(`[WorkspaceTrace] Saved execution trace to ${fileName} for session ${this.sessionId}`);
    } catch (err) {
      logger.error(`[WorkspaceTrace] Failed to save trace: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
