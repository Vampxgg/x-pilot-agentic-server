import { join } from "node:path";
import { workspaceManager } from "../../../../src/core/workspace.js";
import { resolvePublicBaseUrl } from "../../../../src/utils/public-url.js";

/** Per-session uploads directory under the workspace. Lazy-created on first upload. */
export function uploadsDir(tenantId: string, userId: string, sessionId: string): string {
  return join(workspaceManager.getPath(tenantId, userId, sessionId), "uploads");
}

export function manifestPath(tenantId: string, userId: string, sessionId: string): string {
  return join(uploadsDir(tenantId, userId, sessionId), "manifest.json");
}

/**
 * Public URL of an uploaded file. Anchored on the same `/api/files/` static mount that
 * already serves `data/` (see src/api/server.ts) — anonymous, immutable, addressable
 * the moment the file lands on disk.
 */
export function publicFileUrl(
  tenantId: string,
  userId: string,
  sessionId: string,
  storedName: string,
): string {
  return `${resolvePublicBaseUrl()}/api/files/tenants/${tenantId}/users/${userId}/workspaces/${sessionId}/uploads/${storedName}`;
}
