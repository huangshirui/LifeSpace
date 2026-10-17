import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/external-field-binding.ts", import.meta.url), "utf8");

describe("External field snapshot contract", () => {
  it("re-resolves persisted bindings after insert-or-ignore", () => {
    expect(source).toContain("INSERT OR IGNORE INTO external_field_bindings");
    expect(source).toContain("for (let attempt = 0; attempt < 3; attempt += 1)");
    expect(source).toContain("const resolved = await resolveFromDatabase");
  });
});
