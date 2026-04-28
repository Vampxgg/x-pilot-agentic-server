/**
 * v2 渲染端目录解析（与老 template-dir.ts 完全独立）。
 *
 * 优先级：
 *   1. process.env.RUNTIME_TEMPLATE_DIR
 *   2. apps/interactive-tutorial-v2/dsl-director/agent.config.yaml 的 metadata.runtimeDir
 *   3. 默认 ../react-code-rander
 *
 * v2 关心的不是模板目录里的 src 拷贝，而是 dist 静态产物（runtime.html + runtime-*.js）。
 * 因为 v2 不再每个会话单独构建——SceneRuntime 是固定 bundle，会话只产生 dsl.json。
 */

import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { logger } from "../../../src/utils/logger.js";

const DEFAULT_REL = resolve(process.cwd(), "..", "react-code-rander");

let _resolved: string | null = null;

function readDirectorMetadata(): string | undefined {
  const configPath = resolve(
    process.cwd(),
    "apps",
    "interactive-tutorial-v2",
    "dsl-director",
    "agent.config.yaml",
  );
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (typeof metadata?.runtimeDir === "string") return metadata.runtimeDir;
  } catch {
    /* ignore */
  }
  return undefined;
}

export function resolveRuntimeDir(): string {
  if (_resolved) return _resolved;

  const fromEnv = process.env.RUNTIME_TEMPLATE_DIR;
  if (fromEnv) {
    _resolved = resolve(fromEnv);
    logger.info(`[v2 runtime-dir] env RUNTIME_TEMPLATE_DIR: ${_resolved}`);
    return _resolved;
  }
  const fromMeta = readDirectorMetadata();
  if (fromMeta) {
    _resolved = resolve(fromMeta);
    logger.info(`[v2 runtime-dir] director metadata.runtimeDir: ${_resolved}`);
    return _resolved;
  }
  _resolved = DEFAULT_REL;
  logger.info(`[v2 runtime-dir] default: ${_resolved}`);
  return _resolved;
}

export function getRuntimeDistPath(): string {
  return resolve(resolveRuntimeDir(), "dist");
}
