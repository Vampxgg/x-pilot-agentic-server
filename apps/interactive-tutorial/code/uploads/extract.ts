import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { UploadedFile } from "./types.js";

const MAX_CHARS = 200_000;
const MAX_PARSE_BYTES = 30 * 1024 * 1024;

const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".log",
  ".json", ".yaml", ".yml", ".html", ".htm", ".xml", ".srt", ".vtt",
]);

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * Lazy text extraction — invoked the first time `tutorial_user_file({action:'read'})`
 * touches a given file. P1 supports textual formats with zero new deps; P2 adds
 * PDF/docx/pptx behind dynamic imports so cold-start cost is paid only on demand.
 */
export async function extractText(file: UploadedFile, absPath: string): Promise<ExtractResult> {
  const mt = file.mimeType.toLowerCase();
  const ext = extname(file.storedName).toLowerCase();

  if (file.byteSize > MAX_PARSE_BYTES && (file.kind === "doc" || file.kind === "data")) {
    return { ok: false, reason: `document too large to parse: ${file.byteSize} bytes (limit ${MAX_PARSE_BYTES})` };
  }

  if (mt.startsWith("text/") || mt === "application/json" || TEXT_EXTS.has(ext)) {
    try {
      const raw = await readFile(absPath, "utf-8");
      return { ok: true, text: raw.slice(0, MAX_CHARS) };
    } catch (err) {
      return { ok: false, reason: `text read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (mt === PDF_MIME || ext === ".pdf") {
    try {
      const mod = (await import("pdf-parse")) as unknown as {
        PDFParse: new (opts: { data: Buffer }) => { getText: () => Promise<{ text: string }> };
      };
      const buf = await readFile(absPath);
      const parser = new mod.PDFParse({ data: buf });
      const r = await parser.getText();
      return { ok: true, text: r.text.slice(0, MAX_CHARS) };
    } catch (err) {
      return { ok: false, reason: `pdf-parse failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (mt === DOCX_MIME || ext === ".docx") {
    try {
      const mammoth = await import("mammoth");
      const r = await mammoth.extractRawText({ path: absPath });
      return { ok: true, text: r.value.slice(0, MAX_CHARS) };
    } catch (err) {
      return { ok: false, reason: `mammoth failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (mt === PPTX_MIME || ext === ".pptx") {
    try {
      const mod = (await import("officeparser")) as unknown as {
        parseOffice: (file: string) => Promise<string>;
      };
      const text = await mod.parseOffice(absPath);
      return { ok: true, text: text.slice(0, MAX_CHARS) };
    } catch (err) {
      return { ok: false, reason: `officeparser failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (mt.startsWith("image/") || mt.startsWith("audio/") || mt.startsWith("video/")) {
    return { ok: false, reason: "binary asset (use as URL only)" };
  }

  return { ok: false, reason: `unsupported MIME/ext for text extraction: mime=${mt || "?"} ext=${ext || "?"}` };
}
