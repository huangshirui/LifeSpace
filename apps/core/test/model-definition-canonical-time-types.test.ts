import { describe, expect, it } from "vitest";
import {
  FIELD_TYPES,
  validateModelDefinition,
  type ModelDefinition,
} from "../src/model-definition";
import { canonicalQuerySemanticDescriptor } from "../src/canonical-query-contract";
import { validateCanonicalTemporalDslTransition, type PublishedModel } from "../src/model-registry";
import { compilePhysicalSchema } from "../src/physical-schema";
import { dehydrateTypedResourceData, hydrateTypedResourceData } from "../src/typed-resource-storage";

function definition(
  fields: Record<string, Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    definitionVersion: 1,
    key: "canonical_time_oracle",
    display: { singular: "Canonical Time Oracle", plural: "Canonical Time Oracles" },
    fields,
    access: ["read", "write"],
    ...extra,
  };
}

function validated(input: Record<string, unknown>): ModelDefinition {
  const result = validateModelDefinition(input);
  expect(result.valid).toBe(true);
  if (!result.valid) throw new Error(JSON.stringify(result.issues));
  return result.definition;
}

function published(definition: ModelDefinition): PublishedModel {
  return {
    id: "mdl_test",
    key: definition.key,
    version: 1,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: "initial",
    definition,
    publishedAt: "2026-09-18T00:00:00.000Z",
  };
}

describe("canonical Model Definition time types", () => {
  it("declares instant, range<date>, and range<instant> as first-class field types", () => {
    expect(FIELD_TYPES).toEqual(expect.arrayContaining(["instant", "range<date>", "range<instant>"]));

    const model = validated(definition({
      happenedAt: { type: "instant", required: true },
      stay: { type: "range<date>", nullable: true },
      session: { type: "range<instant>", required: true },
    }, {
      query: { filterable: ["happenedAt", "stay", "session"] },
    }));

    const plan = compilePhysicalSchema(model);
    expect(plan.fieldMappings.find((field) => field.fieldKey === "happenedAt")).toMatchObject({
      logicalType: "instant",
      storage: "scalar",
    });
    expect(plan.fieldMappings.find((field) => field.fieldKey === "stay")).toMatchObject({
      logicalType: "range<date>",
      storage: "range",
      columns: [
        expect.objectContaining({ fieldKey: "__r_stay_start", component: "start" }),
        expect.objectContaining({ fieldKey: "__r_stay_end", component: "end" }),
      ],
    });
    expect(plan.fieldMappings.find((field) => field.fieldKey === "session")).toMatchObject({
      logicalType: "range<instant>",
      storage: "range",
    });
  });

  it("round-trips one logical range value without exposing physical split columns", () => {
    const model = published(validated(definition({
      window: { type: "range<instant>", required: true },
    })));
    const value = {
      window: {
        start: "2026-09-18T01:00:00+00:00",
        endExclusive: "2026-09-18T02:00:00+00:00",
      },
    };

    const stored = dehydrateTypedResourceData(model, value);
    expect(stored).toEqual({
      __r_window_start: "2026-09-18T01:00:00.000Z",
      __r_window_end: "2026-09-18T02:00:00.000Z",
    });
    expect(hydrateTypedResourceData(model, stored, "rec_test")).toEqual({
      window: {
        start: "2026-09-18T01:00:00.000Z",
        endExclusive: "2026-09-18T02:00:00.000Z",
      },
    });
  });

  it("gives first-class ranges typed Canonical Query operators without inventing range sorting", () => {
    const model = published(validated(definition({
      window: { type: "range<date>", nullable: true },
    }, {
      query: { filterable: ["window"] },
    })));

    expect(canonicalQuerySemanticDescriptor(model).filter.targets).toContainEqual(
      expect.objectContaining({
        field: "window",
        kind: "field",
        valueType: "range<date>",
        operators: ["overlaps", "contains", "before", "after", "isNull", "isNotNull"],
      }),
    );

    const sortable = validateModelDefinition(definition(
      { window: { type: "range<date>" } },
      { query: { sortable: ["window"] } },
    ));
    expect(sortable.valid).toBe(false);
    if (sortable.valid) return;
    expect(sortable.issues).toContainEqual(expect.objectContaining({
      code: "UNSUPPORTED_QUERY_FIELD_TYPE",
      path: "query.sortable",
    }));
  });

  it("keeps legacy datetime readable but prevents introducing it in a new publication", () => {
    const legacy = validated(definition({
      happenedAt: { type: "datetime", nullable: true },
    }));
    expect(legacy.fields.happenedAt.type).toBe("datetime");

    expect(validateCanonicalTemporalDslTransition(null, legacy)).toContainEqual(
      expect.objectContaining({
        code: "LEGACY_DATETIME_NOT_PUBLISHABLE",
        path: "fields.happenedAt.type",
      }),
    );

    const preserved = validated(definition({
      happenedAt: { type: "datetime", nullable: true },
      note: { type: "text", nullable: true },
    }));
    expect(validateCanonicalTemporalDslTransition(legacy, preserved)).toEqual([]);

    const migrated = validated(definition({
      happenedAt: { type: "instant", nullable: true },
    }));
    expect(validateCanonicalTemporalDslTransition(legacy, migrated)).toEqual([]);
  });

  it("keeps timeRanges readable only as legacy structural compatibility and blocks new declarations", () => {
    const structural = validated(definition({
      validFrom: { type: "date" },
      validUntil: { type: "date" },
    }, {
      timeRanges: {
        validity: {
          startField: "validFrom",
          endField: "validUntil",
          bounds: "[)",
        },
      },
    }));

    expect(validateCanonicalTemporalDslTransition(null, structural)).toContainEqual(
      expect.objectContaining({
        code: "LEGACY_TIME_RANGE_BINDING_NOT_PUBLISHABLE",
        path: "timeRanges.validity",
      }),
    );
    expect(validateCanonicalTemporalDslTransition(structural, structuredClone(structural))).toEqual([]);

    const removed = structuredClone(structural);
    delete removed.timeRanges;
    expect(validateCanonicalTemporalDslTransition(structural, removed)).toEqual([]);
  });
});
