import { describe, expect, it } from "vitest";
import { validateModelDefinition } from "../src/model-definition";
import { referenceLabelSemantic, renderReferenceLabel } from "../src/reference-label";

function baseDefinition() {
  return {
    definitionVersion: 1 as const,
    key: "reference_label_test",
    route: "reference-label-tests",
    display: { singular: "Reference Label Test", plural: "Reference Label Tests" },
    fields: {
      name: { type: "string" as const, nullable: true },
      date: { type: "date" as const, nullable: true },
      count: { type: "integer" as const, nullable: true },
      active: { type: "boolean" as const, nullable: true },
      ownerPersonId: { type: "person" as const, nullable: true },
    },
    access: ["read" as const, "write" as const],
  };
}

function issueCodes(input: unknown): string[] {
  const result = validateModelDefinition(input);
  return result.valid ? [] : result.issues.map((issue) => issue.code);
}

describe("ordinary-record reference labels", () => {
  it("accepts one canonical scalar field and preserves ID fallback semantics", () => {
    const result = validateModelDefinition({
      ...baseDefinition(),
      referenceLabel: { field: "name" },
    });
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.definition.referenceLabel).toEqual({ field: "name" });
    expect(referenceLabelSemantic(result.definition)).toEqual({
      mode: "field",
      field: "name",
      fallback: "id",
      maxLength: 200,
    });
    expect(renderReferenceLabel(result.definition, "rec_alpha", { name: "Alpha" })).toBe("Alpha");
    expect(renderReferenceLabel(result.definition, "rec_alpha", { name: "   " })).toBe("rec_alpha");
    expect(renderReferenceLabel(result.definition, "rec_alpha", {})).toBe("rec_alpha");
  });

  it("accepts a bounded template over declared scalar fields and falls back when all projected values are empty", () => {
    const result = validateModelDefinition({
      ...baseDefinition(),
      referenceLabel: { template: "{name} · {date} · {count} · {active}" },
    });
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(referenceLabelSemantic(result.definition)).toEqual({
      mode: "template",
      template: "{name} · {date} · {count} · {active}",
      fields: ["name", "date", "count", "active"],
      fallback: "id",
      maxLength: 200,
    });
    expect(renderReferenceLabel(result.definition, "rec_beta", {
      name: "Beta",
      date: "2026-09-07",
      count: 3,
      active: false,
    })).toBe("Beta · 2026-09-07 · 3 · false");
    expect(renderReferenceLabel(result.definition, "rec_beta", {
      name: null,
      date: null,
      count: null,
      active: null,
    })).toBe("rec_beta");
  });

  it("uses the record ID when no explicit referenceLabel is declared", () => {
    const result = validateModelDefinition(baseDefinition());
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(referenceLabelSemantic(result.definition)).toEqual({ mode: "id", fallback: "id", maxLength: 200 });
    expect(renderReferenceLabel(result.definition, "rec_gamma", { name: "Ignored" })).toBe("rec_gamma");
  });

  it("rejects ambiguous, executable-looking, unknown, relation-backed, or unbounded projections", () => {
    expect(issueCodes({ ...baseDefinition(), referenceLabel: { field: "name", template: "{name}" } }))
      .toContain("INVALID_REFERENCE_LABEL");
    expect(issueCodes({ ...baseDefinition(), referenceLabel: { field: "missing" } }))
      .toContain("UNKNOWN_REFERENCE_LABEL_FIELD");
    expect(issueCodes({ ...baseDefinition(), referenceLabel: { field: "ownerPersonId" } }))
      .toContain("INVALID_REFERENCE_LABEL_FIELD_TYPE");
    expect(issueCodes({ ...baseDefinition(), referenceLabel: { template: "{ownerPersonId}" } }))
      .toContain("INVALID_REFERENCE_LABEL_FIELD_TYPE");
    expect(issueCodes({ ...baseDefinition(), referenceLabel: { template: "{{name}}" } }))
      .toContain("INVALID_REFERENCE_LABEL_TEMPLATE");
    expect(issueCodes({ ...baseDefinition(), referenceLabel: { template: "name.toUpperCase()" } }))
      .toContain("INVALID_REFERENCE_LABEL_TEMPLATE");
    expect(issueCodes({ ...baseDefinition(), referenceLabel: { template: Array.from({ length: 9 }, () => "{name}").join("-") } }))
      .toContain("INVALID_REFERENCE_LABEL_TEMPLATE");
    expect(issueCodes({ ...baseDefinition(), referenceLabel: { template: "x".repeat(201) } }))
      .toContain("INVALID_REFERENCE_LABEL_TEMPLATE");
  });

  it("bounds rendered output at 200 characters", () => {
    const result = validateModelDefinition({
      ...baseDefinition(),
      fields: {
        ...baseDefinition().fields,
        name: { type: "text" as const, nullable: true },
      },
      referenceLabel: { field: "name" },
    });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(renderReferenceLabel(result.definition, "rec_long", { name: "x".repeat(500) })).toHaveLength(200);
  });
});
