import { describe, expect, it } from "vitest";
import { DAY_RECORD_MODEL_DEFINITION } from "../src/builtin-models";
import { validateModelDefinition } from "../src/model-definition";

function codes(input: unknown): string[] {
  const result = validateModelDefinition(input);
  return result.valid ? [] : result.issues.map((issue) => issue.code);
}

describe("Capability Model Definition", () => {
  it("accepts the registered Temporal capability mapping", () => {
    const result = validateModelDefinition(DAY_RECORD_MODEL_DEFINITION);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.definition.capabilities?.temporal).toMatchObject({
      kindField: "kind",
      anchorDateField: "anchorDate",
      cycleDaysField: "cycleDays",
      occurrences: true,
    });
  });

  it("rejects unknown capabilities", () => {
    const input = structuredClone(DAY_RECORD_MODEL_DEFINITION) as typeof DAY_RECORD_MODEL_DEFINITION;
    (input.capabilities as unknown as Record<string, unknown>).executeSql = { enabled: true };
    expect(codes(input)).toContain("UNSUPPORTED_CAPABILITY");
  });

  it("rejects temporal mappings to the wrong field type", () => {
    const input = structuredClone(DAY_RECORD_MODEL_DEFINITION) as typeof DAY_RECORD_MODEL_DEFINITION;
    input.capabilities!.temporal!.anchorDateField = "name";
    expect(codes(input)).toContain("INVALID_CAPABILITY_FIELD_TYPE");
  });

  it("requires temporal kind and status enums to expose the platform vocabulary", () => {
    const input = structuredClone(DAY_RECORD_MODEL_DEFINITION) as typeof DAY_RECORD_MODEL_DEFINITION;
    input.fields.kind = { type: "enum", required: true, immutable: true, values: ["elapsed", "countdown"] };
    expect(codes(input)).toContain("INVALID_TEMPORAL_KIND_ENUM");
  });
});
