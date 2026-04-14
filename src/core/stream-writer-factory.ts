// src/core/stream-writer-factory.ts
import type { ServerResponse } from "node:http";
import type { StreamEvent, StreamEventTypeName, WorkflowDefinition } from "./types.js";
import { SSEWriter } from "./sse-writer.js";
import { DifySSEWriter } from "./dify/sse-writer.js";
import { runningStreamRegistry } from "./dify/stream-registry.js";

export interface UnifiedStreamWriter {
  readonly isOpen: boolean;
  readonly streamContext: { taskId: string; sessionId: string };
  write<T extends StreamEventTypeName>(event: StreamEvent<T>): boolean;
  end(): void;
  /** Only set in dify mode */
  readonly difyTaskId?: string;
  /** AbortSignal for stop support (dify mode only) */
  readonly abortSignal?: AbortSignal;
}

export interface StreamWriterOptions {
  taskId: string;
  sessionId: string;
  userId?: string;
  inputs?: Record<string, unknown>;
  query?: string;
  tenantId?: string;
  modelName?: string;
  workflow?: WorkflowDefinition;
  hideThinkOutput?: boolean;
}

export function createStreamWriter(
  raw: ServerResponse,
  opts: StreamWriterOptions,
): UnifiedStreamWriter {
  const protocol = process.env.STREAM_PROTOCOL ?? "native";

  if (protocol === "dify") {
    const writer = DifySSEWriter.create(raw, {
      taskId: opts.taskId,
      sessionId: opts.sessionId,
      inputs: opts.inputs,
      query: opts.query,
      userId: opts.userId,
      tenantId: opts.tenantId,
      modelName: opts.modelName,
      workflow: opts.workflow,
      hideThinkOutput: opts.hideThinkOutput,
    });

    let abortController: AbortController | undefined;
    if (opts.userId) {
      abortController = new AbortController();
      runningStreamRegistry.register(writer.difyTaskId, {
        abort: abortController,
        conversationId: opts.sessionId,
        messageId: opts.taskId,
        userId: opts.userId,
      });
    }

    return {
      get isOpen() {
        return writer.isOpen;
      },
      get streamContext() {
        return { taskId: opts.taskId, sessionId: opts.sessionId };
      },
      write: <T extends StreamEventTypeName>(event: StreamEvent<T>) =>
        writer.write(event),
      end: () => {
        runningStreamRegistry.unregister(writer.difyTaskId);
        writer.end();
      },
      get difyTaskId() {
        return writer.difyTaskId;
      },
      get abortSignal() {
        return abortController?.signal;
      },
    };
  }

  // Native mode
  const writer = SSEWriter.create(raw, opts);
  return {
    get isOpen() {
      return writer.isOpen;
    },
    get streamContext() {
      return writer.streamContext;
    },
    write: <T extends StreamEventTypeName>(event: StreamEvent<T>) =>
      writer.write(event),
    end: () => writer.end(),
  };
}
