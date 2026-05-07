import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { logger } from "../../../src/utils/logger.js";

const DEFAULT_TEMPLATE_REL = resolve(process.cwd(), "..", "template_rander");

let _resolved: string | null = null;

function readMetadataTemplateDir(): string | undefined {
  const configPath = resolve(
    process.cwd(),
    "apps",
    "interactive-tutorial",
    "interactive-tutorial-director",
    "agent.config.yaml",
  );
  if (!existsSync(configPath)) return undefined;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const metadata = parsed.metadata as Record<string, unknown> | undefined;
    if (typeof metadata?.templateDir === "string") {
      return metadata.templateDir;
    }
  } catch {
    // ignore parse errors — fall through to default
  }
  return undefined;
}

export function resolveTemplateDir(): string {
  if (_resolved) return _resolved;

  const fromEnv = process.env.TUTORIAL_TEMPLATE_DIR;
  if (fromEnv) {
    _resolved = resolve(fromEnv);
    logger.info(`[template-dir] Using env TUTORIAL_TEMPLATE_DIR: ${_resolved}`);
    return _resolved;
  }

  const fromMeta = readMetadataTemplateDir();
  if (fromMeta) {
    _resolved = resolve(fromMeta);
    logger.info(`[template-dir] Using metadata.templateDir: ${_resolved}`);
    return _resolved;
  }

  _resolved = DEFAULT_TEMPLATE_REL;
  logger.info(`[template-dir] Using default: ${_resolved}`);
  return _resolved;
}

export function getTemplateDir(): string {
  if (!_resolved) return resolveTemplateDir();
  return _resolved;
}
