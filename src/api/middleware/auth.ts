import type { FastifyRequest, FastifyReply } from "fastify";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { logger } from "../../utils/logger.js";

interface UserConfig {
  id: string;
  name: string;
  apiKey: string;
}

interface TenantConfig {
  id: string;
  name: string;
  apiKey?: string;
  users?: UserConfig[];
}

interface TenantsFile {
  tenants: TenantConfig[];
}

interface ResolvedIdentity {
  tenantId: string;
  userId: string;
}

let keyMap: Map<string, ResolvedIdentity> | null = null;

function loadIdentityMap(): Map<string, ResolvedIdentity> {
  if (keyMap) return keyMap;

  keyMap = new Map();

  const configPath = resolve(process.cwd(), "config", "tenants.yaml");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(raw) as TenantsFile | null;

      for (const tenant of parsed?.tenants ?? []) {
        // Tenant-level key (backwards compatible, userId = "default")
        if (tenant.apiKey) {
          keyMap.set(tenant.apiKey, { tenantId: tenant.id, userId: "default" });
        }

        // Per-user keys
        for (const user of tenant.users ?? []) {
          keyMap.set(user.apiKey, { tenantId: tenant.id, userId: user.id });
        }
      }

      const tenantCount = (parsed?.tenants ?? []).length;
      const userCount = keyMap.size;
      logger.info(`Loaded ${tenantCount} tenant(s), ${userCount} API key(s) from config/tenants.yaml`);
    } catch (err) {
      logger.error(`Failed to load tenants config: ${err}`);
    }
  } else {
    logger.warn("config/tenants.yaml not found. All requests will use default tenant/user.");
  }

  return keyMap;
}

function extractApiKey(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  const query = request.query as Record<string, string>;
  if (query.apiKey) return query.apiKey;

  return null;
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.method === "OPTIONS") return;
  if (request.url === "/api/health" || request.url.startsWith("/api/files/")) return;

  const identityMap = loadIdentityMap();
  const apiKey = extractApiKey(request);

  if (identityMap.size === 0) {
    (request as any).tenantId = "default";
    (request as any).userId = "default";
    return;
  }

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      reply.code(401).send({ error: "Missing API key. Provide Authorization: Bearer <key> header." });
      return;
    }
    (request as any).tenantId = "default";
    (request as any).userId = "default";
    return;
  }

  const identity = identityMap.get(apiKey);
  if (!identity) {
    reply.code(401).send({ error: "Invalid API key." });
    return;
  }

  (request as any).tenantId = identity.tenantId;
  (request as any).userId = identity.userId;
}

export function getTenantId(request: FastifyRequest): string {
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (typeof body.tenant_id === "string" && body.tenant_id) return body.tenant_id;
  return (request as any).tenantId ?? "default";
}

export function getUserId(request: FastifyRequest): string {
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (typeof body.user_id === "string" && body.user_id) return body.user_id;
  return (request as any).userId ?? "default";
}
