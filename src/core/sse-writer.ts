import type { ServerResponse } from "node:http";
import type { StreamEvent, StreamEventTypeName } from "./types.js";
import { createPing, type StreamContext } from "./stream-protocol.js";
import { logger } from "../utils/logger.js";

const DEFAULT_HEARTBEAT_MS = 15_000;
const PROTOCOL_VERSION = "2.0";

export interface SSEWriterOptions {
  taskId: string;
  sessionId: string;
  heartbeatMs?: number;
}

/**
 * Unified SSE writer that handles:
 * - Standard SSE format (event: / id: / data:)
 * - Auto-incrementing sequence IDs
 * - Heartbeat (ping every N seconds)
 * - Client disconnect detection
 * - `done` event on close
 */
export class SSEWriter {
  private seq = 0;
  private closed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ctx: StreamContext;
  private readonly raw: ServerResponse;

  private constructor(raw: ServerResponse, opts: SSEWriterOptions) {
    this.raw = raw;
    this.ctx = { taskId: opts.taskId, sessionId: opts.sessionId };

    const origin = raw.req?.headers?.origin;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Stream-Protocol": PROTOCOL_VERSION,
      "X-Task-Id": opts.taskId,
      "X-Session-Id": opts.sessionId,
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

  static create(raw: ServerResponse, opts: SSEWriterOptions): SSEWriter {
    return new SSEWriter(raw, opts);
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  get streamContext(): StreamContext {
    return this.ctx;
  }

  write<T extends StreamEventTypeName>(event: StreamEvent<T>): boolean {
    if (this.closed) return false;

    const stamped = { ...event, id: ++this.seq };

    try {
      this.raw.write(`event: ${stamped.event}\nid: ${stamped.id}\ndata: ${JSON.stringify(stamped)}\n\n`);
      return true;
    } catch (err) {
      logger.warn(`[SSEWriter] Write failed (task=${this.ctx.taskId}): ${err}`);
      this.closed = true;
      this.stopHeartbeat();
      return false;
    }
  }

  end(): void {
    this.stopHeartbeat();
    if (!this.closed) {
      this.closed = true;
      try {
        this.raw.end();
      } catch {
        // already closed
      }
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) {
        this.stopHeartbeat();
        return;
      }
      this.write(createPing(this.ctx) as StreamEvent<StreamEventTypeName>);
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
