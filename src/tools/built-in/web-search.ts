import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import PQueue from "p-queue";

/**
 * Web Search Tool — powered by Tavily (https://docs.tavily.com), with
 * SearchApi.io fallback when TAVILY_API_KEY is not configured.
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
 * Note: Some provider-specific filters are accepted for backwards
 * compatibility even when a provider cannot apply them exactly.
 */

function resolveTavilyKey(): string {
  const key = process.env.TAVILY_API_KEY;
  return typeof key === "string" && key.startsWith("tvly-") ? key : "";
}

function resolveSearchApiKey(): string {
  const key = process.env.SEARCH_API_KEY;
  if (typeof key !== "string" || key.trim().length === 0) return "";
  return key.startsWith("tvly-") ? "" : key.trim();
}

const TAVILY_API_KEY = resolveTavilyKey();
const SEARCH_API_KEY = resolveSearchApiKey();

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const SEARCHAPI_ENDPOINT = "https://www.searchapi.io/api/v1/search";

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

type SearchRequest = {
  query: string;
  search_type?: "text" | "image";
  num?: number;
  gl?: string;
  hl?: string;
  time_period?: string;
  extract_content?: boolean;
  search_depth?: "basic" | "advanced";
  topic?: "general" | "news" | "finance";
  include_domains?: string[];
  exclude_domains?: string[];
  timeout?: number;
  image_size?: string;
  image_color?: string;
  image_type?: string;
  aspect_ratio?: string;
};

type SearchApiOrganicResult = {
  position?: number;
  title?: string;
  link?: string;
  source?: string;
  domain?: string;
  snippet?: string;
  date?: string;
  thumbnail?: string;
};

type SearchApiImageResult = {
  position?: number;
  title?: string;
  link?: string;
  source?: string;
  domain?: string;
  snippet?: string;
  thumbnail?: string;
  original?: string;
  image?: string;
};

