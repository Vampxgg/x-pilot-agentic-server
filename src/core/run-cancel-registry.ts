import { logger } from "../utils/logger.js";

interface RunningRunEntry {
  abort: AbortController;
  tenantId: string;
  userId: string;
  startedAt: number;
}

type CancelResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "forbidden" };

const CLEANUP_INTERVAL_MS = 60_000;
const MAX_AGE_MS = 30 * 60 * 1000;

class RunningRunRegistry {
  private runs = new Map<string, RunningRunEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  register(runId: string, info: { abort: AbortController; tenantId: string; userId: string }): void {
    this.runs.set(runId, { ...info, startedAt: Date.now() });
    logger.debug(`[RunRegistry] Registered run: ${runId}`);
  }

  cancel(runId: string, userId: string): CancelResult {
    const entry = this.runs.get(runId);
    if (!entry) return { ok: false, reason: "not_found" };
    if (entry.userId !== userId) return { ok: false, reason: "forbidden" };

    entry.abort.abort();
    logger.info(`[RunRegistry] Cancelled run: ${runId}`);
    return { ok: true };
  }

  unregister(runId: string): void {
    this.runs.delete(runId);
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [runId, entry] of this.runs) {
      if (now - entry.startedAt > MAX_AGE_MS) {
        this.runs.delete(runId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[RunRegistry] Cleaned up ${cleaned} stale run(s)`);
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.runs.clear();
  }
}

export const runningRunRegistry = new RunningRunRegistry();
