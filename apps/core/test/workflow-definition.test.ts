import { describe, expect, it } from "vitest";
import { TASK_MODEL_DEFINITION } from "../src/builtin-models";
import { validateModelDefinition } from "../src/model-definition";

function codes(input: unknown): string[] {
  const result = validateModelDefinition(input);
  return result.valid ? [] : result.issues.map((issue) => issue.code);
}

describe("Workflow Model Definition", () => {
  it("accepts declarative Task complete/reopen actions", () => {
    const result = validateModelDefinition(TASK_MODEL_DEFINITION);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.definition.actions?.complete.set.completedAt).toEqual({ $ref: "now" });
    expect(result.definition.actions?.complete.set.completedByType).toEqual({ $ref: "actor.type" });
    expect(result.definition.actions?.reopen.set.completedAt).toBeNull();
  });

  it("rejects action assignments to undeclared fields", () => {
    const input = structuredClone(TASK_MODEL_DEFINITION) as typeof TASK_MODEL_DEFINITION;
    input.actions!.complete.set.notAField = "value";
    expect(codes(input)).toContain("UNKNOWN_ACTION_FIELD");
  });

  it("rejects arbitrary workflow references", () => {
    const input = structuredClone(TASK_MODEL_DEFINITION) as typeof TASK_MODEL_DEFINITION;
    input.actions!.complete.set.completedAt = { $ref: "execute.sql" } as never;
    expect(codes(input)).toContain("INVALID_ACTION_VALUE");
  });

  it("rejects action access not exposed by the model", () => {
    const input = structuredClone(TASK_MODEL_DEFINITION) as typeof TASK_MODEL_DEFINITION;
    input.actions!.complete.access = "manage";
    expect(codes(input)).toContain("ACTION_ACCESS_NOT_EXPOSED");
  });

  it("rejects incompatible actor references at publish time", () => {
    const input = structuredClone(TASK_MODEL_DEFINITION) as typeof TASK_MODEL_DEFINITION;
    input.actions!.complete.set.completedAt = { $ref: "actor.id" };
    expect(codes(input)).toContain("INCOMPATIBLE_ACTION_REFERENCE");
  });
});
