import { resolve, join } from "node:path";
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AgentDefinition, AgentCreateRequest, AgentConfig } from "./types.js";
import { loadAgent, discoverAgents, loadAppModules } from "./agent-loader.js";
import { toolRegistry } from "../tools/tool-registry.js";
import { skillRegistry } from "../skills/skill-registry.js";
import { loadSkillsFromDir } from "../skills/skill-loader.js";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";

import { codeExecutorTool } from "../tools/built-in/code-executor.js";
import { httpRequestTool } from "../tools/built-in/http-request.js";
import { fileReadTool, fileWriteTool, fileListTool } from "../tools/built-in/file-ops.js";
import { shellTool } from "../tools/built-in/shell.js";
import { subAgentTool } from "../tools/built-in/sub-agent.js";
import { createAgentTool } from "../tools/built-in/create-agent.js";
import { knowledgeSearchTool } from "../tools/built-in/knowledge-search.js";
import { knowledgeListTool } from "../tools/built-in/knowledge-list.js";
import { knowledgeDocRetrieveTool } from "../tools/built-in/knowledge-doc-retrieve.js";
import { imageGenerateTool } from "../tools/built-in/image-generate.js";
import { imageLibraryTool } from "../tools/built-in/image-library.js";
import {
  e2bProjectStatusTool,
  e2bPreflightTool,
  e2bManageAssetsTool,
  e2bRenderTool,
  e2bShareTool,
  e2bSandboxExecTool,
} from "../tools/built-in/e2b.js";

import { selfReflectSkill } from "../skills/built-in/self-reflect.js";
import { selfEvolveSkill } from "../skills/built-in/self-evolve.js";
import { memorySearchSkill } from "../skills/built-in/memory-search.js";
import { writeFile } from "node:fs/promises";

class AgentRegistry {
  private agents = new Map<string, AgentDefinition>();

  async initialize(): Promise<void> {
    this.registerBuiltInTools();
    this.registerBuiltInSkills();

    const config = getConfig();
    const baseDir = resolve(config.agents.baseDir);

    // Auto-discover and load business code modules from apps/<domain>/code/
    await loadAppModules(baseDir);

    const agentFolders = await discoverAgents(baseDir);

    for (const folder of agentFolders) {
      try {
        const agentDef = await loadAgent(folder);

        // Detect name collision across different application groups
        const existing = this.agents.get(agentDef.name);
        if (existing) {
          logger.error(
            `Agent name collision: "${agentDef.name}" found in both ` +
            `"${existing.folderPath}" and "${agentDef.folderPath}". ` +
            `Agent names must be globally unique. Skipping the duplicate.`,
          );
          continue;
        }

        // Merge agent-local skills into the definition
        const localSkills = await loadSkillsFromDir(join(folder, "skills"));
        agentDef.skills = [...agentDef.skills, ...localSkills];

        this.agents.set(agentDef.name, agentDef);
        logger.info(`Agent registered: ${agentDef.name}`);
      } catch (err) {
        logger.error(`Failed to load agent from ${folder}: ${err}`);
      }
    }

    logger.info(`Agent registry initialized: ${this.agents.size} agent(s) loaded`);
  }

