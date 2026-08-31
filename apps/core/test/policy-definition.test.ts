import { describe, expect, it } from "vitest";
import { WISH_MODEL_DEFINITION } from "../src/builtin-models";
import { validateModelDefinition } from "../src/model-definition";

function codes(input: unknown): string[] {
  const result = validateModelDefinition(input);
  return result.valid ? [] : result.issues.map((issue) => issue.code);
}

describe("Policy Model Definition", () => {
  it("accepts Wish actor/input/record policies", () => {
    const result = validateModelDefinition(WISH_MODEL_DEFINITION);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.definition.policies?.create).toBeTruthy();
    expect(result.definition.policies?.update).toBeTruthy();
    expect(result.definition.actions?.fulfill.policy).toBeTruthy();
    expect(result.definition.actions?.reopen.policy).toBeTruthy();
  });

  it("rejects arbitrary policy references", () => {
    const input = structuredClone(WISH_MODEL_DEFINITION) as typeof WISH_MODEL_DEFINITION;
    input.policies!.create = {
      op: "eq",
      left: { $ref: "sql.current_user" },
      right: { value: "x" },
    };
    expect(codes(input)).toContain("INVALID_POLICY_REFERENCE");
  });

  it("rejects record-aware read policies until the query compiler can enforce them before pagination", () => {
    const input = structuredClone(WISH_MODEL_DEFINITION) as typeof WISH_MODEL_DEFINITION;
    input.policies!.read = {
      op: "eq",
      left: { $ref: "record.ownerPersonId" },
      right: { $ref: "actor.personId" },
    };
    expect(codes(input)).toContain("POLICY_RECORD_REFERENCE_NOT_ALLOWED");
  });

  it("rejects input references from delete policies", () => {
    const input = structuredClone(WISH_MODEL_DEFINITION) as typeof WISH_MODEL_DEFINITION;
    input.policies!.delete = {
      op: "eq",
      left: { $ref: "input.ownerPersonId" },
      right: { $ref: "actor.personId" },
    };
    expect(codes(input)).toContain("POLICY_INPUT_REFERENCE_NOT_ALLOWED");
  });

  it("bounds policy nesting", () => {
    const input = structuredClone(WISH_MODEL_DEFINITION) as typeof WISH_MODEL_DEFINITION;
    let nested: unknown = { op: "neq", left: { $ref: "actor.personId" }, right: { value: null } };
    for (let i = 0; i < 10; i += 1) nested = { not: nested };
    input.policies!.read = nested as never;
    expect(codes(input)).toContain("POLICY_TOO_DEEP");
  });
});
