import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("interactive tutorial template ecosystem", () => {
  it("contains resizable ui primitive in template reserved zone", async () => {
    const resizablePath = resolve(
      process.cwd(),
      "../template_rander/src/components/ui/resizable.tsx",
    );
    const content = await readFile(resizablePath, "utf-8");
    expect(content).toContain("react-resizable-panels");
    expect(content).toContain("ResizablePanelGroup");
    expect(content).toContain("export { ResizableHandle, ResizablePanel, ResizablePanelGroup };");
  });
});
