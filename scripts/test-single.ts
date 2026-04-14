import { readFileSync } from "fs";
import { join } from "path";

const PAYLOADS_DIR = join(process.cwd(), "tests", "payloads");
const API_URL = "http://127.0.0.1:3000/api/business/document-generation/generate-stream";

async function main() {
  const filename = "payload-test-0317-4.json";
  const filePath = join(PAYLOADS_DIR, filename);
  const payloadStr = readFileSync(filePath, "utf-8");
  const payload = JSON.parse(payloadStr);

  payload.sessionId = `single-test-${Date.now()}`;
  console.log(`Starting single test with sessionId: ${payload.sessionId}`);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer x-pilot-default-key"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    if (!response.body) throw new Error("No response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        console.log("------------------------");
        console.log(chunk);
      }
    }
    console.log("Done reading stream.");
  } catch (err) {
    console.error(`Failed:`, err);
  }
}

main().catch(console.error);