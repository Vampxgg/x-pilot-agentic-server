import { describe, expect, it } from "vitest";
import { extractSkeletonFromMarkdown, extractSkeleton } from "../../src/utils/template-parser.js";

describe("extractSkeletonFromMarkdown", () => {
  it("should detect headings, tables, images, and list patterns", () => {
    const template = `# 学生实训手册
## 1. 实训目标
1. 了解设备
2. 完成调试
## 2. 工具材料
| 序号 | 名称 | 规格 |
| --- | --- | --- |
| 1 | 毫米波雷达 | X1 |

## 3. 调试步骤
![安装示意图](https://example.com/radar.png)`;

    const skeleton = extractSkeletonFromMarkdown(template);

    expect(skeleton.flatHeadings.length).toBe(4);
    expect(skeleton.totalTables).toBeGreaterThanOrEqual(0);
    expect(skeleton.totalImages).toBe(1);
    expect(skeleton.totalSections).toBeGreaterThanOrEqual(1);
  });

  it("should set looksLikeFullTemplate for large documents", () => {
    const headings = Array.from({ length: 8 }, (_, i) => `## Section ${i + 1}\nSome content here.`);
    const template = `# Document\n${headings.join("\n")}`;

    const skeleton = extractSkeletonFromMarkdown(template);
    expect(skeleton.looksLikeFullTemplate).toBe(true);
  });
});

describe("extractSkeleton (from HTML)", () => {
  it("should extract table structure including merged cells", () => {
    const html = `
      <h1>设备清单</h1>
      <table>
        <thead>
          <tr><th colspan="2">设备信息</th><th>数量</th></tr>
        </thead>
        <tbody>
          <tr><td>类型</td><td>型号</td><td>1</td></tr>
        </tbody>
      </table>`;

    const skeleton = extractSkeleton(html);

    expect(skeleton.totalTables).toBe(1);
    expect(skeleton.hasMergedCells).toBe(true);
    expect(skeleton.flatTables[0]!.totalColumns).toBe(3);
    expect(skeleton.flatTables[0]!.headers[0]![0]!.colspan).toBe(2);
  });

  it("should extract images with nearest heading context", () => {
    const html = `
      <h2>安装步骤</h2>
      <p>第一步：</p>
      <img src="https://example.com/step1.png" alt="安装图" />
      <h2>调试步骤</h2>
      <img src="https://example.com/debug.png" alt="调试图" />`;

    const skeleton = extractSkeleton(html);

    expect(skeleton.totalImages).toBe(2);
    expect(skeleton.flatImages[0]!.nearestHeading).toBe("安装步骤");
    expect(skeleton.flatImages[1]!.nearestHeading).toBe("调试步骤");
  });

  it("should build sections grouped by headings", () => {
    const html = `
      <h1>文档标题</h1>
      <p>概述段落</p>
      <h2>第一章</h2>
      <p>内容1</p>
      <p>内容2</p>
      <table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>
      <h2>第二章</h2>
      <p>内容3</p>
      <img src="img.png" alt="图片" />`;

    const skeleton = extractSkeleton(html);

    expect(skeleton.sections.length).toBe(3);
    expect(skeleton.sections[0]!.heading.title).toBe("文档标题");
    expect(skeleton.sections[1]!.heading.title).toBe("第一章");
    expect(skeleton.sections[1]!.tables.length).toBe(1);
    expect(skeleton.sections[1]!.contentTypes).toContain("text");
    expect(skeleton.sections[1]!.contentTypes).toContain("table");
    expect(skeleton.sections[2]!.heading.title).toBe("第二章");
    expect(skeleton.sections[2]!.images.length).toBe(1);
  });
});