type SearchApiResponse = {
  search_parameters?: { q?: string };
  search_metadata?: {
    total_time_taken?: number;
    total_time_taken_displayed?: number;
  };
  answer_box?: {
    answer?: string;
    snippet?: string;
  };
  organic_results?: SearchApiOrganicResult[];
  images_results?: SearchApiImageResult[];
  error?: string;
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

function mapSearchApiTimePeriod(period: string | undefined): string | undefined {
  if (!period) return undefined;
  if (period === "last_year") return "qdr:y";
  if (period === "last_month") return "qdr:m";
  if (period === "last_week") return "qdr:w";
  if (
    period === "last_day" ||
    period === "last_hour" ||
    period === "last_30_minutes" ||
    period === "last_15_minutes" ||
    period === "last_5_minutes" ||
    period === "last_1_minute"
  ) {
    return "qdr:d";
  }
  return undefined;
}

function applyDomainFilters(query: string, includeDomains?: string[], excludeDomains?: string[]): string {
  const include = Array.isArray(includeDomains) && includeDomains.length > 0
    ? ` (${includeDomains.map((domain) => `site:${domain}`).join(" OR ")})`
    : "";
  const exclude = Array.isArray(excludeDomains) && excludeDomains.length > 0
    ? ` ${excludeDomains.map((domain) => `-site:${domain}`).join(" ")}`
    : "";
  return `${query}${include}${exclude}`.trim();
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

function formatSearchApiTextResult(res: SearchApiOrganicResult) {
  const link = res.link ?? "";
  const domain = res.domain || res.source || safeDomain(link);
  return {
    position: res.position,
    title: res.title ?? "",
    link,
    source: domain,
    domain,
    snippet: res.snippet ?? "",
    date: res.date ?? "",
    thumbnail: res.thumbnail ?? "",
    images: res.thumbnail ? [res.thumbnail] : [] as string[],
    content: "",
    extracted_content: "",
  };
}

function formatSearchApiImageResult(img: SearchApiImageResult) {
  const url = img.original || img.image || img.link || img.thumbnail || "";
  const thumbnail = img.thumbnail || url;
  const domain = img.domain || img.source || safeDomain(url);
  return {
    position: img.position,
    title: img.title ?? "",
    link: url,
    source: domain,
    domain,
    snippet: img.snippet ?? img.title ?? "",
    date: "",
    thumbnail,
    images: url ? [url] : [],
    content: "",
    extracted_content: "",
  };
}

function stringifyCappedResult(formatted: Record<string, unknown>, organicResults: Array<Record<string, unknown>>): string {
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
}

async function runTavilySearch(request: SearchRequest): Promise<string> {
  const {
    query,
    search_type = "text",
    num,
    gl = "",
    time_period,
    extract_content,
    search_depth = "basic",
    topic = "general",
    include_domains,
    exclude_domains = [],
    timeout,
  } = request;

  const result = await webSearchQueue.add(async () => {
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

    const organicResults: Array<Record<string, unknown>> = isImage
      ? (responseBody.images ?? []).map(formatImageResult)
      : (responseBody.results ?? []).map(formatTextResult);

    const formatted: Record<string, unknown> = {
      provider: "tavily",
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

    return stringifyCappedResult(formatted, organicResults);
  });
  return result ?? JSON.stringify({ error: "Tavily search did not return a result." });
}

async function runSearchApiSearch(request: SearchRequest): Promise<string> {
  const {
    query,
    search_type = "text",
    num,
    gl = "",
    hl = "",
    time_period,
    include_domains,
    exclude_domains = [],
    timeout,
    extract_content,
  } = request;

  if (extract_content) {
    logger.warn("[web_search] SearchApi fallback does not support raw content extraction; returning snippets only.");
  }

  const result = await webSearchQueue.add(async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeout ?? DEFAULT_TIMEOUT_MS,
    );

    const isImage = search_type === "image";
    const maxResults = Math.min(Math.max(num ?? 5, 1), 20);
    const url = new URL(SEARCHAPI_ENDPOINT);
    url.searchParams.set("api_key", SEARCH_API_KEY);
    url.searchParams.set("engine", isImage ? "google_images" : "google");
    url.searchParams.set("q", applyDomainFilters(query, include_domains, exclude_domains));
    url.searchParams.set("num", String(maxResults));
    if (gl) url.searchParams.set("gl", gl);
    if (hl) url.searchParams.set("hl", hl);

    const tbs = mapSearchApiTimePeriod(time_period);
    if (tbs) url.searchParams.set("tbs", tbs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.headers.get("content-type")?.includes("application/json")) {
      const text = await response.text();
      return JSON.stringify({
        error: `Unexpected response format from SearchApi: ${text.slice(0, 200)}`,
      });
    }

    const responseBody = (await response.json()) as SearchApiResponse;
    if (response.status >= 400 || responseBody.error) {
      const detail = responseBody.error || response.statusText;
      logger.warn(`[web_search] SearchApi FAILED: ${response.status} ${detail}`);
      return JSON.stringify({ status: response.status, error: detail });
    }

    const organicResults: Array<Record<string, unknown>> = isImage
      ? (responseBody.images_results ?? []).map(formatSearchApiImageResult)
      : (responseBody.organic_results ?? []).map(formatSearchApiTextResult);

    const aiOverview = responseBody.answer_box?.answer ?? responseBody.answer_box?.snippet ?? null;
    const formatted: Record<string, unknown> = {
      provider: "searchapi",
      query: responseBody.search_parameters?.q ?? query,
      ai_overview: aiOverview,
      organic_results: organicResults,
      response_time:
        responseBody.search_metadata?.total_time_taken ??
        responseBody.search_metadata?.total_time_taken_displayed,
    };

    logger.info(
      `[web_search] (searchapi) Success: ${organicResults.length} results in ${formatted.response_time ?? "?"}s`,
    );

    return stringifyCappedResult(formatted, organicResults);
  });
  return result ?? JSON.stringify({ error: "SearchApi search did not return a result." });
}

export const webSearchTool = tool(
  async ({
    query = "毫米波雷达技术",
    search_type = "text",
    num,
    gl = "",
    hl = "",
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
    const provider = TAVILY_API_KEY ? "tavily" : SEARCH_API_KEY ? "searchapi" : "none";
    logger.info(
      `[web_search] (${provider}) query="${query}" type=${search_type ?? "text"} num=${num ?? "default"}`,
    );

    if (!TAVILY_API_KEY && !SEARCH_API_KEY) {
      return JSON.stringify({
        error:
          "Web search API key is missing. Set TAVILY_API_KEY or SEARCH_API_KEY in the environment.",
      });
    }

    if (
      search_type === "image" &&
      (image_size || image_color || image_type || aspect_ratio)
    ) {
      logger.warn(
        `[web_search] image filters (size/color/type/aspect_ratio) are ignored by ${provider}.`,
      );
    }

    try {
      const request: SearchRequest = {
        query,
        search_type,
        num,
        gl,
        hl,
        time_period,
        extract_content,
        search_depth,
        topic,
        include_domains,
        exclude_domains,
        timeout,
        image_size,
        image_color,
        image_type,
        aspect_ratio,
      };
      return TAVILY_API_KEY
        ? await runTavilySearch(request)
        : await runSearchApiSearch(request);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[web_search] Error during ${provider} search: ${errMsg}`);
      return JSON.stringify({ error: errMsg });
    }
  },
  {
    name: "web_search",
    description:
      "Search the web via Tavily, falling back to SearchApi.io when Tavily is not configured. Supports text search and image search. " +
      "Returns structured results: { query, ai_overview, organic_results: [{ title, link, snippet, content, ... }] }. " +
      "Set extract_content=true to include raw markdown content when the active provider supports it.",
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


