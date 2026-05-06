import { join, resolve } from "node:path";
import { resolvePublicBaseUrl } from "../../../../src/utils/public-url.js";
import type { TutorialPaths } from "./types.js";

export const TUTORIALS_DIR = resolve(process.cwd(), "data", "tutorials");

export function getTutorialPaths(sessionId: string): TutorialPaths {
  return {
    sourceDir: join(TUTORIALS_DIR, sessionId, "source"),
    distDir: join(TUTORIALS_DIR, sessionId, "dist"),
    distCandidateDir: join(TUTORIALS_DIR, sessionId, "dist-candidate"),
  };
}

export function tutorialPublicFileUrl(sessionId: string): string {
  return `${resolvePublicBaseUrl()}/api/files/tutorials/${sessionId}/dist/index.html`;
}
