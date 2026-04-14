/**
 * Large text chunking for document generation.
 * Splits long large_text by section headers or paragraph boundaries
 * so that only relevant chunks are passed per section, avoiding context overflow.
 */

export interface LargeTextChunk {
  id: string;
  sectionRef: string;
  excerpt: string;
  charStart: number;
  charEnd: number;
}

const DEFAULT_MAX_CHARS = 4000;

// Markdown heading patterns: ## Title, ### Title, **1.1 Title**, etc.
const HEADING_PATTERN = /^(#{1,6}\s+.+|\*\*[\d.]+\s*.+\*\*|\*\*[一二三四五六七八九十]+[、．.]*.+\*\*|[一二三四五六七八九十]+[、．.].+)$/m;

function extractSectionRef(line: string): string {
  const stripped = line.replace(/^#+\s*|\*\*/g, "").trim();
  return stripped || "(无标题)";
}

function splitLongSection(
  excerpt: string,
  sectionRef: string,
  charStart: number,
  maxChars: number,
): { excerpt: string; charStart: number; charEnd: number }[] {
  const parts: { excerpt: string; charStart: number; charEnd: number }[] = [];
  let remainder = excerpt;
  let offset = charStart;
  while (remainder.length > maxChars) {
    const window = remainder.slice(0, maxChars);
    const lastBreak = window.lastIndexOf("\n\n");
    const splitAt = lastBreak > maxChars * 0.5 ? lastBreak + 2 : maxChars;
    const part = remainder.slice(0, splitAt);
    parts.push({ excerpt: part.trim(), charStart: offset, charEnd: offset + part.length });
    offset += splitAt;
    remainder = remainder.slice(splitAt);
  }
  if (remainder.trim().length > 0) {
    parts.push({ excerpt: remainder.trim(), charStart: offset, charEnd: offset + remainder.length });
  }
  return parts;
}

/**
 * Chunk large_text by section boundaries. Each chunk is capped at maxChars.
 * Sections are identified by markdown headers (##, ###) or numbered list headers (**1.1**, **一、**).
 */
export function chunkLargeText(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): LargeTextChunk[] {
  if (!text || text.length === 0) return [];
  if (text.length <= maxChars) {
    return [{
      id: "chunk-0",
      sectionRef: "(全文)",
      excerpt: text,
      charStart: 0,
      charEnd: text.length,
    }];
  }

  const chunks: LargeTextChunk[] = [];
  const lines = text.split("\n");
  let currentSection = "(全文)";
  let currentExcerpt = "";
  let chunkStart = 0;
  let charPos = 0;
  let chunkIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineWithNewline = i < lines.length - 1 ? line + "\n" : line;

    if (HEADING_PATTERN.test(line.trim())) {
      const newSection = extractSectionRef(line);
      if (currentExcerpt.trim().length > 0) {
        const parts = splitLongSection(currentExcerpt.trim(), currentSection, chunkStart, maxChars);
        for (const p of parts) {
          chunks.push({
            id: `chunk-${chunkIndex}`,
            sectionRef: currentSection,
            excerpt: p.excerpt,
            charStart: p.charStart,
            charEnd: p.charEnd,
          });
          chunkIndex++;
        }
      }
      currentSection = newSection;
      currentExcerpt = lineWithNewline;
      chunkStart = charPos;
    } else {
      currentExcerpt += lineWithNewline;
    }
    charPos += lineWithNewline.length;
  }

  if (currentExcerpt.trim().length > 0) {
    const parts = splitLongSection(currentExcerpt.trim(), currentSection, chunkStart, maxChars);
    for (const p of parts) {
      chunks.push({
        id: `chunk-${chunkIndex}`,
        sectionRef: currentSection,
        excerpt: p.excerpt,
        charStart: p.charStart,
        charEnd: p.charEnd,
      });
      chunkIndex++;
    }
  }

  return chunks;
}

/**
 * Get chunks for a specific section by fuzzy matching sectionRef.
 */
export function getChunksForSection(
  chunks: LargeTextChunk[],
  sectionHeading: string,
): LargeTextChunk[] {
  const normalized = sectionHeading.replace(/\*\*/g, "").trim();
  return chunks.filter(
    (c) =>
      c.sectionRef.includes(normalized) ||
      normalized.includes(c.sectionRef) ||
      c.sectionRef === "(全文)",
  );
}
