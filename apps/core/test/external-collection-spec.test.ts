import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const spec = readFileSync(new URL("../../../docs/model-definition-collection-types.md", import.meta.url), "utf8");

describe("Canonical collection field type specification", () => {
  it("documents enum_list and file_ref_list as provider-neutral canonical values", () => {
    expect(spec).toContain("`enum_list`");
    expect(spec).toContain("`file_ref_list`");
    expect(spec).toContain("MDV1-COLLECTION-FIELD-TYPES-01");
    expect(spec).toContain("at most 100 entries");
    expect(spec).toContain("at most 50 declared options");
  });
});
