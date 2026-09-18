import { describe, expect, it } from "vitest";
import { validateModelDefinition, type ModelDefinition } from "../src/model-definition";
import { diffModelDefinition } from "../src/model-proposal";
import type { PublishedModel } from "../src/model-registry";
import { LEGACY_CALENDAR_MODEL_DEFINITION } from "./legacy-calendar-fixture";

function definition(): ModelDefinition {
  return {
    definitionVersion: 1,
    key: "oracle_time_ranges",
    display: { singular: "Time Range Oracle", plural: "Time Range Oracles" },
    fields: {
      validFrom: { type: "datetime", nullable: true },
      validUntil: { type: "datetime", nullable: true },
      startsOn: { type: "date", nullable: true },
      endsOn: { type: "date", nullable: true },
      name: { type: "string", required: true },
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
    id: "mdl_oracle_time_ranges",
    key: model.key,
    version: 1,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: "initial",
    definition: model,
    publishedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Model Definition v1 timeRanges Oracle", () => {
  // Oracle-Fixture: ORC-TIME-RANGES-01
  // Covers: MDV1-TIME-RANGES-LEGACY-01
  it("normalizes half-open bounds and accepts date/date plus datetime/datetime pairs", () => {
    const result = validateModelDefinition({
      ...definition(),
      timeRanges: {
        validity: { startField: "validFrom", endField: "validUntil" },
        season: { startField: "startsOn", endField: "endsOn", bounds: "[]" },
      },
    });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.definition.timeRanges).toEqual({
      validity: { startField: "validFrom", endField: "validUntil", bounds: "[)" },
      season: { startField: "startsOn", endField: "endsOn", bounds: "[]" },
    });
  });

  it("rejects invalid bounds, non-distinct fields, mismatched types and duplicate/reversed bindings", () => {
    expect(issueCodes({
      ...definition(),
      timeRanges: { invalid: { startField: "validFrom", endField: "validUntil", bounds: "xx" } },
    })).toContain("INVALID_TIME_RANGE_BOUNDS");
    expect(issueCodes({
      ...definition(),
      timeRanges: { invalid: { startField: "validFrom", endField: "validFrom" } },
    })).toContain("TIME_RANGE_FIELDS_NOT_DISTINCT");
    expect(issueCodes({
      ...definition(),
      timeRanges: { invalid: { startField: "validFrom", endField: "endsOn" } },
    })).toContain("MISMATCHED_TIME_RANGE_FIELD_TYPES");
    expect(issueCodes({
      ...definition(),
      timeRanges: {
        first: { startField: "validFrom", endField: "validUntil" },
        second: { startField: "validUntil", endField: "validFrom" },
      },
    })).toContain("DUPLICATE_TIME_RANGE_BINDING");
  });

  it("keeps legacy Calendar scalar-pair bindings authoritative for historical definitions", () => {
    const legacy = structuredClone(LEGACY_CALENDAR_MODEL_DEFINITION) as ModelDefinition;
    legacy.timeRanges = {
      duplicateTimed: { startField: "startAt", endField: "endAt", bounds: "[)" },
    };
    expect(issueCodes(legacy)).toContain("CAPABILITY_TIME_RANGE_COLLISION");
  });

  it("classifies any published time-range semantic change as breaking", () => {
    const before = definition();
    const after = structuredClone(before);
    after.timeRanges = {
      validity: { startField: "validFrom", endField: "validUntil", bounds: "[)" },
    };
    const diff = diffModelDefinition(published(before), after);
    expect(diff.recommendedCompatibility).toBe("breaking");
    expect(diff.breakingReasons).toContain("time-range semantics changed");
  });
});
