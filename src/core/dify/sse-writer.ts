// src/core/dify/sse-writer.ts
import type { ServerResponse } from "node:http";
import type { StreamEvent, StreamEventTypeName, WorkflowDefinition } from "../types.js";
import { DifyStreamAdapter } from "./stream-adapter.js";
import { logger } from "../../utils/logger.js";

const DEFAULT_HEARTBEAT_MS = 15_000;

export interface DifySSEWriterOptions {
  taskId: string; // native task_id
  sessionId: string; // native session_id
  heartbeatMs?: number;
  inputs?: Record<string, unknown>;
  query?: string;
  userId?: string;
  tenantId?: string;
  modelName?: string;
  workflow?: WorkflowDefinition;
  hideThinkOutput?: boolean;
}

export class DifySSEWriter {
  private seq = 0;
  private closed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly adapter: DifyStreamAdapter;
  private readonly raw: ServerResponse;

  private constructor(raw: ServerResponse, opts: DifySSEWriterOptions) {
    this.raw = raw;
    this.adapter = new DifyStreamAdapter(opts.sessionId, opts.taskId, {
      inputs: opts.inputs,
      query: opts.query,
      userId: opts.userId,
      tenantId: opts.tenantId,
      modelName: opts.modelName,
      hideThinkOutput: opts.hideThinkOutput,
    }, opts.workflow);

    const origin = raw.req?.headers?.origin;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Stream-Protocol": "dify",
      "X-Task-Id": this.adapter.difyTaskId,
      "X-Conversation-Id": this.adapter.conversationId,
      ...(origin && {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
      }),
    });

    raw.on("close", () => {
      this.closed = true;
      this.stopHeartbeat();
    });

    this.startHeartbeat(opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  }

  static create(raw: ServerResponse, opts: DifySSEWriterOptions): DifySSEWriter {
    return new DifySSEWriter(raw, opts);
  }

  get isOpen(): boolean {
    return !this.closed;
  }
  get difyTaskId(): string {
    return this.adapter.difyTaskId;
  }
  get streamContext(): { taskId: string; sessionId: string } {
    return {
      taskId: this.adapter.conversationId,
      sessionId: this.adapter.conversationId,
    };
    // Note: streamContext is kept for interface compat but values come from adapter
  }

  write<T extends StreamEventTypeName>(event: StreamEvent<T>): boolean {
    if (this.closed) return false;
    const difyEvents = this.adapter.transform(event);
    for (const de of difyEvents) {
      try {
        const id = ++this.seq;
        if (de.event === "ping") {
          this.raw.write(`event: ping\nid: ${id}\ndata: \n\n`);
        } else {
          this.raw.write(
            `event: ${de.event}\nid: ${id}\ndata: ${JSON.stringify(de)}\n\n`,
          );
        }
      } catch (err) {
        logger.warn(
          `[DifySSEWriter] Write failed (task=${this.adapter.difyTaskId}): ${err}`,
        );
        this.closed = true;
        this.stopHeartbeat();
        return false;
      }
    }
    return true;
  }

  end(): void {
    this.stopHeartbeat();
    if (!this.closed) {
      this.closed = true;
      try {
        this.raw.end();
      } catch {
        /* already closed */
      }
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) {
        this.stopHeartbeat();
        return;
      }
      try {
        this.raw.write(`event: ping\ndata: \n\n`);
      } catch {
        this.closed = true;
        this.stopHeartbeat();
      }
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
