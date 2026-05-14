import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { logger } from "../utils/logger.js";

const DATA_DIR = resolve(process.cwd(), "data");
const COVERS_DIR = join(DATA_DIR, "tutorials");

/** env: PLAYWRIGHT_WS_ENDPOINT=ws://localhost:3001/ */
const WS_ENDPOINT = process.env.PLAYWRIGHT_WS_ENDPOINT ?? "ws://localhost:3001/";

export interface ScreenshotOptions {
  url: string;
  sessionId: string;
  /** Viewport width, default 1280 */
  width?: number;
  /** Viewport height, default 800 */
  height?: number;
  /** Wait ms after load before capture, default 2000 */
  waitAfterLoad?: number;
}

export interface ScreenshotResult {
  filePath: string;
  /** Relative path from data dir, for serving via /api/files/ */
  publicPath: string;
}

let browserInstance: import("playwright").Browser | null = null;

async function getBrowser(): Promise<import("playwright").Browser> {
  if (browserInstance?.isConnected()) return browserInstance;

  const { chromium } = await import("playwright");
  browserInstance = await chromium.connect(WS_ENDPOINT);
  logger.info(`[screenshot] Connected to Playwright Server at ${WS_ENDPOINT}`);
  return browserInstance;
}

export async function captureScreenshot(opts: ScreenshotOptions): Promise<ScreenshotResult> {
  const {
    url,
    sessionId,
    width = 1280,
    height = 800,
    waitAfterLoad = 2000,
  } = opts;

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

    if (waitAfterLoad > 0) {
      await page.waitForTimeout(waitAfterLoad);
    }

    // Remote browser: screenshot returns buffer, save locally
    const buffer = await page.screenshot({ type: "png" });

    const coverDir = join(COVERS_DIR, sessionId);
    await mkdir(coverDir, { recursive: true });

    const filePath = join(coverDir, "cover.png");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, buffer);

    const publicPath = `tutorials/${sessionId}/cover.png`;
    logger.info(`[screenshot] Captured cover for session=${sessionId} → ${publicPath}`);

    return { filePath, publicPath };
  } finally {
    await context.close();
  }
}

export async function shutdownBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}
