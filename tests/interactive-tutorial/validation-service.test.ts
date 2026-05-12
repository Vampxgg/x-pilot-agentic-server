import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertAssetGraphComplete } from "../../apps/interactive-tutorial/code/build/validation-service.js";

const TEST_DIR = resolve(process.cwd(), ".test-data", "interactive-tutorial-validation");

describe("assertAssetGraphComplete", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(resolve(TEST_DIR, "assets", "components"), { recursive: true });
    mkdirSync(resolve(TEST_DIR, "assets", "pages"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("fails fast when blueprint components are missing before assemble", async () => {
    writeFileSync(resolve(TEST_DIR, "assets", "App.tsx"), "export default [];\n", "utf-8");

    await expect(
      assertAssetGraphComplete(
        resolve(TEST_DIR, "assets", "App.tsx"),
        resolve(TEST_DIR, "assets", "components"),
        resolve(TEST_DIR, "assets", "pages"),
        {
          components: [{ file_name: "IntersectionMap.tsx" }],
        },
        "[CODEGEN ERROR]",
      ),
    ).rejects.toThrow("[CODEGEN ERROR]");
  });
});
