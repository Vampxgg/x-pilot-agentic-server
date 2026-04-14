/**
 * Standalone script to test web_search tool.
 * Run: npx tsx scripts/test-web-search.ts
 * Requires SEARCH_API_KEY in .env
 */

import "dotenv/config";
import { webSearchTool } from "../src/tools/built-in/web-search.js";

async function main() {
  console.log("=== web_search 工具测试 ===\n");

  // Test 1: 基础搜索（不提取正文）
  console.log("1. 基础搜索 (extract_content=false)");
  const result1 = await webSearchTool.invoke({
    query: "JavaScript 最新版本",
    num: 3,
  });
  const data1 = JSON.parse(typeof result1 === "string" ? result1 : JSON.stringify(result1));
  if (data1.error) {
    console.error("  错误:", data1.error);
    process.exit(1);
  }
  console.log("  query:", data1.query);
  console.log("  organic_results 数量:", data1.organic_results?.length ?? 0);
  if (data1.organic_results?.[0]) {
    const first = data1.organic_results[0];
    console.log("  第1条:", {
      position: first.position,
      title: (first.title as string)?.slice(0, 50),
      link: (first.link as string)?.slice(0, 50),
      has_thumbnail: !!first.thumbnail,
      has_images: Array.isArray(first.images) && first.images.length > 0,
    });
  }
  console.log("  search_metadata:", data1.search_metadata ? "有" : "无");
  console.log("  knowledge_graph:", data1.knowledge_graph ? "有" : "无");
  console.log("");

  // Test 2: 带 extract_content 的搜索
  console.log("2. 带正文提取 (extract_content=true)");
  const result2 = await webSearchTool.invoke({
    query: "Node.js 官网",
    num: 2,
    extract_content: true,
  });
  const data2 = JSON.parse(typeof result2 === "string" ? result2 : JSON.stringify(result2));
  if (data2.error) {
    console.error("  错误:", data2.error);
  } else {
    const withContent = data2.organic_results?.filter((r: any) => r.extracted_content) ?? [];
    console.log("  有 extracted_content 的结果数:", withContent.length);
    if (withContent[0]) {
      const content = withContent[0].extracted_content as string;
      console.log("  第1条 extracted_content 长度:", content?.length ?? 0);
      console.log("  预览:", content?.slice(0, 200).replace(/\n/g, " ") + "...");
    }
  }

  console.log("\n=== 测试完成 ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
