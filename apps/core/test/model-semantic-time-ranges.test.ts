import { describe, expect, it } from "vitest";
import { EVENT_MODEL_DEFINITION } from "../src/builtin-models";
import type { ModelDefinition } from "../src/model-definition";
import { projectModelSemanticFacts } from "../src/model-semantic-projection";
import type { PublishedModel } from "../src/model-registry";

function published(definition: ModelDefinition): PublishedModel {
  return {
    id: `mdl_${definition.key}`,
    key: definition.key,
    version: 1,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: "initial",
    definition,
    publishedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("progressive static time-range semantics", () => {
  it("projects declared structural ranges without inventing a query operator", () => {
    const definition: ModelDefinition = {
      definitionVersion: 1,
      key: "availability_window",
      display: { singular: "Availability Window", plural: "Availability Windows" },
      fields: {
        label: { type: "string", required: true },
        validFrom: { type: "datetime", nullable: true },
        validUntil: { type: "datetime", nullable: true },
      },
      timeRanges: {
        validity: { startField: "validFrom", endField: "validUntil", bounds: "[)" },
      },
      access: ["read", "write"],
    };

    const semantic = projectModelSemanticFacts(published(definition));
    expect(semantic.timeRanges).toEqual([
      {
        key: "validity",
        startField: "validFrom",
        endField: "validUntil",
        valueType: "datetime",
        bounds: "[)",
        source: "model",
      },
    ]);
    expect(semantic.query.capabilityParameters).toEqual([]);
    expect(semantic.query.filters).toEqual([]);
  });

  it("derives Calendar timed/all-day ranges from the Capability binding as the sole source", () => {
    expect(EVENT_MODEL_DEFINITION.timeRanges).toBeUndefined();
    const semantic = projectModelSemanticFacts(published(EVENT_MODEL_DEFINITION));
    expect(semantic.timeRanges).toEqual([
      {
        key: "calendar.allDay",
        startField: "startDate",
        endField: "endDateExclusive",
        valueType: "date",
        bounds: "[)",
        source: "capability",
        capability: "calendar",
      },
      {
        key: "calendar.timed",
        startField: "startAt",
        endField: "endAt",
        valueType: "datetime",
        bounds: "[)",
        source: "capability",
        capability: "calendar",
      },
    ]);
  });
});
