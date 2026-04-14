import type { MemoryEntry, WorkingMemory } from "../core/types.js";

export function createWorkingMemory(): WorkingMemory {
  return {
    facts: [],
    context: "",
    shortTermLog: [],
  };
}

export function addMemoryEntry(memory: WorkingMemory, entry: Omit<MemoryEntry, "timestamp">): WorkingMemory {
  return {
    ...memory,
    shortTermLog: [
      ...memory.shortTermLog,
      { ...entry, timestamp: new Date().toISOString() },
    ],
  };
}

export function updateContext(memory: WorkingMemory, context: string): WorkingMemory {
  return { ...memory, context };
}

export function addFact(memory: WorkingMemory, fact: string): WorkingMemory {
  if (memory.facts.includes(fact)) return memory;
  return { ...memory, facts: [...memory.facts, fact] };
}

export function summarizeWorkingMemory(memory: WorkingMemory): string {
  const parts: string[] = [];

  if (memory.context) {
    parts.push(`## Context\n${memory.context}`);
  }

  if (memory.facts.length > 0) {
    parts.push(`## Facts\n${memory.facts.map((f) => `- ${f}`).join("\n")}`);
  }

  if (memory.shortTermLog.length > 0) {
    const recentLogs = memory.shortTermLog.slice(-20);
    parts.push(
      `## Recent Activity\n${recentLogs.map((l) => `[${l.type}] ${l.content}`).join("\n")}`,
    );
  }

  return parts.join("\n\n");
}
