/**
 * v2 应用模块入口。
 *
 * 由 src/core/agent-loader.ts 的 loadAppModules 在启动时自动 import 并调用 register()。
 *
 * v2 完全独立于 v1：
 *  - 不导入 apps/interactive-tutorial 的任何文件
 *  - workspace 子目录不同（data/dsl-tutorials/）
 *  - API 前缀不同（/api/business/interactive-tutorial-v2/*）
 *  - dynamic tool 名字不同（start_dsl_pipeline / apply_dsl_patch / hot_reload_runtime）
 *  - agent 名字带 v2 前缀全局唯一
 */

import { registerPipelineHandler } from "../../../src/core/pipeline-executor.js";
import { routeRegistry } from "../../../src/api/route-registry.js";
import { dynamicToolRegistry } from "../../../src/tools/dynamic-tool-registry.js";

import {
  saveDslSkeleton,
  mergeDslFragmentsHandler,
  validateDslHandler,
  publishDslHandler,
} from "./handlers.js";
import {
  createStartDslPipelineTool,
  createApplyDslPatchTool,
  createHotReloadRuntimeTool,
} from "./tools.js";
import { registerInteractiveTutorialV2Routes } from "./routes.js";

export function register(): void {
  // pipeline handlers（与 yaml.pipeline.steps 里的 handler: xxx 字段一一对应）
  registerPipelineHandler("saveDslSkeleton", saveDslSkeleton);
  registerPipelineHandler("mergeDslFragments", mergeDslFragmentsHandler);
  registerPipelineHandler("validateDsl", validateDslHandler);
  registerPipelineHandler("publishDsl", publishDslHandler);

  // dynamic tools（agent.config.yaml 里 allowedTools 引用）
  dynamicToolRegistry.register("start_dsl_pipeline", createStartDslPipelineTool);
  dynamicToolRegistry.register("apply_dsl_patch", createApplyDslPatchTool);
  dynamicToolRegistry.register("hot_reload_runtime", createHotReloadRuntimeTool);

  // routes
  routeRegistry.register("interactive-tutorial-v2", registerInteractiveTutorialV2Routes);
}
