/**
 * ContentExtractor - Fetches HTML, extracts main content via Readability,
 * converts to Markdown with turndown, and cleans with ContentCleaner.
 * No external Reader API; direct fetch + local processing.
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { ContentCleaner } from "./content-cleaner.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface ExtractOptions {
  timeoutMs?: number;
  maxContentLength?: number;
}

export interface ExtractResult {
  content: string;
  title?: string;
  success: boolean;
  error?: string;
}

/**
 * Extracts main content from a URL. For HTML pages: fetch -> Readability -> turndown -> clean.
 * For non-HTML (PDF, DOCX, etc.), returns empty string (caller can optionally handle elsewhere).
 */
export async function extractContentFromUrl(
  url: string,
  options: ExtractOptions = {}
): Promise<ExtractResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxContentLength = options.maxContentLength ?? 8_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    clearTimeout(timer);

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return {
        content: "",
        success: false,
        error: `Unsupported content-type: ${contentType}. Only HTML pages are extracted.`,
      };
    }

    const html = await response.text();
    const finalUrl = response.url;

    const dom = new JSDOM(html, { url: finalUrl });

    const documentClone = dom.window.document.cloneNode(true) as Document;
    const reader = new Readability(documentClone, { charThreshold: 50 });
    const article = reader.parse();

    if (!article || !article.content?.trim()) {
      return {
        content: "",
        title: article?.title ?? undefined,
        success: false,
        error: "Readability could not extract main content.",
      };
    }

    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    const markdown = turndown.turndown(article.content);

    const cleaner = new ContentCleaner({ maxContentLength });
    const cleaned = cleaner.cleanHtml(markdown);

    return {
      content: cleaned,
      title: article.title ?? undefined,
      success: true,
    };
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: "",
      success: false,
      error: message,
    };
  }
}
