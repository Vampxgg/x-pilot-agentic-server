import { loadConfig } from "./utils/config.js";
import { logger } from "./utils/logger.js";
import { agentRegistry } from "./core/agent-registry.js";
import { startServer } from "./api/server.js";
import { HeartbeatRunner } from "./evolution/heartbeat.js";
import { getModelByName } from "./llm/model-router.js";

let heartbeatRunner: HeartbeatRunner | null = null;

async function main() {
  logger.info("Starting X-Pilot Agentic Server...");

  const config = loadConfig();
  logger.info(`Environment: ${process.env.NODE_ENV ?? "development"}`);

  await agentRegistry.initialize();

  const agents = agentRegistry.list();
  logger.info(`Agents loaded: ${agents.join(", ") || "(none)"}`);

  // Start heartbeat for all agents that have it enabled
  const heartbeatModel = getModelByName(config.agents.defaults.workerModel ?? "gpt-4o-mini");
  heartbeatRunner = new HeartbeatRunner(heartbeatModel);

  for (const agentDef of agentRegistry.getAll()) {
    heartbeatRunner.start(agentDef);
  }

  await startServer();

  const shutdown = () => {
    logger.info("Shutting down...");
    heartbeatRunner?.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { heartbeatRunner };

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
