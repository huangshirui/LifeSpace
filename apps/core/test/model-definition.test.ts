import { describe, expect, it } from "vitest";
import { TASK_MODEL_DEFINITION } from "../src/builtin-models";
import { canonicalModelDefinition, validateModelDefinition } from "../src/model-definition";

function issueCodes(result: ReturnType<typeof validateModelDefinition>) {
  return result.valid ? [] : result.issues.map((issue) => issue.code);
}

describe("Model Definition v1", () => {
  it("accepts the first metadata-driven Task definition", () => {
    const result = validateModelDefinition(TASK_MODEL_DEFINITION);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.definition.key).toBe("task");
    expect(result.definition.route).toBe("tasks");
    expect(result.definition.fields.assigneePersonIds.type).toBe("person_list");
    expect(result.definition.defaults).toEqual({ status: "pending" });
    expect(result.definition.lifecycle).toEqual({ optimisticConcurrency: true, softDelete: true });
    expect(result.hashInput).toBe(canonicalModelDefinition(result.definition));
  });

  it("canonicalizes definitions independently of object insertion order", () => {
    const first = canonicalModelDefinition(TASK_MODEL_DEFINITION);
    const reordered = {
      ...TASK_MODEL_DEFINITION,
      fields: Object.fromEntries(Object.entries(TASK_MODEL_DEFINITION.fields).reverse()),
    };
    expect(canonicalModelDefinition(reordered)).toBe(first);
  });

  it("normalizes omitted lifecycle metadata to the same Runtime invariants", () => {
    const { lifecycle: _lifecycle, ...withoutLifecycle } = TASK_MODEL_DEFINITION;
    const explicit = validateModelDefinition(TASK_MODEL_DEFINITION);
    const omitted = validateModelDefinition(withoutLifecycle);

    expect(explicit.valid).toBe(true);
    expect(omitted.valid).toBe(true);
    if (!explicit.valid || !omitted.valid) return;

    expect(omitted.definition.lifecycle).toEqual({ optimisticConcurrency: true, softDelete: true });
    expect(omitted.hashInput).toBe(explicit.hashInput);
  });

  it("rejects attempts to disable Generic Runtime lifecycle invariants", () => {
    for (const lifecycle of [
      { optimisticConcurrency: false, softDelete: true },
      { optimisticConcurrency: true, softDelete: false },
    ]) {
      const result = validateModelDefinition({ ...TASK_MODEL_DEFINITION, lifecycle });
      expect(issueCodes(result)).toContain("UNSUPPORTED_LIFECYCLE_OVERRIDE");
    }
  });

  it("rejects defaults for undeclared or incompatible fields", () => {
    const unknown = validateModelDefinition({
      ...TASK_MODEL_DEFINITION,
      defaults: { status: "pending", missing: "x" },
    });
    expect(issueCodes(unknown)).toContain("UNKNOWN_DEFAULT_FIELD");

    const incompatible = validateModelDefinition({
      ...TASK_MODEL_DEFINITION,
      defaults: { status: "not-a-status" },
    });
    expect(issueCodes(incompatible)).toContain("INVALID_DEFAULT");
  });

  it("does not allow hard-coded Person identifiers as model defaults", () => {
    const result = validateModelDefinition({
      ...TASK_MODEL_DEFINITION,
      defaults: { assigneePersonIds: ["per_fixed"] },
    });
    expect(issueCodes(result)).toContain("INVALID_DEFAULT");
  });

  it("rejects routes owned by the Kernel Space namespace", () => {
    for (const route of ["members", "changes", "agent-delegations", "creation-drafts"]) {
      const result = validateModelDefinition({
        ...TASK_MODEL_DEFINITION,
        key: `custom_${route.replaceAll("-", "_")}`,
        route,
      });
      expect(issueCodes(result), route).toContain("RESERVED_ROUTE");
    }
  });

  it("does not reserve unrelated top-level Kernel route names inside a Space", () => {
    const result = validateModelDefinition({
      ...TASK_MODEL_DEFINITION,
      key: "custom_spaces",
      route: "spaces",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects undeclared query fields", () => {
    const result = validateModelDefinition({
      ...TASK_MODEL_DEFINITION,
      query: { ...TASK_MODEL_DEFINITION.query, filterable: ["status", "notAField"] },
    });
    expect(issueCodes(result)).toContain("UNKNOWN_QUERY_FIELD");
  });

  it("rejects arbitrary capability names", () => {
    const result = validateModelDefinition({ ...TASK_MODEL_DEFINITION, capabilities: ["execute_sql"] });
    expect(issueCodes(result)).toContain("UNSUPPORTED_CAPABILITY");
  });

  it("rejects unknown properties rather than treating metadata as executable escape hatches", () => {
    const result = validateModelDefinition({ ...TASK_MODEL_DEFINITION, sql: "DROP TABLE spaces" });
    expect(issueCodes(result)).toContain("UNKNOWN_PROPERTY");
  });

  it("requires record relations to identify a typed target model", () => {
    const result = validateModelDefinition({
      ...TASK_MODEL_DEFINITION,
      fields: {
        ...TASK_MODEL_DEFINITION.fields,
        parent: { type: "record" },
      },
    });
    expect(issueCodes(result)).toContain("TARGET_MODEL_REQUIRED");
  });
});
