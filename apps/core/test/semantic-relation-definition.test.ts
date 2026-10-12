import { describe, expect, it } from "vitest";
import { validateModelDefinition } from "../src/model-definition";
import {
  semanticRelationAllowsEndpoints,
  semanticRelationDiscovery,
} from "../src/semantic-relation-definition";

function definition(key: string, outgoing: string[]) {
  return {
    definitionVersion: 1,
    key,
    display: { singular: "Fixture", plural: "Fixtures" },
    fields: {
      name: { type: "string", required: true },
    },
    semanticRelations: { outgoing },
    access: ["read", "write"],
  };
}

describe("Semantic Relation Model Definition", () => {
  it("accepts governed predicates for an allowed source model without adding a field type", () => {
    const result = validateModelDefinition(definition("task", ["generated_from", "relates_to"]));
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.definition.semanticRelations).toEqual({
      outgoing: ["generated_from", "relates_to"],
    });
    expect(Object.values(result.definition.fields).some((field) => field.type === ("semantic_relation" as never)))
      .toBe(false);
  });

  it("rejects unknown predicates and predicates that do not allow the source model", () => {
    const unknown = validateModelDefinition(definition("task", ["invented_by_agent"]));
    expect(unknown.valid).toBe(false);
    if (!unknown.valid) {
      expect(unknown.issues.some((entry) => entry.code === "UNKNOWN_SEMANTIC_RELATION_PREDICATE"))
        .toBe(true);
    }

    const wrongSource = validateModelDefinition(definition("task", ["based_on"]));
    expect(wrongSource.valid).toBe(false);
    if (!wrongSource.valid) {
      expect(wrongSource.issues.some((entry) => entry.code === "SEMANTIC_RELATION_SOURCE_NOT_ALLOWED"))
        .toBe(true);
    }
  });

  it("discovers registered endpoint constraints from a model declaration", () => {
    expect(semanticRelationAllowsEndpoints("generated_from", "task", "health_regimen")).toBe(true);
    expect(semanticRelationAllowsEndpoints("generated_from", "task", "custom_plan")).toBe(true);

    const discovery = semanticRelationDiscovery("task", {
      outgoing: ["generated_from", "relates_to"],
    });
    expect(discovery).toEqual([
      expect.objectContaining({
        predicate: "generated_from",
        direction: "outgoing",
        targetModels: ["*"],
      }),
      expect.objectContaining({
        predicate: "relates_to",
        direction: "outgoing",
        targetModels: ["*"],
      }),
    ]);
  });
});
