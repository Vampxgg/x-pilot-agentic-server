import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import PQueue from "p-queue";

/**
 * Web Search Tool — powered by Tavily (https://docs.tavily.com).
 *
 * Backwards compatibility:
 *  - Tool name `web_search` is preserved.
 *  - Input schema retains all legacy fields (search_type, num, gl, hl,
 *    time_period*, image_*, aspect_ratio, timeout, extract_content) so that
 *    existing callers (image-fetch-service.ts, interactive-tutorial agents,
 *    test scripts) continue to work without code changes.
 *  - Output shape preserves `query`, `ai_overview`, and
 *    `organic_results: [{ title, link, source, domain, snippet, date,
 *    thumbnail, images, content, extracted_content, score }]`.
 *
 * Note: Tavily does not support fine-grained image filters (size / color /
 * type / aspect_ratio). Those parameters are accepted but ignored, and a
 * warning is logged so callers know to migrate.
 */

const FALLBACK_TAVILY_KEY = "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";

function resolveTavilyKey(): string {
  // Pick the first env var that looks like a Tavily key (`tvly-...`).
  // SEARCH_API_KEY is consulted for back-compat in case the user reused it.
  const candidates = [process.env.TAVILY_API_KEY, process.env.SEARCH_API_KEY];
  for (const k of candidates) {
    if (typeof k === "string" && k.startsWith("tvly-")) return k;
  }
  return FALLBACK_TAVILY_KEY;
}

const TAVILY_API_KEY = resolveTavilyKey();

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

const OUTPUT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;

// Global concurrency queue for web searches (Tavily's free tier rate limits).
const webSearchQueue = new PQueue({ concurrency: 3 });

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
  published_date?: string;
};

type TavilyImage = {
  url?: string;
  description?: string;
};

type TavilyResponse = {
  query?: string;
  answer?: string | null;
  images?: Array<TavilyImage | string>;
  results?: TavilyResult[];
  response_time?: number;
};

function safeDomain(link: string | undefined): string {
  if (!link || typeof link !== "string" || !link.startsWith("http")) return "";
  try {
    return new URL(link).hostname;
  } catch {
    return "";
  }
}

function mapTimePeriod(
  period: string | undefined,
): "day" | "week" | "month" | "year" | undefined {
  if (!period) return undefined;
  // Tavily only supports day/week/month/year. Map legacy granular values.
  if (period === "last_year") return "year";
  if (period === "last_month") return "month";
  if (period === "last_week") return "week";
  if (
    period === "last_day" ||
    period === "last_hour" ||
    period === "last_30_minutes" ||
    period === "last_15_minutes" ||
    period === "last_5_minutes" ||
    period === "last_1_minute"
  ) {
    return "day";
  }
  return undefined;
}

function formatTextResult(res: TavilyResult) {
  const link = res.url ?? "";
  const raw = typeof res.raw_content === "string" ? res.raw_content : "";
  return {
    title: res.title ?? "",
    link,
    source: safeDomain(link),
    domain: safeDomain(link),
    snippet: res.content ?? "",
    date: res.published_date ?? "",
    thumbnail: "",
    images: [] as string[],
    content: raw,
    extracted_content: raw,
    score: typeof res.score === "number" ? res.score : undefined,
  };
}

function formatImageResult(img: TavilyImage | string) {
  const url = typeof img === "string" ? img : img.url ?? "";
  const description = typeof img === "string" ? "" : img.description ?? "";
  return {
    title: description,
    link: url,
    source: safeDomain(url),
    domain: safeDomain(url),
    snippet: description,
    date: "",
    thumbnail: url,
    images: url ? [url] : [],
    content: "",
    extracted_content: "",
  };
}

