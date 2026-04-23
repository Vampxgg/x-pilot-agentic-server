import { StateGraph, END, START } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  AgentDefinition,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowNode,
  WorkflowEdge,
  WorkflowStrategy,
} from "./types.js";
import {
  AgentState,
  type AgentGraphState,
  type ToolEventCallback,
  createPerceiveNode,
  createThinkNode,
  createActNode,
  createObserveNode,
  createReflectNode,
  routeAfterThink,
  routeAfterObserve,
  createNudgeNode,
} from "./agent-graph.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Node factory: maps (type, step) → LangGraph node implementation
// ---------------------------------------------------------------------------

type NodeFactory = (
  agentDef: AgentDefinition,
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  toolEventCb?: ToolEventCallback,
) => (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;

const PHASE_FACTORIES: Record<string, NodeFactory> = {
  perceive: (agentDef) => createPerceiveNode(agentDef),
  think: (_agentDef, model, tools) => createThinkNode(model, tools),
  act: (_agentDef, _model, tools, toolEventCb) => createActNode(tools, toolEventCb),
  observe: () => createObserveNode(),
  nudge: () => createNudgeNode(),
  reflect: (_agentDef, model) => createReflectNode(model),
};

// ---------------------------------------------------------------------------
// Condition registry: maps condition name → routing function
// ---------------------------------------------------------------------------

interface ConditionalTarget {
  condition: string;
  target: string;
}

function buildConditionalRouter(
  targets: ConditionalTarget[],
  defaultTarget: string,
): (state: AgentGraphState) => string {
  return (state: AgentGraphState) => {
    for (const { condition, target } of targets) {
      switch (condition) {
        case "has_tool_calls":
          if (routeAfterThink(state) === "act") return target;
          break;
        case "no_tool_calls": {
          const thinkRoute = routeAfterThink(state);
          if (thinkRoute === "reflect" || thinkRoute === "nudge") return target;
          break;
        }
        case "needs_nudge":
          if (routeAfterThink(state) === "nudge") return target;
          break;
        case "continue_iteration":
          if (routeAfterObserve(state) === "think") return target;
          break;
        case "should_exit":
          if (routeAfterObserve(state) === "reflect") return target;
          break;
        case "always":
          return target;
        default:
          logger.warn(`Unknown condition: ${condition}, skipping`);
      }
    }
    return defaultTarget;
  };
}

// ---------------------------------------------------------------------------
// Graph builder for ReAct strategy
// ---------------------------------------------------------------------------

function buildReactGraph(
  agentDef: AgentDefinition,
  graph: WorkflowGraph,
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  toolEventCb?: ToolEventCallback,
): StateGraph<typeof AgentState.State, Partial<typeof AgentState.State>, typeof AgentState.Update> {
  const sg = new StateGraph(AgentState);

  const nodeNameMap = new Map<string, string>();

  for (const node of graph.nodes) {
    if (node.type === "start" || node.type === "end") continue;

    if (node.type === "phase" && node.data.step) {
      const factory = PHASE_FACTORIES[node.data.step];
      if (!factory) {
        logger.warn(`No factory for phase step: ${node.data.step}`);
        continue;
      }
      const graphNodeName = node.data.step;
      nodeNameMap.set(node.id, graphNodeName);
      sg.addNode(graphNodeName, factory(agentDef, model, tools, toolEventCb));
    }
  }

  for (const edge of graph.edges) {
    const source = edge.source === "_start" ? START : (nodeNameMap.get(edge.source) ?? edge.source);
    const target = edge.target === "_end" ? END : (nodeNameMap.get(edge.target) ?? edge.target);

    if (edge.data.type === "sequential") {
      sg.addEdge(source as typeof START, target as typeof END);
    }
  }

  const conditionalSources = new Map<string, ConditionalTarget[]>();
  for (const edge of graph.edges) {
    if (edge.data.type === "conditional" || edge.data.type === "cycle") {
      const source = nodeNameMap.get(edge.source) ?? edge.source;
      const target = edge.target === "_end" ? END : (nodeNameMap.get(edge.target) ?? edge.target);
      const condition = edge.data.condition ?? "always";

      if (!conditionalSources.has(source)) {
        conditionalSources.set(source, []);
      }
      conditionalSources.get(source)!.push({ condition, target });
    }
  }

  for (const [source, targets] of conditionalSources) {
    const allTargets = targets.map((t) => t.target);
    const defaultTarget = allTargets[allTargets.length - 1] ?? END;
    const router = buildConditionalRouter(targets, defaultTarget);
    sg.addConditionalEdges(source as typeof START, router);
  }

  return sg;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class WorkflowEngine {
  static build(
    agentDef: AgentDefinition,
    workflow: WorkflowDefinition,
    model: BaseChatModel,
    tools: StructuredToolInterface[],
    toolEventCb?: ToolEventCallback,
    mode?: string,
  ): StateGraph<typeof AgentState.State, Partial<typeof AgentState.State>, typeof AgentState.Update> {
    const resolvedStrategy = WorkflowEngine.resolveStrategy(workflow, mode);
    const resolvedGraph = WorkflowEngine.resolveGraph(workflow, mode);

    if (!resolvedGraph) {
      throw new Error(
        `No graph found in workflow for agent ${workflow.agent.id}` +
        (mode ? ` (mode: ${mode})` : ""),
      );
    }

    logger.info(
      `[WorkflowEngine] Building graph for ${workflow.agent.id}: ` +
      `strategy=${resolvedStrategy}, nodes=${resolvedGraph.nodes.length}, edges=${resolvedGraph.edges.length}` +
      (mode ? `, mode=${mode}` : ""),
    );

    switch (resolvedStrategy) {
      case "react":
        return buildReactGraph(agentDef, resolvedGraph, model, tools, toolEventCb);

      case "pipeline":
        logger.warn(`[WorkflowEngine] Pipeline strategy graph building not yet implemented, falling back to react`);
        return buildReactGraph(agentDef, resolvedGraph, model, tools, toolEventCb);

      case "dual": {
        const defaultMode = WorkflowEngine.getDefaultMode(workflow);
        return WorkflowEngine.build(agentDef, workflow, model, tools, toolEventCb, defaultMode);
      }

      case "custom":
        logger.warn(`[WorkflowEngine] Custom strategy not yet implemented, falling back to react`);
        return buildReactGraph(agentDef, resolvedGraph, model, tools, toolEventCb);

      default:
        return buildReactGraph(agentDef, resolvedGraph, model, tools, toolEventCb);
    }
  }

  static resolveStrategy(workflow: WorkflowDefinition, mode?: string): WorkflowStrategy {
    if (mode && workflow.modes) {
      const modeValue = workflow.modes[mode];
      if (typeof modeValue === "object" && modeValue.strategy) {
        return modeValue.strategy;
      }
    }
    return workflow.agent.strategy;
  }

  static resolveGraph(workflow: WorkflowDefinition, mode?: string): WorkflowGraph | undefined {
    if (mode && workflow.modes) {
      const modeValue = workflow.modes[mode];
      if (typeof modeValue === "object" && modeValue.graph) {
        return modeValue.graph;
      }
    }
    return workflow.graph;
  }

  static getDefaultMode(workflow: WorkflowDefinition): string | undefined {
    if (!workflow.modes) return undefined;
    const defaultEntry = workflow.modes["default"];
    if (typeof defaultEntry === "string") return defaultEntry;
    return undefined;
  }
}
