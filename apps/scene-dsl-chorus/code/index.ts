/**
 * scene-dsl-chorus 应用模块（与 interactive-tutorial-v2 完全隔离）。
 */

import { registerPipelineHandler } from "../../../src/core/pipeline-executor.js";
import { routeRegistry } from "../../../src/api/route-registry.js";
import { dynamicToolRegistry } from "../../../src/tools/dynamic-tool-registry.js";

import {
  chorusFuseFacets,
  chorusSaveSkeleton,
  chorusMergeFragments,
  chorusValidateDsl,
  chorusPublishDsl,
} from "./chorus/handlers.js";
import { createStartChorusPipelineTool } from "./tools.js";
import { registerSceneDslChorusRoutes } from "./routes.js";

export function register(): void {
  registerPipelineHandler("chorusFuseFacets", chorusFuseFacets);
  registerPipelineHandler("chorusSaveSkeleton", chorusSaveSkeleton);
  registerPipelineHandler("chorusMergeFragments", chorusMergeFragments);
  registerPipelineHandler("chorusValidateDsl", chorusValidateDsl);
  registerPipelineHandler("chorusPublishDsl", chorusPublishDsl);

  dynamicToolRegistry.register("start_chorus_pipeline", createStartChorusPipelineTool);

  routeRegistry.register("scene-dsl-chorus", registerSceneDslChorusRoutes);
}
