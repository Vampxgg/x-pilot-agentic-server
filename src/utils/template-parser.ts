/**
 * AST-based template parser.
 *
 * Pipeline:
 *   .docx buffer  ──mammoth──▶  HTML string
 *   HTML string   ──rehype───▶  HAST (HTML AST)
 *   HAST          ──extract──▶  TemplateSkeleton (JSON)
 *
 * The skeleton captures headings, tables (with column schemas, merged cells),
 * images, lists, and section boundaries — information that would be lost in a
 * naïve HTML-to-Markdown conversion.  The skeleton is what the Agent receives
 * as its structural blueprint.
 */

import { unified } from "unified";
import rehypeParse from "rehype-parse";
import { toString as hastToString } from "hast-util-to-string";
import type { Element, Root, RootContent } from "hast";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkeletonHeading {
  level: number;
  title: string;
  index: number;
}

export interface SkeletonTableCell {
  text: string;
  colspan: number;
  rowspan: number;
  isHeader: boolean;
}

export interface SkeletonTable {
  index: number;
  caption: string;
  headers: SkeletonTableCell[][];
  bodyRows: SkeletonTableCell[][];
  totalColumns: number;
  hasMergedCells: boolean;
}

export interface SkeletonImage {
  index: number;
  src: string;
  alt: string;
  nearestHeading: string;
}

export interface SkeletonList {
  index: number;
  ordered: boolean;
  items: string[];
  depth: number;
}

export interface SkeletonSection {
  heading: SkeletonHeading;
  contentTypes: Array<"text" | "table" | "image" | "list">;
  tables: SkeletonTable[];
  images: SkeletonImage[];
  lists: SkeletonList[];
  estimatedParagraphs: number;
}

export interface TemplateSkeleton {
  sections: SkeletonSection[];
  flatHeadings: SkeletonHeading[];
  flatTables: SkeletonTable[];
  flatImages: SkeletonImage[];
  totalSections: number;
  totalTables: number;
  totalImages: number;
  hasMergedCells: boolean;
  looksLikeFullTemplate: boolean;
  looksLikeComplexTableTemplate: boolean;
  sourceHtml: string;
}

// ---------------------------------------------------------------------------
// Docx → HTML (rich, structure-preserving)
// ---------------------------------------------------------------------------

export async function convertDocxToHtml(buffer: Buffer): Promise<{ html: string; warnings: string[] }> {
  const mammoth = await import("mammoth");
  const result = await mammoth.default.convertToHtml(
    { buffer },
    {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Heading 4'] => h4:fresh",
        "p[style-name='标题 1'] => h1:fresh",
        "p[style-name='标题 2'] => h2:fresh",
        "p[style-name='标题 3'] => h3:fresh",
        "p[style-name='标题 4'] => h4:fresh",
      ],
    },
  );
  return {
    html: result.value,
    warnings: result.messages.map((m) => m.message),
  };
}

// ---------------------------------------------------------------------------
// HTML → HAST
// ---------------------------------------------------------------------------

function parseHtml(html: string): Root {
  const processor = unified().use(rehypeParse, { fragment: true });
  return processor.parse(html) as Root;
}

// ---------------------------------------------------------------------------
// HAST helpers
// ---------------------------------------------------------------------------

function isElement(node: RootContent): node is Element {
  return node.type === "element";
}

function getTagName(node: RootContent): string | null {
  return isElement(node) ? node.tagName : null;
}

function headingLevel(tag: string): number | null {
  const m = /^h([1-6])$/i.exec(tag);
  return m ? Number(m[1]) : null;
}

function getAttr(el: Element, name: string): string {
  const val = el.properties?.[name];
  if (val == null) return "";
  return String(val);
}

function intAttr(el: Element, name: string, fallback: number): number {
  const v = Number(getAttr(el, name));
  return Number.isFinite(v) && v >= 1 ? v : fallback;
}

// ---------------------------------------------------------------------------
// Table extraction
// ---------------------------------------------------------------------------

