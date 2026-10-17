import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const docs = readFileSync(new URL("../../../docs/external-models.md", import.meta.url), "utf8");

describe("External Provider schema compatibility contract", () => {
  it("requires type, metadata and stable-identity mapping for every Provider Adapter", () => {
    expect(docs).toContain("Type Mapping");
    expect(docs).toContain("Metadata Mapping");
    expect(docs).toContain("Stable Identity Mapping");
    for (const classification of ["provider-native", "adapter-derived", "unsupported", "provider-only"]) {
      expect(docs).toContain(classification);
    }
  });
});
