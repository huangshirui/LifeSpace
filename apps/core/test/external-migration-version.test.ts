import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../migrations/0066_external_field_binding_index_cleanup.sql", import.meta.url), "utf8");

describe("External field binding migration", () => {
  it("removes only the redundant ordinary index and advances schema version", () => {
    expect(migration).toContain("DROP INDEX IF EXISTS idx_external_field_bindings_key");
    expect(migration).toContain("value='66'");
    expect(migration).not.toContain("DROP TABLE");
  });
});
