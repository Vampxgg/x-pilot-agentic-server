import { describe, it, expect } from "vitest";
import { taskExecutor } from "../../src/core/task-executor.js";

describe("TaskExecutor", () => {
  it("should submit and complete a task", async () => {
    const task = await taskExecutor.submit(
      "test-agent",
      "test task",
      async () => "result-value",
    );

    expect(task.id).toBeTruthy();
    expect(["pending", "running", "completed"]).toContain(task.status);

    const completed = await taskExecutor.waitForTask(task.id, 100, 5_000);
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("result-value");
  });

  it("should handle failed tasks", async () => {
    const task = await taskExecutor.submit(
      "test-agent",
      "failing task",
      async () => { throw new Error("boom"); },
    );

    const completed = await taskExecutor.waitForTask(task.id, 100, 5_000);
    expect(completed.status).toBe("failed");
    expect(completed.error).toContain("boom");
  });

  it("should run parallel tasks", async () => {
    const tasks = await taskExecutor.submitParallel([
      { agentName: "a", instruction: "t1", executor: async () => 1 },
      { agentName: "b", instruction: "t2", executor: async () => 2 },
      { agentName: "c", instruction: "t3", executor: async () => 3 },
    ]);

    expect(tasks.length).toBe(3);

    const results = await taskExecutor.waitForAll(
      tasks.map((t) => t.id),
      5_000,
    );

    expect(results.every((r) => r.status === "completed")).toBe(true);
  });

  it("should track task stats", () => {
    const stats = taskExecutor.getStats();
    expect(stats).toHaveProperty("pending");
    expect(stats).toHaveProperty("running");
    expect(stats).toHaveProperty("completed");
    expect(stats).toHaveProperty("failed");
  });
});
