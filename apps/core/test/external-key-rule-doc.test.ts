import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const docs = readFileSync(new URL("../../../docs/external-field-key-rules.md", import.meta.url), "utf8");

describe("External field key rule documentation", () => {
  it("keeps key generation deterministic and AI-independent", () => {
    expect(docs).toContain("does not depend on AI/translation");
    expect(docs).toContain("ID -> id<suffix>");
    expect(docs).toContain("Provider rename never regenerates it");
    expect(docs).toContain("does not scan all historical bindings");
  });
});