export const webSearchTool = tool(
  async ({
    query = "毫米波雷达技术",
    search_type = "text",
    num,
    gl = "",
    time_period = "last_day",
    extract_content,
    search_depth = "basic",
    topic = "general",
    include_domains,
    exclude_domains = [],
    timeout,
    image_size = "",
    image_color,
    image_type = "",
    aspect_ratio = "",
  }) => {
    logger.info(
      `[web_search] (tavily) query="${query}" type=${search_type ?? "text"} num=${num ?? "default"}`,
    );

    if (!TAVILY_API_KEY || !TAVILY_API_KEY.startsWith("tvly-")) {
      return JSON.stringify({
        error:
          "Tavily API key is missing or invalid. Set TAVILY_API_KEY in the environment.",
      });
    }

    if (
      search_type === "image" &&
      (image_size || image_color || image_type || aspect_ratio)
    ) {
      logger.warn(
        "[web_search] image filters (size/color/type/aspect_ratio) are ignored — Tavily does not support them.",
      );
    }

    try {
      return await webSearchQueue.add(async () => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          timeout ?? DEFAULT_TIMEOUT_MS,
        );

        const isImage = search_type === "image";
        const maxResults = Math.min(Math.max(num ?? 5, 1), 20);

        const body: Record<string, unknown> = {
          query,
          search_depth: search_depth ?? "basic",
          topic: topic ?? "general",
          max_results: maxResults,
          include_answer: isImage ? false : "basic",
          include_images: isImage,
          include_image_descriptions: isImage,
        };

        if (extract_content && !isImage) {
          body.include_raw_content = "markdown";
        }

        const tr = mapTimePeriod(time_period);
        if (tr) body.time_range = tr;

        if (gl) body.country = gl;

        if (Array.isArray(include_domains) && include_domains.length > 0) {
          body.include_domains = include_domains;
        }
        if (Array.isArray(exclude_domains) && exclude_domains.length > 0) {
          body.exclude_domains = exclude_domains;
        }

        let response: Response;
        try {
          response = await fetch(TAVILY_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TAVILY_API_KEY}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.headers.get("content-type")?.includes("application/json")) {
          const text = await response.text();
          return JSON.stringify({
            error: `Unexpected response format from Tavily: ${text.slice(0, 200)}`,
          });
        }

        const responseBody = (await response.json()) as TavilyResponse & {
          detail?: unknown;
          error?: string;
        };

        if (response.status >= 400) {
          const detail =
            (typeof responseBody.error === "string" && responseBody.error) ||
            (typeof responseBody.detail === "string"
              ? responseBody.detail
              : JSON.stringify(responseBody.detail ?? {})) ||
            response.statusText;
          logger.warn(`[web_search] Tavily FAILED: ${response.status} ${detail}`);
          return JSON.stringify({ status: response.status, error: detail });
        }

        let organicResults: Array<Record<string, unknown>>;

        if (isImage) {
          const images = responseBody.images ?? [];
          organicResults = images.map(formatImageResult);
        } else {
          const results = responseBody.results ?? [];
          organicResults = results.map(formatTextResult);
        }

        const formatted: Record<string, unknown> = {
          query: responseBody.query ?? query,
          ai_overview:
            typeof responseBody.answer === "string" && responseBody.answer
              ? responseBody.answer
              : null,
          organic_results: organicResults,
          response_time: responseBody.response_time,
        };

        logger.info(
          `[web_search] (tavily) Success: ${organicResults.length} results in ${responseBody.response_time ?? "?"}s`,
        );

        // Keep the JSON structurally valid: if it would exceed the cap,
        // shrink each result's heavy `content` field instead of slicing
        // the JSON string in the middle.
        let str = JSON.stringify(formatted);
        if (str.length > OUTPUT_MAX_CHARS) {
          const shrunk = organicResults.map((r) => {
            const copy = { ...r };
            const content = copy.content as string | undefined;
            const extracted = copy.extracted_content as string | undefined;
            if (typeof content === "string" && content.length > 2000) {
              copy.content = content.slice(0, 2000) + "…[truncated]";
            }
            if (typeof extracted === "string" && extracted.length > 2000) {
              copy.extracted_content = extracted.slice(0, 2000) + "…[truncated]";
            }
            return copy;
          });
          formatted.organic_results = shrunk;
          formatted.truncated = true;
          str = JSON.stringify(formatted);
          if (str.length > OUTPUT_MAX_CHARS) {
            // Last-resort: drop raw content entirely.
            formatted.organic_results = shrunk.map((r) => ({
              ...r,
              content: "",
              extracted_content: "",
            }));
            str = JSON.stringify(formatted);
          }
        }
        return str;
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[web_search] Error during Tavily search: ${errMsg}`);
      return JSON.stringify({ error: errMsg });
    }
  },
  {
    name: "web_search",
    description:
      "Search the web via Tavily. Supports text search and image search. " +
      "Returns structured results: { query, ai_overview, organic_results: [{ title, link, snippet, content, ... }] }. " +
      "Set extract_content=true to also include the page's raw markdown content.",
    schema: z.object({
      query: z.string().min(1).describe("The search query terms."),
      search_type: z
        .enum(["text", "image"])
        .optional()
        .default("text")
        .describe(
          "Search mode. 'text' returns web pages; 'image' returns image URLs (uses Tavily include_images).",
        ),
      num: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of results to request (1-20). Default 5."),
      extract_content: z
        .boolean()
        .optional()
        .describe(
          "If true, include each page's raw markdown content in `content`/`extracted_content` (text search only).",
        ),
      search_depth: z
        .enum(["basic", "advanced"])
        .optional()
        .describe("Tavily search depth. 'advanced' is slower but higher quality."),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .describe("Tavily search topic category."),
      time_period: z
        .enum([
          "last_1_minute",
          "last_5_minutes",
          "last_15_minutes",
          "last_30_minutes",
          "last_hour",
          "last_day",
          "last_week",
          "last_month",
          "last_year",
        ])
        .optional()
        .describe(
          "Restrict by recency. Tavily granularity is day/week/month/year; finer values are mapped to 'day'.",
        ),
      gl: z
        .string()
        .optional()
        .describe("Country code (mapped to Tavily 'country', e.g. 'us', 'cn')."),
      hl: z
        .string()
        .optional()
        .describe("Interface language (kept for back-compat; not used by Tavily)."),
      include_domains: z
        .array(z.string())
        .optional()
        .describe("Only return results from these domains."),
      exclude_domains: z
        .array(z.string())
        .optional()
        .describe("Exclude results from these domains."),
      timeout: z
        .number()
        .optional()
        .describe("Request timeout in ms (default 30000)."),
      image_size: z
        .string()
        .optional()
        .describe("[Deprecated] Image size filter — ignored by Tavily."),
      image_color: z
        .string()
        .optional()
        .describe("[Deprecated] Image color filter — ignored by Tavily."),
      image_type: z
        .string()
        .optional()
        .describe("[Deprecated] Image type filter — ignored by Tavily."),
      aspect_ratio: z
        .string()
        .optional()
        .describe("[Deprecated] Image aspect ratio filter — ignored by Tavily."),
    }),
  },
);


