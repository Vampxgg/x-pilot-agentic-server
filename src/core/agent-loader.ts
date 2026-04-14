import { readdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { readMarkdownContent } from "../utils/md-parser.js";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import type {
  AgentDefinition,
  AgentConfig,
  AgentPromptFiles,
  SkillDefinition,
  WorkflowDefinition,
  WorkflowNode,
} from "./types.js";

const PROMPT_FILE_MAP: Record<string, keyof AgentPromptFiles> = {
  "IDENTITY.md": "identity",
  "SOUL.md": "soul",
  "MISSION.md": "mission",
  "TOOLS.md": "tools",
  "BOOTSTRAP.md": "bootstrap",
  "HEARTBEAT.md": "heartbeat",
};

function loadAgentConfig(folderPath: string): AgentConfig {
  const configPath = join(folderPath, "agent.config.yaml");
  const defaults = getConfig().agents.defaults;

  const base: AgentConfig = {
    model: defaults.model,
    workerModel: defaults.workerModel,
    fallbackModels: defaults.fallbackModels,
    maxTokens: defaults.maxTokens,
    maxConcurrency: defaults.maxConcurrency,
    allowedTools: defaults.allowedTools ?? ["*"],
    heartbeat: { ...defaults.heartbeat },
    evolution: { ...defaults.evolution },
    timeout: defaults.timeout,
  };

  if (!existsSync(configPath)) return base;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<AgentConfig>;
    return {
      ...base,
      ...parsed,
      heartbeat: { ...base.heartbeat, ...parsed.heartbeat },
      evolution: { ...base.evolution, ...parsed.evolution },
      fallbackModels: parsed.fallbackModels ?? base.fallbackModels,
      maxTokens: parsed.maxTokens ?? base.maxTokens,
      maxIterations: parsed.maxIterations ?? base.maxIterations,
      outputFormat: parsed.outputFormat ?? base.outputFormat,
      retry: parsed.retry ?? base.retry,
      pipeline: parsed.pipeline ?? base.pipeline,
      hideThinkOutput: parsed.hideThinkOutput ?? base.hideThinkOutput,
    };
  } catch (err) {
    logger.warn(`Failed to parse agent config at ${configPath}: ${err}`);
    return base;
  }
}

async function loadPromptFiles(folderPath: string): Promise<AgentPromptFiles> {
  const prompts: AgentPromptFiles = {};
  const entries = await readdir(folderPath);

  for (const entry of entries) {
    const key = PROMPT_FILE_MAP[entry];
    if (key) {
      const content = await readMarkdownContent(join(folderPath, entry));
      if (content) prompts[key] = content;
    }
  }

  // Also load any extra .md files not in the standard set
  for (const entry of entries) {
    if (entry.endsWith(".md") && !PROMPT_FILE_MAP[entry] && entry !== "README.md") {
      const key = entry.replace(".md", "").toLowerCase();
      const content = await readMarkdownContent(join(folderPath, entry));
      if (content) prompts[key] = content;
    }
  }

  return prompts;
}

async function loadSkills(folderPath: string): Promise<SkillDefinition[]> {
  const skillsDir = join(folderPath, "skills");
  if (!existsSync(skillsDir)) return [];

  const entries = await readdir(skillsDir);
  const skills: SkillDefinition[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(skillsDir, entry);
    const content = await readMarkdownContent(filePath);
    if (!content) continue;

    skills.push({
      name: entry.replace(".md", ""),
      description: content.split("\n")[0] ?? entry,
      content,
      filePath,
    });
  }

  return skills;
}

function buildNodeIdMap(nodes: WorkflowNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) {
    if (node.type === "phase" && node.data.step) {
      map.set(node.data.step, node.id);
    }
    map.set(node.id, node.id);
    if (node.data.children) {
      for (const child of node.data.children) {
        map.set(child.id, child.id);
        if (child.type === "phase" && child.data.step) {
          map.set(child.data.step, child.id);
        }
      }
    }
  }
  return map;
}

