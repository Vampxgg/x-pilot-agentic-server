/**
 * Manual test script for web_search tool.
 * Run: npx tsx tests/tools/web-search.test.ts
 * Requires: SEARCH_API_KEY in .env
 */
import "dotenv/config";
import { webSearchTool } from "../../src/tools/built-in/web-search.js";

async function main() {
  console.log("=== web_search 工具测试 ===\n");

  // 1. 基础搜索（无 extract_content）
  console.log("1. 基础搜索 (extract_content: false)");
  const basicResult = await webSearchTool.invoke({
    query: "Python programming",
    num: 3,
  });
  const basic = JSON.parse(basicResult as string);
  if (basic.error) {
    console.error("  错误:", basic.error);
  } else {
    console.log("  query:", basic.query);
    console.log("  organic_results 数量:", basic.organic_results?.length ?? 0);
    if (basic.organic_results?.length) {
      const first = basic.organic_results[0];
      console.log("  第一条: position=%s, title=%s, link=%s", first.position, first.title?.slice(0, 50), first.link?.slice(0, 50));
      console.log("  含 thumbnail:", !!first.thumbnail);
      console.log("  含 extracted_content:", "extracted_content" in first);
    }
    console.log("  knowledge_graph:", basic.knowledge_graph ? "有" : "无");
    console.log("  inline_images:", basic.inline_images ? "有" : "无");
  }
  console.log("");

  // 2. 带 extract_content 的搜索（会抓取前几条 URL 正文）
  console.log("2. 带 extract_content: true 的搜索");
  const extractResult = await webSearchTool.invoke({
    query: "Node.js fetch API",
    num: 3,
    extract_content: true,
  });
  const extract = JSON.parse(extractResult as string);
  if (extract.error) {
    console.error("  错误:", extract.error);
  } else {
    console.log("  organic_results 数量:", extract.organic_results?.length ?? 0);
    let withContent = 0;
    for (const r of extract.organic_results ?? []) {
      if (r.extracted_content && String(r.extracted_content).length > 0) {
        withContent++;
        console.log("  - [%s] %s: 已提取 %s 字符", r.position, r.title?.slice(0, 40), String(r.extracted_content).length);
      }
    }
    console.log("  成功提取正文的条数:", withContent);
  }
  console.log("\n=== 测试完成 ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
