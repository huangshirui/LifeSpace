import { describe, expect, it } from "vitest";
import { validateDefinition } from "../src/model-registry";

function definition(type: "enum_list" | "file_ref_list") {
  return {
    definitionVersion: 1,
    key: `native_${type}`,
    display: { singular: "Synthetic", plural: "Synthetic" },
    fields: {
      value: {
        type,
        ...(type === "enum_list" ? { values: ["a", "b"] } : {}),
      },
    },
    query: { filterable: ["value"] },
    access: ["read", "write"],
  };
}

describe("Native collection query contract", () => {
  for (const type of ["enum_list", "file_ref_list"] as const) {
    it(`rejects ${type} as Native filterable without a bounded Native query projection`, async () => {
      const result = await validateDefinition(definition(type));
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "query.filterable",
          code: "UNSUPPORTED_QUERY_FIELD_TYPE",
        }),
      ]));
    });
  }
});
