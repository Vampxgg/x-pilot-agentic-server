import type { FastifyRequest } from "fastify";

/**
 * Base URL that clients can use to reach this server (for download links, image URLs, etc.).
 *
 * Priority:
 * 1. PUBLIC_BASE_URL (explicit, required in production behind proxies)
 * 2. X-Forwarded-Proto + X-Forwarded-Host (or Host) from the incoming request
 * 3. HOST + PORT — never use 0.0.0.0 / :: in URLs (browsers cannot open them)
 */
export function resolvePublicBaseUrl(request?: FastifyRequest): string {
  const fromEnv = process.env.PUBLIC_BASE_URL?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, "");
  }

  if (request) {
    const xfProto = (request.headers["x-forwarded-proto"] as string | undefined)
      ?.split(",")[0]
      ?.trim();
    const proto =
      xfProto || (request as { protocol?: string }).protocol || "http";

    const xfHost = (request.headers["x-forwarded-host"] as string | undefined)
      ?.split(",")[0]
      ?.trim();
    const host = xfHost || request.headers.host;
    if (host && !isUnusableBindHost(host.split(":")[0] ?? host)) {
      return `${proto}://${host}`;
    }
  }

  const rawHost = process.env.HOST?.trim() || "localhost";
  const host = isUnusableBindHost(rawHost) ? "localhost" : rawHost;
  const port = process.env.PORT?.trim() || "3000";
  if (port === "443") {
    return `https://${host}`;
  }
  if (port === "80") {
    return `http://${host}`;
  }
  return `http://${host}:${port}`;
}

function isUnusableBindHost(h: string): boolean {
  const x = h.toLowerCase();
  return x === "0.0.0.0" || x === "::" || x === "[::]";
}
