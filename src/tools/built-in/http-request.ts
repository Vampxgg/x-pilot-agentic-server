import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../utils/logger.js";

export const httpRequestTool = tool(
  async ({ method, url, headers, body, timeout }) => {
    const httpMethod = method ?? "GET";
    logger.info(`[http_request] ${httpMethod} ${url}`);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout ?? 30_000);

      const response = await fetch(url, {
        method: httpMethod,
        headers: headers ? JSON.parse(headers) : undefined,
        body: body ?? undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      const contentType = response.headers.get("content-type") ?? "";
      let responseBody: string;

      if (contentType.includes("application/json")) {
        responseBody = JSON.stringify(await response.json());
      } else {
        responseBody = await response.text();
      }

      if (response.status >= 400) {
        logger.warn(`[http_request] ${httpMethod} ${url} → ${response.status} ${response.statusText}: ${responseBody.slice(0, 500)}`);
      } else {
        logger.info(`[http_request] ${httpMethod} ${url} → ${response.status} ${response.statusText} (${responseBody.length} chars)`);
      }

      return JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody.slice(0, 20_000),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[http_request] ${httpMethod} ${url} FAILED: ${errMsg}`);
      return JSON.stringify({
        error: errMsg,
      });
    }
  },
  {
    name: "http_request",
    description: "Make an HTTP request to any URL. Supports GET, POST, PUT, PATCH, DELETE.",
    schema: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method (default GET)"),
      url: z.string().url().describe("The URL to request"),
      headers: z.string().optional().describe("JSON string of request headers"),
      body: z.string().optional().describe("Request body string"),
      timeout: z.number().optional().describe("Request timeout in ms (default 30s)"),
    }),
  },
);
