import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export type FileKind = "doc" | "image" | "audio" | "video" | "data" | "unknown";

export interface ExtractableFile {
  storedName: string;
  mimeType: string;
  kind: FileKind;
  size: number;
}

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

const MAX_CHARS = 200_000;
const MAX_PARSE_BYTES = 30 * 1024 * 1024;

const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".log",
  ".json", ".yaml", ".yml", ".html", ".htm", ".xml", ".srt", ".vtt",
]);

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function extractText(file: ExtractableFile, absPath: string): Promise<ExtractResult> {
  const mt = file.mimeType.toLowerCase();
  const ext = extname(file.storedName).toLowerCase();

  if (file.size > MAX_PARSE_BYTES && (file.kind === "doc" || file.kind === "data")) {
    return { ok: false, reason: `document too large to parse: ${file.size} bytes (limit ${MAX_PARSE_BYTES})` };
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
