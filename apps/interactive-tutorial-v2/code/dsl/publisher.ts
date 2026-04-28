/**
 * publishDsl —— 把 dsl 写到会话目录，返回访问 URL。
 *
 * v2 的会话目录策略（与 v1 完全隔离）：
 *   data/dsl-tutorials/{sessionId}/dsl.json
 *
 * 不做 Vite 构建（runtime bundle 是固定的），只做：
 *   1. mkdir -p data/dsl-tutorials/{sessionId}
 *   2. 写 dsl.json
 *   3. 返回访问 URL（前端拼接：runtime.html?dslUrl=/api/business/interactive-tutorial-v2/sessions/{sid}/dsl）
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { logger } from "../../../../src/utils/logger.js";
import type { Dsl } from "./schema.js";

const V2_TUTORIALS_DIR = resolve(process.cwd(), "data", "dsl-tutorials");

export interface PublishResult {
  sessionId: string;
  filePath: string;
  url: string;
  /** dsl 字节数 */
  size: number;
  app: { id: string; name: string };
  sceneCount: number;
}

export async function publishDsl(sessionId: string, dsl: Dsl): Promise<PublishResult> {
  if (!sessionId) throw new Error("publishDsl: sessionId required");

  const dir = getSessionDir(sessionId);
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, "dsl.json");
  const text = JSON.stringify(dsl, null, 2);
  await writeFile(filePath, text, "utf-8");

  logger.info(`[v2 publish] session=${sessionId} bytes=${text.length} scenes=${Object.keys(dsl.scenes).length}`);

  return {
    sessionId,
    filePath,
    url: `/api/business/interactive-tutorial-v2/sessions/${sessionId}/dsl`,
    size: text.length,
    app: { id: dsl.app.id, name: dsl.app.name },
    sceneCount: Object.keys(dsl.scenes).length,
  };
}

export function getSessionDir(sessionId: string): string {
  return join(V2_TUTORIALS_DIR, sessionId);
}

export function getDslFilePath(sessionId: string): string {
  return join(getSessionDir(sessionId), "dsl.json");
}
