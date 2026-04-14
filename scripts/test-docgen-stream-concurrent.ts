import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const PAYLOADS_DIR = join(process.cwd(), "tests", "payloads");
const API_URL = "http://127.0.0.1:3000/api/business/document-generation/generate-stream";

async function runTest(filename: string) {
  const startTime = Date.now();
  const filePath = join(PAYLOADS_DIR, filename);
  const payloadStr = readFileSync(filePath, "utf-8");
  
  let payload: any;
  try {
    payload = JSON.parse(payloadStr);
  } catch (err) {
    return { filename, success: false, error: "Invalid JSON", durationMs: 0 };
  }

  // Ensure sessionId is unique for each request to avoid workspace conflicts
  payload.sessionId = `test-session-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  console.log(`[${filename}] Starting request with sessionId: ${payload.sessionId}...`);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer x-pilot-default-key" // Using default key from config
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    let eventCount = 0;
    let finalSessionInfo = null;
    let firstTokenTime = 0;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        
        if (chunk.includes("event: token") && firstTokenTime === 0) {
            firstTokenTime = Date.now() - startTime;
        }

        if (chunk.includes("event: session_info")) {
            const match = chunk.match(/data: (.*)\n/);
            if (match && match[1]) {
                finalSessionInfo = JSON.parse(match[1]);
            }
        }
        
        if (chunk.includes("event: error")) {
            console.error(`[${filename}] Error event received:`, chunk);
            const endTime = Date.now();
            return { filename, success: false, error: chunk, durationMs: endTime - startTime, eventCount };
        }
        
        // Count roughly how many events we received
        eventCount += (chunk.match(/event:/g) || []).length;
      }
    }

    const endTime = Date.now();
    console.log(`[${filename}] Finished successfully in ${(endTime - startTime) / 1000}s`);
    return { 
        filename, 
        success: true, 
        durationMs: endTime - startTime, 
        timeToFirstTokenMs: firstTokenTime,
        eventCount,
        documentUrl: finalSessionInfo?.data?.documentUrl 
    };

  } catch (err) {
    const endTime = Date.now();
    console.error(`[${filename}] Failed:`, err);
    return { filename, success: false, error: err instanceof Error ? err.message : String(err), durationMs: endTime - startTime };
  }
}

async function main() {
  const files = readdirSync(PAYLOADS_DIR).filter(f => f.endsWith(".json") && f.includes("0317"));
  console.log(`Found ${files.length} test payloads.`);

  console.log("Starting concurrent test execution...");
  const startTime = Date.now();
  
  // Run all requests concurrently
  const promises = files.map(f => runTest(f));
  const results = await Promise.all(promises);
  
  const totalTime = Date.now() - startTime;
  
  console.log("\n================ TEST RESULTS ================\n");
  console.log(`Total concurrent execution time: ${(totalTime / 1000).toFixed(2)}s\n`);
  
  let successCount = 0;
  for (const res of results) {
    console.log(`File: ${res.filename}`);
    console.log(`Status: ${res.success ? "✅ SUCCESS" : "❌ FAILED"}`);
    console.log(`Duration: ${(res.durationMs / 1000).toFixed(2)}s`);
    
    if (res.success) {
        successCount++;
        console.log(`Time to First Token: ${(res.timeToFirstTokenMs / 1000).toFixed(2)}s`);
        console.log(`Total Events Received: ${res.eventCount}`);
        console.log(`Document URL: ${res.documentUrl}`);
    } else {
        console.log(`Error: ${res.error}`);
    }
    console.log("----------------------------------------------");
  }
  
  console.log(`\nSummary: ${successCount}/${files.length} succeeded.`);
}

main().catch(console.error);