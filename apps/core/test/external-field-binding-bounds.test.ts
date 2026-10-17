import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/external-field-binding.ts", import.meta.url), "utf8");

describe("External field binding performance boundary", () => {
  it("does not scan all historical field bindings for one model refresh", () => {
    expect(source).not.toContain("WHERE model_key=? ORDER BY source_field_id");
    expect(source).toContain("source_field_id IN (");
    expect(source).toContain("field_key IN (");
    expect(source).toContain("chunkD1Values");
  });
});
