import { describe, expect, it } from "vitest";
import { FIELD_TYPES, validateModelDefinition } from "../src/model-definition";
import { compilePhysicalSchema } from "../src/physical-schema";

function definition(
  field: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    definitionVersion: 1,
    key: "temporal_oracle",
    display: { singular: "Temporal Oracle", plural: "Temporal Oracles" },
    fields: {
      when: {
        type: "temporal_range",
        ...field,
      },
    },
    access: ["read", "write"],
    ...extra,
  };
}

function issueCodes(input: unknown): string[] {
  const result = validateModelDefinition(input);
  return result.valid ? [] : result.issues.map((entry) => entry.code);
}

describe("Model Definition temporal_range independent Oracle fixtures", () => {
  // Oracle-Fixture: ORC-FIELD-TEMPORAL-RANGE-01
  // Covers: MDV1-FIELD-TYPES-01, MDV1-FIELD-CONSTRAINTS-01
  it("recognizes a controlled temporal_range field without physical storage semantics", () => {
    expect(FIELD_TYPES).toContain("temporal_range");

    const result = validateModelDefinition(definition());
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.definition.fields.when).toEqual({ type: "temporal_range" });
    expect(() => compilePhysicalSchema(result.definition)).toThrow(
      "requires the temporal_range physical mapping implementation",
    );
  });

  // Oracle-Fixture: ORC-FIELD-TEMPORAL-RANGE-CONSTRAINTS-01
  // Covers: MDV1-FIELD-CONSTRAINTS-01
  it.each([
    ["minLength", 1],
    ["maxLength", 10],
    ["minimum", 0],
    ["maximum", 100],
    ["values", ["date", "instant"]],
    ["targetModel", "event"],
  ])("rejects the inapplicable %s property", (property, value) => {
    expect(issueCodes(definition({ [property]: value }))).toContain("INVALID_CONSTRAINT");
  });

  // Oracle-Fixture: ORC-FIELD-TEMPORAL-RANGE-DEFAULT-01
  // Covers: MDV1-DEFAULTS-01
  it("rejects every temporal_range default, including null", () => {
    const canonicalValue = {
      kind: "date",
      start: "2026-09-20",
      endExclusive: "2026-09-21",
    };
    expect(issueCodes(definition({}, { defaults: { when: canonicalValue } }))).toContain("INVALID_DEFAULT");
    expect(issueCodes(definition({ nullable: true }, { defaults: { when: null } }))).toContain("INVALID_DEFAULT");
  });

  // Oracle-Fixture: ORC-FIELD-TEMPORAL-RANGE-QUERY-GATE-01
  // Covers: MDV1-QUERY-GENERIC-01
  it.each(["searchable", "filterable", "sortable"])(
    "fails closed for the %s query role until typed query support exists",
    (role) => {
      expect(issueCodes(definition({}, { query: { [role]: ["when"] } }))).toContain(
        "UNSUPPORTED_QUERY_FIELD_TYPE",
      );
    },
  );
});
