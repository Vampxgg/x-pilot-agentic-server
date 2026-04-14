import PQueue from "p-queue";
import { randomUUID } from "node:crypto";
import type { TaskRecord, TaskStatus } from "./types.js";
import { logger } from "../utils/logger.js";

class TaskExecutor {
  private queue: PQueue;
  private tasks = new Map<string, TaskRecord>();

  constructor(concurrency = 10) {
    this.queue = new PQueue({ concurrency });
  }

  async submit<T>(
    agentName: string,
    instruction: string,
    executor: () => Promise<T>,
    parentTaskId?: string,
  ): Promise<TaskRecord> {
    const task: TaskRecord = {
      id: randomUUID(),
      agentName,
      parentTaskId,
      instruction,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    this.tasks.set(task.id, task);
    logger.info(`Task submitted: ${task.id} for agent ${agentName}`);

    this.queue.add(async () => {
      task.status = "running";
      task.startedAt = new Date().toISOString();
      this.tasks.set(task.id, { ...task });

      try {
        const result = await executor();
        task.status = "completed";
        task.result = result;
        task.completedAt = new Date().toISOString();
        logger.info(`Task completed: ${task.id}`);
      } catch (err) {
        task.status = "failed";
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = new Date().toISOString();
        logger.error(`Task failed: ${task.id} - ${task.error}`);
      }

      this.tasks.set(task.id, { ...task });
    });

    return task;
  }

  async submitParallel<T>(
    items: Array<{
      agentName: string;
      instruction: string;
      executor: () => Promise<T>;
    }>,
    parentTaskId?: string,
  ): Promise<TaskRecord[]> {
    const tasks = items.map((item) =>
      this.submit(item.agentName, item.instruction, item.executor, parentTaskId),
    );
    return Promise.all(tasks);
  }

  async waitForTask(taskId: string, pollIntervalMs = 500, timeoutMs = 300_000): Promise<TaskRecord> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        return task;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(`Task ${taskId} timed out after ${timeoutMs}ms`);
  }

  async waitForAll(taskIds: string[], timeoutMs = 300_000): Promise<TaskRecord[]> {
    return Promise.all(taskIds.map((id) => this.waitForTask(id, 500, timeoutMs)));
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  getTasksByParent(parentTaskId: string): TaskRecord[] {
    return Array.from(this.tasks.values()).filter((t) => t.parentTaskId === parentTaskId);
  }

  getTasksByAgent(agentName: string): TaskRecord[] {
    return Array.from(this.tasks.values()).filter((t) => t.agentName === agentName);
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "pending") return false;
    task.status = "cancelled";
    task.completedAt = new Date().toISOString();
    this.tasks.set(taskId, { ...task });
    return true;
  }

  getStats(): { pending: number; running: number; completed: number; failed: number } {
    const tasks = Array.from(this.tasks.values());
    return {
      pending: tasks.filter((t) => t.status === "pending").length,
      running: tasks.filter((t) => t.status === "running").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
    };
  }
}

export const taskExecutor = new TaskExecutor();
