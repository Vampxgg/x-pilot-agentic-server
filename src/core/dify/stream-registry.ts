// src/core/dify/stream-registry.ts
import { logger } from "../../utils/logger.js";

interface StreamEntry {
  abort: AbortController;
  conversationId: string;
  messageId: string;
  userId: string;
  startedAt: number;
}

const CLEANUP_INTERVAL_MS = 60_000;
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

class RunningStreamRegistry {
  private streams = new Map<string, StreamEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  register(difyTaskId: string, info: {
    abort: AbortController;
    conversationId: string;
    messageId: string;
    userId: string;
  }): void {
    this.streams.set(difyTaskId, { ...info, startedAt: Date.now() });
    logger.debug(`[StreamRegistry] Registered stream: ${difyTaskId}`);
  }

  stop(difyTaskId: string, userId: string): boolean {
    const entry = this.streams.get(difyTaskId);
    if (!entry) return false;
    if (entry.userId !== userId) return false;
    entry.abort.abort();
    this.streams.delete(difyTaskId);
    logger.info(`[StreamRegistry] Stopped stream: ${difyTaskId}`);
    return true;
  }

  unregister(difyTaskId: string): void {
    this.streams.delete(difyTaskId);
  }

  has(difyTaskId: string): boolean {
    return this.streams.has(difyTaskId);
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, entry] of this.streams) {
      if (now - entry.startedAt > MAX_AGE_MS) {
        this.streams.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[StreamRegistry] Cleaned up ${cleaned} stale entries`);
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.streams.clear();
  }
}

export const runningStreamRegistry = new RunningStreamRegistry();
