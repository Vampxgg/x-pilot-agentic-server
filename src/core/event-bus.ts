import { EventEmitter } from "node:events";
import { logger } from "../utils/logger.js";

export interface AgentEvent {
  type: "task_complete" | "task_failed" | "artifact_created" | "agent_started" | "agent_failed" | "progress" | "custom";
  sourceAgent: string;
  sessionId: string;
  data: unknown;
  timestamp: string;
}

type EventHandler = (event: AgentEvent) => void;

class AgentEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: AgentEvent): void {
    logger.debug(`Event emitted: [${event.type}] from ${event.sourceAgent} session=${event.sessionId}`);
    this.emitter.emit("agent_event", event);
    this.emitter.emit(`type:${event.type}`, event);
    this.emitter.emit(`session:${event.sessionId}`, event);
    this.emitter.emit(`agent:${event.sourceAgent}`, event);
  }

  on(eventType: string, handler: EventHandler): void {
    this.emitter.on(`type:${eventType}`, handler);
  }

  onSession(sessionId: string, handler: EventHandler): void {
    this.emitter.on(`session:${sessionId}`, handler);
  }

  onAgent(agentName: string, handler: EventHandler): void {
    this.emitter.on(`agent:${agentName}`, handler);
  }

  onAll(handler: EventHandler): void {
    this.emitter.on("agent_event", handler);
  }

  off(eventType: string, handler: EventHandler): void {
    this.emitter.off(`type:${eventType}`, handler);
  }

  offSession(sessionId: string, handler: EventHandler): void {
    this.emitter.off(`session:${sessionId}`, handler);
  }

  offAll(handler: EventHandler): void {
    this.emitter.off("agent_event", handler);
  }

  removeAllSessionListeners(sessionId: string): void {
    this.emitter.removeAllListeners(`session:${sessionId}`);
  }

  emitTaskComplete(sourceAgent: string, sessionId: string, result: unknown): void {
    this.emit({
      type: "task_complete",
      sourceAgent,
      sessionId,
      data: result,
      timestamp: new Date().toISOString(),
    });
  }

  emitTaskFailed(sourceAgent: string, sessionId: string, error: string): void {
    this.emit({
      type: "task_failed",
      sourceAgent,
      sessionId,
      data: { error },
      timestamp: new Date().toISOString(),
    });
  }

  emitArtifactCreated(sourceAgent: string, sessionId: string, artifactName: string): void {
    this.emit({
      type: "artifact_created",
      sourceAgent,
      sessionId,
      data: { artifact: artifactName },
      timestamp: new Date().toISOString(),
    });
  }

  emitAgentStarted(sourceAgent: string, sessionId: string): void {
    this.emit({
      type: "agent_started",
      sourceAgent,
      sessionId,
      data: {},
      timestamp: new Date().toISOString(),
    });
  }

  emitProgress(sourceAgent: string, sessionId: string, message: string, progress?: number): void {
    this.emit({
      type: "progress",
      sourceAgent,
      sessionId,
      data: { message, progress },
      timestamp: new Date().toISOString(),
    });
  }
}

export const eventBus = new AgentEventBus();
