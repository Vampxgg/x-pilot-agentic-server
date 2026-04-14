import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { extractContentFromUrl } from "../../utils/content-extractor.js";
import PQueue from "p-queue";

const SEARCH_API_KEY = process.env.SEARCH_API_KEY || "YOUR_DEFAULT_API_KEY_IF_ANY";

const EXTRACT_TIMEOUT_MS = 15_000;
const OUTPUT_MAX_CHARS = 50_000;

// Global concurrency queue for web searches
const webSearchQueue = new PQueue({ concurrency: 3 });

function formatOrganicResult(res: Record<string, unknown>, extractedContent?: string | null) {
  const base: Record<string, unknown> = {
    title: res.title ?? "",
    link: res.link ?? "",
    source: res.source ?? "",
    domain: res.domain ?? "",
    snippet: res.snippet ?? "",
    date: res.date ?? "",
    thumbnail: res.thumbnail ?? "",
    images: Array.isArray(res.images) ? res.images : res.images ? [res.images] : [],
    content: extractedContent ?? "",
  };
  return base;
}

export const webSearchTool = tool(
  async ({ query, search_type, num, gl, hl, time_period, time_period_min, time_period_max, image_size, image_color, image_type, aspect_ratio, timeout }) => {
    logger.info(`[web_search] Searching for: "${query}" (type: ${search_type ?? "text"})`);

    if (!SEARCH_API_KEY || SEARCH_API_KEY === "YOUR_DEFAULT_API_KEY_IF_ANY") {
      return JSON.stringify({
        error: "Search API Key is missing. Please set SEARCH_API_KEY in the environment.",
      });
    }

    try {
      return await webSearchQueue.add(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout ?? 30_000);

        const engine = search_type === "image" ? "google_images" : "google";
        const params = new URLSearchParams({
          engine,
          q: query,
          api_key: SEARCH_API_KEY,
        });

        if (num) params.append("num", num.toString());
        if (gl) params.append("gl", gl);
        if (hl) params.append("hl", hl);
        if (time_period) params.append("time_period", time_period);
        if (time_period_min) params.append("time_period_min", time_period_min);
        if (time_period_max) params.append("time_period_max", time_period_max);
        
        if (search_type === "image") {
          if (image_size) params.append("size", image_size);
          if (image_color) params.append("color", image_color);
          if (image_type) params.append("image_type", image_type);
          if (aspect_ratio) params.append("aspect_ratio", aspect_ratio);

          // Apply good defaults for generic image search if missing
          if (!image_type) params.append("image_type", "photo");
          if (!image_size) params.append("size", "medium");
        }

        const url = `https://www.searchapi.io/api/v1/search?${params.toString()}`;

        const response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
        });

        clearTimeout(timer);

        let responseBody: Record<string, unknown>;
        if (response.headers.get("content-type")?.includes("application/json")) {
          responseBody = (await response.json()) as Record<string, unknown>;
        } else {
          const text = await response.text();
          return JSON.stringify({ error: `Unexpected response format: ${text.slice(0, 200)}` });
        }

        if (response.status >= 400) {
          logger.warn(`[web_search] FAILED: ${response.status} ${response.statusText}`);
          return JSON.stringify({
            status: response.status,
            error: (responseBody?.error as string) || response.statusText,
          });
        }

        let organicResults: Record<string, unknown>[];

        if (search_type === "image") {
          // Image search results processing
          const images = (responseBody.images as Record<string, unknown>[]) || [];
          organicResults = images.map((res) => {
            const original = res.original as Record<string, unknown> | undefined;
            const source = res.source as Record<string, unknown> | undefined;
            const link = original?.link ?? "";
            
            // Extract domain from link
            let domain = "";
            try {
              if (typeof link === "string" && link.startsWith("http")) {
                domain = new URL(link).hostname;
              }
            } catch {
              // Ignore invalid URLs
            }

            return formatOrganicResult({
              title: res.title,
              link,
              source: source?.name,
              domain,
              thumbnail: res.thumbnail,
            });
          });
        } else {
          // Regular text search results processing
          const organic = (responseBody.organic_results as Record<string, unknown>[]) || [];
          
          if (organic.length > 0) {
            const extractPromises = organic.map((res) => {
              const link = res.link as string;
              if (!link?.startsWith("http")) return Promise.resolve({ content: "", success: false });
              return extractContentFromUrl(link, {
                timeoutMs: EXTRACT_TIMEOUT_MS,
                maxContentLength: 8_000,
              });
            });
            const extractResults = await Promise.all(extractPromises);

            organicResults = organic.map((res, i) => {
              const extracted = extractResults[i]?.success ? extractResults[i].content : null;
              if (extracted) {
                logger.info(`[web_search] Extracted content from position ${i + 1}: ${String((res.link as string) ?? "").slice(0, 50)}...`);
              }
              return formatOrganicResult(res, extracted);
            });
          } else {
            organicResults = [];
          }
        }

        const formattedResults = {
          query: (responseBody.search_information as Record<string, unknown>)?.query_displayed || query,
          ai_overview: (responseBody.ai_overview as Record<string, unknown>)?.markdown ?? null,
          organic_results: organicResults,
        };

        logger.info(`[web_search] Success: Found ${organicResults.length} results.`);

        const str = JSON.stringify(formattedResults);
        return str.slice(0, OUTPUT_MAX_CHARS);
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[web_search] Error during search: ${errMsg}`);
      return JSON.stringify({
        error: errMsg,
      });
    }
  },
  {
    name: "web_search",
    description:
      "Search the web using Google Search via SearchApi.io. Supports regular web search and image search. " +
      "Returns structured results with title, link, snippet, and page content.",
    schema: z.object({
      query: z.string().min(1).describe("The search query terms."),
      search_type: z.enum(["text", "image"]).optional().default("text").describe("Search engine type. 'text' for regular web pages, 'image' for Google Images."),
      num: z.number().int().optional().describe("Number of results to request."),
      gl: z.string().optional().describe("Country code for search (e.g. 'us', 'cn')."),
      hl: z.string().optional().describe("Interface language (e.g. 'en', 'zh-cn')."),
      time_period: z.enum([
        "last_1_minute", "last_5_minutes", "last_15_minutes", "last_30_minutes", 
        "last_hour", "last_day", "last_week", "last_month", "last_year"
      ]).optional().describe("Restrict results based on predefined date ranges."),
      time_period_min: z.string().optional().describe("Start of custom time period (MM/DD/YYYY)."),
      time_period_max: z.string().optional().describe("End of custom time period (MM/DD/YYYY)."),
      image_size: z.enum(["large", "medium", "icon", "larger_than_400x300", "larger_than_640x480", "larger_than_800x600", "larger_than_1024x768", "larger_than_2mp"]).optional().describe("Image size filter for image search"),
      image_color: z.enum(["black_and_white", "color", "transparent", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "white", "gray", "black", "brown"]).optional().describe("Image color filter"),
      image_type: z.enum(["clipart", "line_drawing", "gif", "face", "photo"]).optional().describe("Image type filter"),
      aspect_ratio: z.enum(["square", "tall", "wide", "panoramic"]).optional().describe("Image aspect ratio filter"),
      timeout: z.number().optional().describe("Request timeout in ms (default 30s)"),
    }),
  }
);
