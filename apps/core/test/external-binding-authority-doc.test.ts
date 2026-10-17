import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const docs = readFileSync(new URL("../../../docs/external-field-key-rules.md", import.meta.url), "utf8");

describe("External field binding authority", () => {
  it("documents persisted binding as authoritative before latest snapshot", () => {
    expect(docs).toContain("persisted independently from the replaceable latest schema snapshot");
    expect(docs).toContain("Schema refresh resolves the persisted binding as authoritative before persisting the latest snapshot");
  });
});
