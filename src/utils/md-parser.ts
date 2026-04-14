import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface ParsedMarkdown {
  content: string;
  metadata: Record<string, unknown>;
}

export async function parseMarkdownFile(filePath: string): Promise<ParsedMarkdown | null> {
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf-8");
  const { data, content } = matter(raw);
  return { content: content.trim(), metadata: data };
}

export async function readMarkdownContent(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf-8");
  const { content } = matter(raw);
  return content.trim();
}
