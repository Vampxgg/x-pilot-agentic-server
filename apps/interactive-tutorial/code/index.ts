import { registerPipelineHandler } from "../../../src/core/pipeline-executor.js";
import { routeRegistry } from "../../../src/api/route-registry.js";
import { dynamicToolRegistry } from "../../../src/tools/dynamic-tool-registry.js";
import { registerInteractiveTutorialRoutes } from "./routes.js";
import { assembleApp, reassembleApp, saveBlueprint } from "./handlers.js";
import { createReassembleAppTool, createStartGenerationPipelineTool } from "./tools.js";

export function register(): void {
  registerPipelineHandler("saveBlueprint", saveBlueprint);
  registerPipelineHandler("assembleApp", assembleApp);
  registerPipelineHandler("reassembleApp", reassembleApp);

  dynamicToolRegistry.register("reassemble_app", createReassembleAppTool);
  dynamicToolRegistry.register("start_generation_pipeline", createStartGenerationPipelineTool);

  routeRegistry.register("interactive-tutorial", registerInteractiveTutorialRoutes);
}