function extractTable(el: Element, index: number): SkeletonTable {
  let caption = "";
  const headers: SkeletonTableCell[][] = [];
  const bodyRows: SkeletonTableCell[][] = [];
  let hasMergedCells = false;
  let maxCols = 0;

  for (const child of el.children) {
    if (!isElement(child)) continue;

    if (child.tagName === "caption") {
      caption = hastToString(child).trim();
      continue;
    }

    const isHead = child.tagName === "thead";
    const target = isHead ? headers : bodyRows;

    const rows = child.tagName === "tr" ? [child] : child.children.filter(isElement).filter((c) => c.tagName === "tr");

    for (const row of rows) {
      const cells: SkeletonTableCell[] = [];
      for (const cell of row.children.filter(isElement)) {
        if (cell.tagName !== "td" && cell.tagName !== "th") continue;
        const colspan = intAttr(cell, "colSpan", 1);
        const rowspan = intAttr(cell, "rowSpan", 1);
        if (colspan > 1 || rowspan > 1) hasMergedCells = true;

        cells.push({
          text: hastToString(cell).trim(),
          colspan,
          rowspan,
          isHeader: isHead || cell.tagName === "th",
        });
      }
      if (cells.length > 0) {
        target.push(cells);
        const rowCols = cells.reduce((sum, c) => sum + c.colspan, 0);
        if (rowCols > maxCols) maxCols = rowCols;
      }
    }
  }

  return { index, caption, headers, bodyRows, totalColumns: maxCols, hasMergedCells };
}

// ---------------------------------------------------------------------------
// Skeleton extraction
// ---------------------------------------------------------------------------

export function extractSkeleton(html: string): TemplateSkeleton {
  const tree = parseHtml(html);
  const flatHeadings: SkeletonHeading[] = [];
  const flatTables: SkeletonTable[] = [];
  const flatImages: SkeletonImage[] = [];
  const allLists: SkeletonList[] = [];

  let elementIndex = 0;
  let lastHeadingTitle = "";

  for (const node of tree.children) {
    if (!isElement(node)) continue;

    const tag = node.tagName;
    const hLevel = headingLevel(tag);

    if (hLevel) {
      const title = hastToString(node).trim();
      flatHeadings.push({ level: hLevel, title, index: elementIndex });
      lastHeadingTitle = title;
    }

    if (tag === "table") {
      flatTables.push(extractTable(node, elementIndex));
    }

    // Recursively find images
    walkForImages(node, flatImages, elementIndex, lastHeadingTitle);

    // Lists
    if (tag === "ol" || tag === "ul") {
      const items: string[] = [];
      for (const li of node.children.filter(isElement)) {
        if (li.tagName === "li") items.push(hastToString(li).trim());
      }
      allLists.push({ index: elementIndex, ordered: tag === "ol", items, depth: 0 });
    }

    elementIndex++;
  }

  // Build sections grouped by headings
  const sections = buildSections(flatHeadings, flatTables, flatImages, allLists, tree);

  const hasMergedCells = flatTables.some((t) => t.hasMergedCells);
  const looksLikeFullTemplate = flatHeadings.length >= 6 || html.length >= 10_000;
  const looksLikeComplexTableTemplate = flatTables.length >= 2 && flatTables.some((t) => t.totalColumns >= 6);

  return {
    sections,
    flatHeadings,
    flatTables,
    flatImages,
    totalSections: sections.length,
    totalTables: flatTables.length,
    totalImages: flatImages.length,
    hasMergedCells,
    looksLikeFullTemplate,
    looksLikeComplexTableTemplate,
    sourceHtml: html,
  };
}

function walkForImages(node: Element, images: SkeletonImage[], parentIndex: number, nearestHeading: string): void {
  if (node.tagName === "img") {
    images.push({
      index: parentIndex,
      src: getAttr(node, "src"),
      alt: getAttr(node, "alt"),
      nearestHeading,
    });
  }
  for (const child of node.children) {
    if (isElement(child)) {
      walkForImages(child, images, parentIndex, nearestHeading);
    }
  }
}

