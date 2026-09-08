import { describe, expect, it } from "vitest";
import { validateModelDefinition, type ModelDefinition } from "../src/model-definition";
import { diffModelDefinition } from "../src/model-proposal";
import type { PublishedModel } from "../src/model-registry";

function definition(): ModelDefinition {
  return {
    definitionVersion: 1,
    key: "oracle_reference_label",
    display: { singular: "Reference Label Oracle", plural: "Reference Label Oracles" },
    fields: {
      code: { type: "string", required: true },
      name: { type: "string", nullable: true },
      count: { type: "integer", nullable: true },
      ownerPersonId: { type: "person", nullable: true },
      parentRecordId: { type: "record", targetModel: "oracle_parent", nullable: true },
    },
    access: ["read", "write"],
  };
}

function issueCodes(input: unknown): string[] {
  const result = validateModelDefinition(input);
  return result.valid ? [] : result.issues.map((entry) => entry.code);
}

function published(model: ModelDefinition): PublishedModel {
  return {
    id: "mdl_oracle_reference_label",
    key: model.key,
    version: 1,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: "initial",
    definition: model,
    publishedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Model Definition v1 reference-label Oracle", () => {
  // Oracle-Fixture: ORC-REFERENCE-LABEL-01
  // Covers: MDV1-REFERENCE-LABEL-01
  it("checks canonical field/template vocabulary, scalar-only inputs and breaking compatibility from handwritten expectations", () => {
    const fieldModel = { ...definition(), referenceLabel: { field: "name" } };
    const fieldResult = validateModelDefinition(fieldModel);
    expect(fieldResult.valid).toBe(true);
    if (!fieldResult.valid) return;
    expect(fieldResult.definition.referenceLabel).toEqual({ field: "name" });

    const templateModel = { ...definition(), referenceLabel: { template: "{code} · {name} · {count}" } };
    const templateResult = validateModelDefinition(templateModel);
    expect(templateResult.valid).toBe(true);
    if (!templateResult.valid) return;
    expect(templateResult.definition.referenceLabel).toEqual({ template: "{code} · {name} · {count}" });

    expect(issueCodes({ ...definition(), referenceLabel: { field: "name", template: "{name}" } }))
      .toContain("INVALID_REFERENCE_LABEL");
    expect(issueCodes({ ...definition(), referenceLabel: { field: "missing" } }))
      .toContain("UNKNOWN_REFERENCE_LABEL_FIELD");
    expect(issueCodes({ ...definition(), referenceLabel: { field: "ownerPersonId" } }))
      .toContain("INVALID_REFERENCE_LABEL_FIELD_TYPE");
    expect(issueCodes({ ...definition(), referenceLabel: { template: "{parentRecordId}" } }))
      .toContain("INVALID_REFERENCE_LABEL_FIELD_TYPE");
    expect(issueCodes({ ...definition(), referenceLabel: { template: "literal-without-placeholder" } }))
      .toContain("INVALID_REFERENCE_LABEL_TEMPLATE");
    expect(issueCodes({ ...definition(), referenceLabel: { template: Array.from({ length: 9 }, () => "{name}").join("-") } }))
      .toContain("INVALID_REFERENCE_LABEL_TEMPLATE");

    const withoutLabel = definition();
    const withFieldLabel = structuredClone(withoutLabel);
    withFieldLabel.referenceLabel = { field: "name" };
    const addDiff = diffModelDefinition(published(withoutLabel), withFieldLabel);
    expect(addDiff.recommendedCompatibility).toBe("breaking");
    expect(addDiff.breakingReasons).toContain("record reference-label semantics changed");

    const withTemplateLabel = structuredClone(withFieldLabel);
    withTemplateLabel.referenceLabel = { template: "{code} · {name}" };
    const changeDiff = diffModelDefinition(published(withFieldLabel), withTemplateLabel);
    expect(changeDiff.recommendedCompatibility).toBe("breaking");
    expect(changeDiff.breakingReasons).toContain("record reference-label semantics changed");
  });
});
