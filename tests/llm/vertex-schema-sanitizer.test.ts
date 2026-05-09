import { describe, expect, it } from "vitest";
import { sanitizeJsonSchemaForGemini } from "../../src/llm/vertex-schema-sanitizer.js";

describe("sanitizeJsonSchemaForGemini", () => {
  it("removes Gemini-forbidden schema keys and drops empty object properties", () => {
    const cleaned = sanitizeJsonSchemaForGemini({
      type: "object",
      additionalProperties: false,
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {
        query: { type: "string", default: "" },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["query", "metadata"],
    });

    expect(cleaned).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    });
  });

  it("converts nullable unions into a single Gemini-compatible nullable schema", () => {
    const cleaned = sanitizeJsonSchemaForGemini({
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Optional label",
    });

    expect(cleaned).toEqual({
      type: "string",
      description: "Optional label",
      nullable: true,
    });
  });
});
