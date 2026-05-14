import { createUserFileTool } from "../apps/interactive-tutorial/code/tools-user-file.ts";

const tenantId = "default";
const userId = "default";
const sessionId = process.argv[2];
const fileId = process.argv[3];
if (!sessionId || !fileId) {
  console.error("usage: tsx scripts/smoke-user-file.mjs <sessionId> <fileId>");
  process.exit(2);
}

const tool = createUserFileTool(tenantId, userId, sessionId);

console.log("--- list ---");
console.log(await tool.invoke({ action: "list" }));

console.log("\n--- read first time (extract + cache) ---");
const t1 = Date.now();
const r1 = await tool.invoke({ action: "read", fileId, maxChars: 1000 });
console.log(`elapsed=${Date.now() - t1}ms`);
console.log(r1);

console.log("\n--- read second time (cache hit) ---");
const t2 = Date.now();
const r2 = await tool.invoke({ action: "read", fileId, maxChars: 1000 });
console.log(`elapsed=${Date.now() - t2}ms`);
console.log(r2);
