import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "../src/model-definition";
import { genericComparisonFieldSemantics } from "../src/query-semantics";

const definition: ModelDefinition = {
  definitionVersion: 1,
  key: "query_semantic_oracle",
  display: { singular: "Query Semantic Oracle", plural: "Query Semantic Oracles" },
  fields: {
    name: { type: "string", required: true },
    score: { type: "number", nullable: true },
    happenedAt: { type: "datetime", nullable: true },
    day: { type: "date", nullable: true },
  },
  query: { filterable: ["score", "happenedAt", "day"] },
  access: ["read"],
};

describe("Generic comparison query semantics", () => {
  // Oracle-Fixture: ORC-QUERY-COMPARISON-01
  // Covers: MDV1-QUERY-COMPARISON-01, MDV1-QUERY-LOCAL-DATE-WINDOW-01
  it("projects frozen legacy aliases plus collision-free explicit operators and envelope fields", () => {
    const semantics = genericComparisonFieldSemantics(definition);
    const score = semantics.find((entry) => entry.field === "score");
    expect(score).toEqual({
      field: "score",
      source: "model",
      valueType: "number",
      operators: [
        { operator: "eq", parameter: "score", transport: "legacy" },
        { operator: "gte", parameter: "scoreFrom", transport: "legacy" },
        { operator: "lte", parameter: "scoreTo", transport: "legacy" },
        { operator: "eq", parameter: "score.eq", transport: "explicit" },
        { operator: "lt", parameter: "score.lt", transport: "explicit" },
        { operator: "lte", parameter: "score.lte", transport: "explicit" },
        { operator: "gt", parameter: "score.gt", transport: "explicit" },
        { operator: "gte", parameter: "score.gte", transport: "explicit" },
      ],
    });

    expect(semantics.find((entry) => entry.field === "happenedAt")?.localDateWindow).toEqual({
      dateStartParameter: "happenedAt.dateStart",
      dateEndExclusiveParameter: "happenedAt.dateEndExclusive",
      timezoneParameter: "happenedAt.timezone",
      bounds: "[)",
      lowerOperator: "gte",
      upperOperator: "lt",
    });
    expect(semantics.find((entry) => entry.field === "day")?.localDateWindow).toBeUndefined();

    for (const field of ["createdAt", "updatedAt"]) {
      const envelope = semantics.find((entry) => entry.field === field);
      expect(envelope?.source).toBe("envelope");
      expect(envelope?.valueType).toBe("datetime");
      expect(envelope?.operators.every((entry) => entry.transport === "explicit")).toBe(true);
      expect(envelope?.operators.map((entry) => entry.operator)).toEqual(["eq", "lt", "lte", "gt", "gte"]);
      expect(envelope?.localDateWindow?.bounds).toBe("[)");
    }
  });
});
