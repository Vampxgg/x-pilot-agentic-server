import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { config as loadDotenv } from "dotenv";
import type { AppConfig } from "../core/types.js";
import { logger } from "./logger.js";

loadDotenv();

const DEFAULT_CONFIG: AppConfig = {
  server: { port: 3000, host: "0.0.0.0" },
  agents: {
    baseDir: "./apps",
    defaults: {
      model: "z-ai/glm-5",
      workerModel: "z-ai/glm-5",
      fallbackModels: ["moonshotai/kimi-k2.5"],
      maxConcurrency: 5,
      heartbeat: { enabled: true, intervalMs: 3_600_000 },
      evolution: { enabled: true, requireApproval: true },
      timeout: 300_000,
    },
  },
  memory: {
    store: "file",
    consolidation: { enabled: true, intervalMs: 86_400_000 },
    checkpoint: {
      store: "postgres",
      postgresUrl: "",
      maxMessages: 100,
    },
  },
  llm: {
    retry: {
      maxRetries: 3,
    },
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY ?? "" },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY ?? "" },
      openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY ?? "",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      zhipu: {
        apiKey: process.env.ZHIPU_API_KEY ?? "",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      },
      vertex: {
        project: process.env.GOOGLE_CLOUD_PROJECT ?? "",
        location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
      },
    },
  },
};

function interpolateEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? "");
}

function deepInterpolate(obj: unknown): unknown {
  if (typeof obj === "string") return interpolateEnv(obj);
  if (Array.isArray(obj)) return obj.map(deepInterpolate);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deepInterpolate(v);
    }
    return result;
  }
  return obj;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

let _config: AppConfig | null = null;

export function loadConfig(configPath?: string): AppConfig {
  if (_config) return _config;

  const filePath = configPath ?? resolve(process.cwd(), "config", "default.yaml");

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const interpolated = deepInterpolate(parsed) as Record<string, unknown>;
    _config = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, interpolated) as unknown as AppConfig;
    logger.info(`Config loaded from ${filePath}`);
  } else {
    logger.warn(`Config file not found at ${filePath}, using defaults`);
    _config = DEFAULT_CONFIG;
  }

  if (process.env.PORT) _config.server.port = parseInt(process.env.PORT, 10);
  if (process.env.HOST) _config.server.host = process.env.HOST;
  if (process.env.MEMORY_STORE) _config.memory.store = process.env.MEMORY_STORE as "file" | "postgres";

  if (!_config.memory.checkpoint) {
    _config.memory.checkpoint = { store: "postgres", postgresUrl: "", maxMessages: 100 };
  }
  if (process.env.CHECKPOINT_STORE) {
    _config.memory.checkpoint.store = process.env.CHECKPOINT_STORE as "memory" | "postgres";
  }
  if (process.env.CHECKPOINT_POSTGRES_URL) {
    _config.memory.checkpoint.postgresUrl = process.env.CHECKPOINT_POSTGRES_URL;
  }
  if (process.env.CHECKPOINT_MAX_MESSAGES) {
    _config.memory.checkpoint.maxMessages = parseInt(process.env.CHECKPOINT_MAX_MESSAGES, 10);
  }

  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) return loadConfig();
  return _config;
}
