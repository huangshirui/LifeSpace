import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/external-field-binding.ts", import.meta.url), "utf8");

describe("External field binding query budget", () => {
  it("chunks current source IDs and candidate keys instead of historical model rows", () => {
    expect(source).toContain("chunkD1Values(sourceIds, 1)");
    expect(source).toContain("chunkD1Values(candidateKeys, 1)");
    expect(source).not.toContain("ORDER BY source_field_id");
  });
});
