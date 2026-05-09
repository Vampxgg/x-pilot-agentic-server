import { registerPipelineHandler } from "../../../src/core/pipeline-executor.js";
import { routeRegistry } from "../../../src/api/route-registry.js";
import { dynamicToolRegistry } from "../../../src/tools/dynamic-tool-registry.js";
import { registerInteractiveTutorialRoutes } from "./routes.js";
import { assembleApp, reassembleApp, saveBlueprint, researchWithCache } from "./handlers.js";
import { createReassembleAppTool, createStartGenerationPipelineTool } from "./tools.js";
import { createUserFileTool } from "./tools-user-file.js";

export function register(): void {
  registerPipelineHandler("saveBlueprint", saveBlueprint);
  registerPipelineHandler("assembleApp", assembleApp);
  registerPipelineHandler("reassembleApp", reassembleApp);
  registerPipelineHandler("researchWithCache", researchWithCache);

  dynamicToolRegistry.register("reassemble_app", createReassembleAppTool);
  dynamicToolRegistry.register("start_generation_pipeline", createStartGenerationPipelineTool);
  dynamicToolRegistry.register("tutorial_user_file", createUserFileTool);

  routeRegistry.register("interactive-tutorial", registerInteractiveTutorialRoutes);
}
