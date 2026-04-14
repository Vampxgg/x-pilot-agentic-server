/**
 * ContentCleaner - LLM-friendly data cleaning pipeline.
 * Port of Dify DataCleaningPipeline: removes noise (nav, footer, ads, copyright)
 * and normalizes whitespace for clean Markdown output.
 */

const NOISY_PATTERNS: RegExp[] = [
  /^[\-=*#_]{3,}$/,
  /.*\.(html|shtml|htm|php)\s*$/i,
  /.{0,50}(搜狐|网易|腾讯|新浪|登录|注册|版权所有|版权声明).{0,50}$/,
  /\[\d+\]|\[下一页\]|\[上一页\]/,
  /\[(编辑|查看历史|讨论|阅读|来源|原标题)\]/,
  /^\*+\s*\[.*?\]\(.*?\)/,
  /^\s*(分享到|扫描二维码|返回搜狐|查看更多|责任编辑|记者|通讯员)/,
  /^\s*([京公网安备京网文京ICP备]|互联网新闻信息服务许可证|信息网络传播视听节目许可证)/,
];

const LINK_PATTERN = /\[.*?\]\(.*?\)/g;
const EDITOR_PATTERN = /(\(|\[)\s*责任编辑：.*?\s*(\)|\])/g;
const PAGE_NUM_PATTERN =
  /^\s*[-—]\s*\d+\s*[-—]\s*$|^\s*第\s*\d+\s*页\s*(共\s*\d+\s*页)?\s*$|^\s*Page\s+\d+\s*(of\s+\d+)?\s*$/i;

const REPEATED_LINE_THRESHOLD = 3;

export interface ContentCleanerOptions {
  maxContentLength?: number;
}

function isNoisyLine(line: string): boolean {
  const stripped = line.trim();
  if (!stripped) return true;
  for (const pat of NOISY_PATTERNS) {
    if (pat.test(stripped)) return true;
  }
  const links = stripped.match(LINK_PATTERN);
  if (links && links.length > 2 && stripped.length / (links.length + 1) < 30) {
    return true;
  }
  return false;
}

function normalizeWhitespace(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let prevEmpty = false;
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) {
      if (!prevEmpty) out.push("");
      prevEmpty = true;
    } else {
      out.push(stripped);
      prevEmpty = false;
    }
  }
  return out.join("\n").trim();
}

function removeRepeatedHeadersFooters(text: string): string {
  const lines = text.split("\n");
  if (lines.length < 20) return text;
  const lineCounts: Record<string, number> = {};
  for (const line of lines) {
    const s = line.trim();
    if (s && s.length < 100) {
      lineCounts[s] = (lineCounts[s] || 0) + 1;
    }
  }
  const repeated = new Set(
    Object.entries(lineCounts)
      .filter(([, c]) => c >= REPEATED_LINE_THRESHOLD)
      .map(([s]) => s)
  );
  if (repeated.size === 0) return text;
  return lines.filter((l) => !repeated.has(l.trim())).join("\n");
}

export class ContentCleaner {
  private maxContentLength: number;

  constructor(options: ContentCleanerOptions = {}) {
    this.maxContentLength = options.maxContentLength ?? 80_000;
  }

  private truncate(text: string, label: string): string {
    if (text.length > this.maxContentLength) {
      return (
        text.slice(0, this.maxContentLength) +
        `\n\n...[${label}过长，已截断至 ${this.maxContentLength} 字符]`
      );
    }
    return text;
  }

  cleanDocument(text: string): string {
    if (!text) return "";
    let result = removeRepeatedHeadersFooters(text);
    const lines = result.split("\n");
    const cleaned: string[] = [];
    for (const line of lines) {
      if (PAGE_NUM_PATTERN.test(line.trim())) continue;
      if (isNoisyLine(line)) continue;
      const edited = line.replace(EDITOR_PATTERN, "").trim();
      if (edited) cleaned.push(edited);
    }
    result = normalizeWhitespace(cleaned.join("\n"));
    return this.truncate(result, "文档内容");
  }

  cleanHtml(text: string): string {
    if (!text) return "";
    const lines = text.split("\n");
    const cleaned: string[] = [];
    for (const line of lines) {
      if (isNoisyLine(line)) continue;
      const edited = line.replace(EDITOR_PATTERN, "").trim();
      if (edited) cleaned.push(edited);
    }
    const result = normalizeWhitespace(cleaned.join("\n"));
    return this.truncate(result, "网页内容");
  }

  cleanText(text: string): string {
    if (!text) return "";
    return this.truncate(normalizeWhitespace(text), "文本内容");
  }
}
