import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import PQueue from "p-queue";
import { logger } from "../utils/logger.js";

const DEFAULT_IMAGE_MODEL = "google/gemini-3-pro-image-preview";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_DATA_DIR = resolve(process.cwd(), "data");

const imageGenerationQueue = new PQueue({ concurrency: 2 });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenerateImageResult {
  buffer: Buffer;
  mimeType: string;
  prompt: string;
  model: string;
}

export interface GenerateAndSaveResult {
  filePath: string;
  fileName: string;
  imageUrl: string;
  prompt: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Pure generation — returns raw buffer, no storage side effects
// ---------------------------------------------------------------------------

export async function generateImageBuffer(
  prompt: string,
  opts?: { model?: string; timeoutMs?: number },
): Promise<GenerateImageResult> {
  return imageGenerationQueue.add(async () => {
    const model = opts?.model ?? process.env.IMAGE_GENERATE_MODEL ?? DEFAULT_IMAGE_MODEL;
    const timeoutMs = opts?.timeoutMs ?? 90_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (/gemini/i.test(model)) {
        return await generateBufferViaChatCompletions(model, prompt, controller.signal);
      }
      return await generateBufferViaDallE(model, prompt, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }) as Promise<GenerateImageResult>;
}

// ---------------------------------------------------------------------------
// Generate + save to session workspace (used by image_generate tool)
// ---------------------------------------------------------------------------

export async function generateAndSaveToWorkspace(
  prompt: string,
  tenantId: string,
  userId: string,
  sessionId?: string,
  opts?: { model?: string; timeoutMs?: number },
): Promise<GenerateAndSaveResult> {
  const result = await generateImageBuffer(prompt, opts);

  const ext = extFromMime(result.mimeType);
  const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  const outputDir = resolveImageDir(tenantId, userId, sessionId);

  await mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, fileName);
  await writeFile(filePath, result.buffer);

  const imageUrl = buildSessionImageUrl(fileName, tenantId, userId, sessionId);

  return { filePath, fileName, imageUrl, prompt: result.prompt, model: result.model };
}

// ---------------------------------------------------------------------------
// Gemini via OpenRouter Chat Completions
// ---------------------------------------------------------------------------

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      images?: Array<{ image_url?: { url?: string } }>;
    };
  }>;
  error?: { message?: string };
}

async function generateBufferViaChatCompletions(
  model: string,
  prompt: string,
  signal: AbortSignal,
): Promise<GenerateImageResult> {
  const apiKey = process.env.IMAGE_GENERATE_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured for image generation");

  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      modalities: ["image", "text"],
    }),
    signal,
  });

  const body = (await response.json()) as OpenRouterChatResponse;
  if (!response.ok) {
    throw new Error(body.error?.message ?? `OpenRouter API error: ${response.status}`);
  }

  const choice = body.choices?.[0]?.message;
  const imageDataUrl = choice?.images?.[0]?.image_url?.url;
  if (!imageDataUrl) {
    throw new Error("No image returned in Gemini response");
  }

  const match = imageDataUrl.match(/^data:image\/([^;]+);base64,(.+)$/s);
  if (!match) throw new Error("Invalid base64 data URL format from Gemini");

  const mimeType = `image/${match[1]}`;
  const buffer = Buffer.from(match[2], "base64");

  return { buffer, mimeType, prompt, model };
}

// ---------------------------------------------------------------------------
// DALL-E / OpenAI Images Generations
// ---------------------------------------------------------------------------

interface DallEResponse {
  data?: Array<{ url?: string; revised_prompt?: string }>;
  error?: { message?: string };
}

async function generateBufferViaDallE(
  model: string,
  prompt: string,
  signal: AbortSignal,
): Promise<GenerateImageResult> {
  const apiUrl = process.env.IMAGE_GENERATE_API_URL ?? "https://api.openai.com/v1/images/generations";
  const apiKey = process.env.IMAGE_GENERATE_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("IMAGE_GENERATE_API_KEY / OPENAI_API_KEY is not configured");

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, n: 1, size: "1024x1024", style: "natural", response_format: "url" }),
    signal,
  });

  const body = (await response.json()) as DallEResponse;
  if (!response.ok) {
    throw new Error(body.error?.message ?? `DALL-E API error: ${response.status}`);
  }

  const imageUrl = body.data?.[0]?.url;
  if (!imageUrl) throw new Error("No image URL returned in DALL-E response");

  const imgResp = await fetch(imageUrl);
  if (!imgResp.ok) throw new Error(`Failed to download DALL-E image: ${imgResp.status}`);

  const buffer = Buffer.from(await imgResp.arrayBuffer());
  return { buffer, mimeType: "image/png", prompt, model };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
    "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
  };
  return map[mimeType] ?? "jpg";
}

function resolveImageDir(tenantId: string, userId: string, sessionId?: string): string {
  if (sessionId) {
    return join(DEFAULT_DATA_DIR, "tenants", tenantId, "users", userId, "workspaces", sessionId, "assets", "images");
  }
  return join(DEFAULT_DATA_DIR, "tenants", tenantId, "users", userId, "artifacts", "assets", "images");
}

function buildSessionImageUrl(fileName: string, tenantId: string, userId: string, sessionId?: string): string {
  const serveBaseUrl = process.env.IMAGE_SERVE_BASE_URL;
  const subPath = sessionId
    ? `tenants/${tenantId}/users/${userId}/workspaces/${sessionId}/assets/images/${fileName}`
    : `tenants/${tenantId}/users/${userId}/artifacts/assets/images/${fileName}`;
  if (serveBaseUrl) return `${serveBaseUrl.replace(/\/$/, "")}/${subPath}`;
  return `/api/files/${subPath}`;
}
