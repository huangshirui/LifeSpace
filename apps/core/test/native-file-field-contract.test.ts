import { describe, expect, it } from "vitest";
import { normalizeCanonicalFieldValue } from "../src/generic-resource";
import { validateModelDefinition } from "../src/model-definition";
import { compilePhysicalSchema } from "../src/physical-schema";

const fileId = "fil_0123456789abcdef0123456789abcdef";

function definition(type: "file" | "file_list") {
  return {
    definitionVersion: 1 as const,
    key: `file_${type.replaceAll("_", "")}`,
    display: { singular: "File holder", plural: "File holders" },
    access: ["read", "write"] as const,
    fields: { attachment: { type } },
  };
}

describe("Native File canonical field contract", () => {
  it("accepts file and file_list as Canonical Field Types with stable IDs", () => {
    for (const type of ["file", "file_list"] as const) {
      const result = validateModelDefinition(definition(type));
      expect(result.valid).toBe(true);
    }
    expect(normalizeCanonicalFieldValue("attachment", { type: "file" }, fileId)).toBe(fileId);
    expect(normalizeCanonicalFieldValue("attachment", { type: "file_list" }, [fileId])).toEqual([fileId]);
  });

  it("rejects malformed and duplicate file identities", () => {
    expect(() => normalizeCanonicalFieldValue("attachment", { type: "file" }, "https://example.com/a.pdf")).toThrow();
    expect(() => normalizeCanonicalFieldValue("attachment", { type: "file_list" }, [fileId, fileId])).toThrow();
  });

  it("stores one file as scalar identity and file_list as JSON without scalar indexes", () => {
    const one = validateModelDefinition(definition("file"));
    const many = validateModelDefinition(definition("file_list"));
    if (!one.valid || !many.valid) throw new Error("fixture invalid");
    const onePlan = compilePhysicalSchema(one.definition);
    const manyPlan = compilePhysicalSchema(many.definition);
    expect(onePlan.columns.find((column) => column.logicalFieldKey === "attachment")?.sqlType).toBe("TEXT");
    expect(manyPlan.columns.find((column) => column.logicalFieldKey === "attachment")?.checkSql).toContain("json_type");
  });
});