function buildSections(
  headings: SkeletonHeading[],
  tables: SkeletonTable[],
  images: SkeletonImage[],
  lists: SkeletonList[],
  tree: Root,
): SkeletonSection[] {
  if (headings.length === 0) {
    const section: SkeletonSection = {
      heading: { level: 1, title: "(document root)", index: 0 },
      contentTypes: [],
      tables,
      images,
      lists,
      estimatedParagraphs: tree.children.filter((n) => isElement(n) && n.tagName === "p").length,
    };
    inferContentTypes(section);
    return [section];
  }

  const sections: SkeletonSection[] = [];

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i]!;
    const nextIndex = i + 1 < headings.length ? headings[i + 1]!.index : Infinity;

    const sectionTables = tables.filter((t) => t.index > current.index && t.index < nextIndex);
    const sectionImages = images.filter((img) => img.index > current.index && img.index < nextIndex);
    const sectionLists = lists.filter((l) => l.index > current.index && l.index < nextIndex);

    let paragraphs = 0;
    for (let j = current.index + 1; j < Math.min(nextIndex, tree.children.length); j++) {
      const n = tree.children[j];
      if (n && isElement(n) && n.tagName === "p") paragraphs++;
    }

    const section: SkeletonSection = {
      heading: current,
      contentTypes: [],
      tables: sectionTables,
      images: sectionImages,
      lists: sectionLists,
      estimatedParagraphs: paragraphs,
    };
    inferContentTypes(section);
    sections.push(section);
  }

  return sections;
}

function inferContentTypes(section: SkeletonSection): void {
  const types = new Set<"text" | "table" | "image" | "list">();
  if (section.estimatedParagraphs > 0) types.add("text");
  if (section.tables.length > 0) types.add("table");
  if (section.images.length > 0) types.add("image");
  if (section.lists.length > 0) types.add("list");
  section.contentTypes = Array.from(types);
}

// ---------------------------------------------------------------------------
// Skeleton → compact text representation for LLM prompt
// ---------------------------------------------------------------------------

export function skeletonToPromptText(skeleton: TemplateSkeleton): string {
  const lines: string[] = [];
  lines.push("=== 模板结构骨架 (AST extracted) ===");
  lines.push(`总章节: ${skeleton.totalSections} | 总表格: ${skeleton.totalTables} | 总图片: ${skeleton.totalImages}`);
  lines.push(`完整模板: ${skeleton.looksLikeFullTemplate ? "是" : "否"} | 含合并单元格: ${skeleton.hasMergedCells ? "是" : "否"} | 复杂表格模板: ${skeleton.looksLikeComplexTableTemplate ? "是" : "否"}`);
  lines.push("");

  for (const section of skeleton.sections) {
    const h = section.heading;
    const prefix = "#".repeat(h.level);
    lines.push(`${prefix} ${h.title}`);

    const parts: string[] = [];
    if (section.estimatedParagraphs > 0) parts.push(`${section.estimatedParagraphs}段文本`);
    if (section.lists.length > 0) parts.push(`${section.lists.length}个列表`);

    for (const table of section.tables) {
      const merged = table.hasMergedCells ? ", 含合并单元格" : "";
      const headerCols = table.headers.length > 0
        ? table.headers[0]!.map((c) => c.text || "—").join(" | ")
        : "";
      parts.push(`表格(${table.totalColumns}列${merged}${headerCols ? `: [${headerCols}]` : ""})`);
    }

    for (const img of section.images) {
      parts.push(`图片(alt="${img.alt || "无"}", src="${img.src.slice(0, 60)}")`);
    }

    if (parts.length > 0) {
      lines.push(`  内容: ${parts.join(" | ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Convenience: full pipeline from docx buffer
// ---------------------------------------------------------------------------

export async function parseDocxTemplate(buffer: Buffer): Promise<{
  html: string;
  skeleton: TemplateSkeleton;
  warnings: string[];
}> {
  const { html, warnings } = await convertDocxToHtml(buffer);
  const skeleton = extractSkeleton(html);
  return { html, skeleton, warnings };
}

// ---------------------------------------------------------------------------
// Parse from markdown/plaintext (fallback for non-docx input)
// ---------------------------------------------------------------------------

export function extractSkeletonFromMarkdown(markdown: string): TemplateSkeleton {
  const mdToHtml = markdownToBasicHtml(markdown);
  return extractSkeleton(mdToHtml);
}

function markdownToBasicHtml(md: string): string {
  return md
    .replace(/^######\s+(.+)$/gm, "<h6>$1</h6>")
    .replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>")
    .replace(/^####\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
    .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
    .replace(/^(?!<[hH]|<img)(.+)$/gm, "<p>$1</p>");
}