function loadWorkflow(folderPath: string): WorkflowDefinition | undefined {
  const workflowPath = join(folderPath, "workflow.yaml");
  if (!existsSync(workflowPath)) return undefined;

  try {
    const raw = readFileSync(workflowPath, "utf-8");
    const parsed = parseYaml(raw) as WorkflowDefinition;

    if (parsed.kind !== "agent-workflow") {
      logger.warn(`Invalid workflow kind in ${workflowPath}: ${parsed.kind}`);
      return undefined;
    }

    if (parsed.graph?.nodes) {
      parsed.nodeIdMap = buildNodeIdMap(parsed.graph.nodes);
    } else if (parsed.modes) {
      const nodeIdMap = new Map<string, string>();
      for (const [, modeValue] of Object.entries(parsed.modes)) {
        if (typeof modeValue === "object" && modeValue.graph?.nodes) {
          const sub = buildNodeIdMap(modeValue.graph.nodes);
          for (const [k, v] of sub) nodeIdMap.set(k, v);
        }
      }
      if (nodeIdMap.size > 0) parsed.nodeIdMap = nodeIdMap;
    }

    logger.info(`Workflow loaded for ${basename(folderPath)}: strategy=${parsed.agent.strategy}, nodes=${parsed.nodeIdMap?.size ?? 0}`);
    return parsed;
  } catch (err) {
    logger.warn(`Failed to parse workflow at ${workflowPath}: ${err}`);
    return undefined;
  }
}

function mergeConfigFromWorkflow(
  base: AgentConfig,
  workflowConfig: Partial<AgentConfig> | undefined,
): AgentConfig {
  if (!workflowConfig) return base;
  return {
    ...base,
    ...workflowConfig,
    heartbeat: { ...base.heartbeat, ...workflowConfig.heartbeat },
    evolution: { ...base.evolution, ...workflowConfig.evolution },
    fallbackModels: workflowConfig.fallbackModels ?? base.fallbackModels,
    maxTokens: workflowConfig.maxTokens ?? base.maxTokens,
    maxIterations: workflowConfig.maxIterations ?? base.maxIterations,
    outputFormat: workflowConfig.outputFormat ?? base.outputFormat,
    retry: workflowConfig.retry ?? base.retry,
    pipeline: workflowConfig.pipeline ?? base.pipeline,
  };
}

export async function loadAgent(folderPath: string): Promise<AgentDefinition> {
  const name = basename(folderPath);
  logger.info(`Loading agent: ${name} from ${folderPath}`);

  const [prompts, config, skills] = await Promise.all([
    loadPromptFiles(folderPath),
    Promise.resolve(loadAgentConfig(folderPath)),
    loadSkills(folderPath),
  ]);

  const workflow = loadWorkflow(folderPath);
  const finalConfig = workflow?.config
    ? mergeConfigFromWorkflow(config, workflow.config)
    : config;

  return {
    name,
    folderPath,
    prompts,
    config: finalConfig,
    skills,
    memoryPath: join(folderPath, "memory"),
    workflow,
  };
}

export async function discoverAgents(baseDir: string): Promise<string[]> {
  if (!existsSync(baseDir)) return [];

  const entries = await readdir(baseDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;

    const fullPath = join(baseDir, entry.name);

    const hasConfig = existsSync(join(fullPath, "agent.config.yaml"));
    const hasWorkflow = existsSync(join(fullPath, "workflow.yaml"));
    if (hasConfig || hasWorkflow) {
      results.push(fullPath);
    } else {
      const subEntries = await readdir(fullPath, { withFileTypes: true });
      for (const sub of subEntries) {
        if (!sub.isDirectory() || sub.name.startsWith("_")) continue;
        const subPath = join(fullPath, sub.name);
        if (existsSync(join(subPath, "agent.config.yaml")) || existsSync(join(subPath, "workflow.yaml"))) {
          results.push(subPath);
        }
      }
    }
  }

  return results;
}

/**
 * Discover and load business code modules from apps/<domain>/code/.
 * Each module must export a register() function that registers tools,
 * dynamic tool factories, and pipeline handlers.
 */
export async function loadAppModules(baseDir: string): Promise<void> {
  if (!existsSync(baseDir)) return;

  const entries = await readdir(baseDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;

    const codeDir = join(baseDir, entry.name, "code");
    if (!existsSync(codeDir)) continue;

    // In dev (tsx/ts-node), prefer source so we use the same route-registry instance as server.
    // dist/ builds use ../../../src which resolves to dist/src, creating a second singleton.
    const distPath = resolve("dist", "apps", entry.name, "code", "index.js");
    const srcPath = join(codeDir, "index.ts");
    const isProd = process.env.NODE_ENV === "production";
    const modulePath =
      isProd && existsSync(distPath) ? distPath : existsSync(srcPath) ? srcPath : distPath;
    if (!existsSync(modulePath)) continue;

    try {
      const moduleUrl = pathToFileURL(resolve(modulePath)).href;
      const mod = await import(moduleUrl) as { register?: () => void };

      if (typeof mod.register === "function") {
        mod.register();
        logger.info(`App module loaded: ${entry.name}/code`);
      } else {
        logger.warn(`App module ${entry.name}/code/index has no register() export, skipping`);
      }
    } catch (err) {
      logger.error(`Failed to load app module ${entry.name}/code: ${err}`);
    }
  }
}