  private registerBuiltInTools(): void {
    toolRegistry.register({ name: "code_executor", description: "Execute code", tool: codeExecutorTool });
    toolRegistry.register({ name: "http_request", description: "HTTP requests", tool: httpRequestTool });
    toolRegistry.register({ name: "file_read", description: "Read files", tool: fileReadTool });
    toolRegistry.register({ name: "file_write", description: "Write files", tool: fileWriteTool });
    toolRegistry.register({ name: "file_list", description: "List directory", tool: fileListTool });
    toolRegistry.register({ name: "shell", description: "Shell commands", tool: shellTool });
    toolRegistry.register({ name: "spawn_sub_agent", description: "Spawn sub-agent", tool: subAgentTool });
    toolRegistry.register({ name: "create_agent", description: "Create new agent at runtime", tool: createAgentTool });
    toolRegistry.register({ name: "knowledge_search", description: "Search knowledge base with intelligent retrieval (Dify + RRF + Rerank)", tool: knowledgeSearchTool });
    toolRegistry.register({ name: "knowledge_list", description: "List available knowledge bases from Dify", tool: knowledgeListTool });
    toolRegistry.register({ name: "knowledge_doc_retrieve", description: "Retrieve full document content from knowledge base", tool: knowledgeDocRetrieveTool });
    toolRegistry.register({ name: "image_generate", description: "Generate images via AI", tool: imageGenerateTool });
    toolRegistry.register({ name: "image_library", description: "Search, match and manage global image library", tool: imageLibraryTool });
    
    // Lazy load web_search to avoid circular/init issues if needed, or import directly
    import("../tools/built-in/web-search.js").then(({ webSearchTool }) => {
        toolRegistry.register({ name: "web_search", description: "Search the web via Tavily or SearchApi fallback", tool: webSearchTool });
    }).catch(err => logger.warn(`Failed to load web_search tool: ${err}`));

    toolRegistry.register({ name: "e2b_project_status", description: "Get E2B project status & preview data", tool: e2bProjectStatusTool });
    toolRegistry.register({ name: "e2b_preflight", description: "E2B runtime preflight check", tool: e2bPreflightTool });
    toolRegistry.register({ name: "e2b_manage_assets", description: "Manage E2B project assets", tool: e2bManageAssetsTool });
    toolRegistry.register({ name: "e2b_render", description: "Render video on E2B", tool: e2bRenderTool });
    toolRegistry.register({ name: "e2b_share", description: "Get E2B share link / profile", tool: e2bShareTool });
    toolRegistry.register({ name: "e2b_sandbox_exec", description: "Execute command in E2B sandbox", tool: e2bSandboxExecTool });
    logger.info(`Built-in tools registered: ${toolRegistry.listNames().join(", ")}`);
  }

  private registerBuiltInSkills(): void {
    skillRegistry.register(selfReflectSkill);
    skillRegistry.register(selfEvolveSkill);
    skillRegistry.register(memorySearchSkill);
    logger.info(`Built-in skills registered: ${skillRegistry.listNames().join(", ")}`);
  }

  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  getAll(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  list(): string[] {
    return Array.from(this.agents.keys());
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  async create(request: AgentCreateRequest): Promise<AgentDefinition> {
    if (this.agents.has(request.name)) {
      throw new Error(`Agent already exists: ${request.name}`);
    }

    const config = getConfig();
    const baseDir = resolve(config.agents.baseDir);
    const templateDir = join(baseDir, "_template");

    // Support application group: apps/<group>/<name>/ or apps/<name>/
    const parentDir = request.group ? join(baseDir, request.group) : baseDir;
    const newDir = join(parentDir, request.name);

    if (!existsSync(templateDir)) {
      throw new Error("Agent template directory not found");
    }

    if (request.group && !existsSync(parentDir)) {
      await mkdir(parentDir, { recursive: true });
    }

    await cp(templateDir, newDir, { recursive: true });

    // Override .md files if provided
    if (request.identity) {
      await writeFile(join(newDir, "IDENTITY.md"), request.identity, "utf-8");
    }
    if (request.soul) {
      await writeFile(join(newDir, "SOUL.md"), request.soul, "utf-8");
    }
    if (request.mission) {
      await writeFile(join(newDir, "MISSION.md"), request.mission, "utf-8");
    }

    // Override config if provided
    if (request.config) {
      const { parse: parseYaml, stringify: stringifyYaml } = await import("yaml");
      const existingConfig = existsSync(join(newDir, "agent.config.yaml"))
        ? parseYaml(await (await import("node:fs/promises")).readFile(join(newDir, "agent.config.yaml"), "utf-8"))
        : {};
      const merged = { ...existingConfig, ...request.config };
      await writeFile(join(newDir, "agent.config.yaml"), stringifyYaml(merged), "utf-8");
    }

    const agentDef = await loadAgent(newDir);
    this.agents.set(agentDef.name, agentDef);
    logger.info(`Agent created: ${request.name}`);

    return agentDef;
  }

  remove(name: string): boolean {
    const removed = this.agents.delete(name);
    if (removed) logger.info(`Agent removed from registry: ${name}`);
    return removed;
  }

  async reload(name: string): Promise<AgentDefinition | null> {
    const existing = this.agents.get(name);
    if (!existing) return null;

    const reloaded = await loadAgent(existing.folderPath);
    const localSkills = await loadSkillsFromDir(join(existing.folderPath, "skills"));
    reloaded.skills = [...reloaded.skills, ...localSkills];

    this.agents.set(name, reloaded);
    logger.info(`Agent reloaded: ${name}`);
    return reloaded;
  }
}

export const agentRegistry = new AgentRegistry();
