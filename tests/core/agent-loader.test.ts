import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { loadAgent, discoverAgents } from "../../src/core/agent-loader.js";
import { loadConfig } from "../../src/utils/config.js";

const APPS_DIR = resolve(process.cwd(), "apps");

beforeAll(() => {
  loadConfig();
});

describe("agent-loader", () => {
  describe("discoverAgents", () => {
    it("should discover agent folders across application groups, excluding _template", async () => {
      const folders = await discoverAgents(APPS_DIR);
      expect(folders.length).toBeGreaterThanOrEqual(1);
      expect(folders.some((f) => f.includes("orchestrator"))).toBe(true);
      expect(folders.some((f) => f.includes("_template"))).toBe(false);
    });

    it("should discover agents nested inside application group folders", async () => {
      const folders = await discoverAgents(APPS_DIR);
      expect(folders.some((f) => f.includes("video-course-director"))).toBe(true);
      expect(folders.some((f) => f.includes("document-generation"))).toBe(true);
    });
  });

  describe("loadAgent", () => {
    it("should load orchestrator agent with all prompt files", async () => {
      const agent = await loadAgent(resolve(APPS_DIR, "system", "orchestrator"));

      expect(agent.name).toBe("orchestrator");
      expect(agent.prompts.identity).toBeTruthy();
      expect(agent.prompts.soul).toBeTruthy();
      expect(agent.prompts.mission).toBeTruthy();
      expect(agent.prompts.tools).toBeTruthy();
      expect(agent.prompts.heartbeat).toBeTruthy();
    });

    it("should load agent config from yaml", async () => {
      const agent = await loadAgent(resolve(APPS_DIR, "system", "orchestrator"));

      expect(agent.config.model).toBe("gpt-4o");
      expect(agent.config.maxConcurrency).toBe(10);
      expect(agent.config.heartbeat.enabled).toBe(true);
      expect(agent.config.evolution.enabled).toBe(true);
    });

    it("should set memory path correctly", async () => {
      const agent = await loadAgent(resolve(APPS_DIR, "system", "orchestrator"));
      expect(agent.memoryPath).toContain("orchestrator");
      expect(agent.memoryPath).toContain("memory");
    });
  });
});
