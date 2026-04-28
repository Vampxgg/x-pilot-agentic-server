/**
 * Chorus —— 将会话 DSL 写入 data/dsl-chorus/{sessionId}/dsl.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { logger } from "../../../../src/utils/logger.js";
import type { Dsl } from "./schema.js";

const CHORUS_TUTORIALS_DIR = resolve(process.cwd(), "data", "dsl-chorus");

export interface PublishResult {
  sessionId: string;
  filePath: string;
  url: string;
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

  logger.info(`[chorus publish] session=${sessionId} bytes=${text.length} scenes=${Object.keys(dsl.scenes).length}`);

  return {
    sessionId,
    filePath,
    url: `/api/business/scene-dsl-chorus/sessions/${sessionId}/dsl`,
    size: text.length,
    app: { id: dsl.app.id, name: dsl.app.name },
    sceneCount: Object.keys(dsl.scenes).length,
  };
}

export function getSessionDir(sessionId: string): string {
  return join(CHORUS_TUTORIALS_DIR, sessionId);
}

export function getDslFilePath(sessionId: string): string {
  return join(getSessionDir(sessionId), "dsl.json");
}
