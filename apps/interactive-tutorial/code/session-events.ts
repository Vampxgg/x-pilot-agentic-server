import type { AgentEvent } from "../../../src/core/event-bus.js";
import { eventBus } from "../../../src/core/event-bus.js";
import { createProgress, type StreamContext } from "../../../src/core/stream-protocol.js";
import type { StreamEvent, StreamEventTypeName } from "../../../src/core/types.js";

export interface SessionProgressPayload {
  message: string;
  phase?: string;
  stage?: string;
  percentage?: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TimelineEntry {
  ts: string;
  stage?: string;
  phase?: string;
  message?: string;
  url?: string;
  durationMs?: number;
  count?: number;
  successCount?: number;
}

export function emitSessionProgress(
  sessionId: string,
  sourceAgent: string,
  payload: SessionProgressPayload,
): void {
  eventBus.emit({
    type: "progress",
    sourceAgent,
    sessionId,
    data: payload,
    timestamp: new Date().toISOString(),
  });
}

export function agentEventToStreamEvent(
  ctx: StreamContext,
  event: AgentEvent,
): StreamEvent<"progress"> | null {
  if (event.type !== "progress") return null;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const message = typeof data.message === "string" ? data.message : null;
  if (!message) return null;

  const { message: _message, phase, percentage, ...metadata } = data;
  return createProgress(ctx, message, {
    phase: typeof phase === "string" ? phase : undefined,
    percentage: typeof percentage === "number" ? percentage : undefined,
    metadata: {
      sourceAgent: event.sourceAgent,
      timestamp: event.timestamp,
      ...metadata,
    },
  });
}

export function subscribeSessionProgress(
  sessionId: string,
  onProgress: (event: AgentEvent) => void,
): () => void {
  const handler = (event: AgentEvent) => {
    if (event.type === "progress") onProgress(event);
  };
  eventBus.onSession(sessionId, handler);
  return () => eventBus.offSession(sessionId, handler);
}

export async function collectSessionTimeline<T>(
  sessionId: string,
  run: () => Promise<T>,
): Promise<{ result: T; timeline: TimelineEntry[]; firstPreviewMs: number | null; previewUrl: string | null }> {
  const startedAt = Date.now();
  const timeline: TimelineEntry[] = [];
  let previewUrl: string | null = null;
  let firstPreviewMs: number | null = null;

  const unsubscribe = subscribeSessionProgress(sessionId, (event) => {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const entry: TimelineEntry = {
      ts: event.timestamp,
      stage: typeof data.stage === "string" ? data.stage : undefined,
      phase: typeof data.phase === "string" ? data.phase : undefined,
      message: typeof data.message === "string" ? data.message : undefined,
      url: typeof data.url === "string" ? data.url : undefined,
      durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
      count: typeof data.count === "number" ? data.count : undefined,
      successCount: typeof data.successCount === "number" ? data.successCount : undefined,
    };
    timeline.push(entry);
    if (entry.stage === "preview_ready" && entry.url && !previewUrl) {
      previewUrl = entry.url;
      firstPreviewMs = Date.now() - startedAt;
    }
    if (timeline.length > 200) timeline.splice(0, timeline.length - 200);
  });

  try {
    const result = await run();
    return { result, timeline, firstPreviewMs, previewUrl };
  } finally {
    unsubscribe();
  }
}
