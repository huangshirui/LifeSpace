import { describe, expect, it } from "vitest";
import { canonicalQuerySemanticDescriptor } from "../src/canonical-query-contract";
import { validateResourceData } from "../src/generic-resource";
import { generateModelContract } from "../src/model-contract";
import type { ModelDefinition } from "../src/model-definition";
import { physicalPublicationStatements } from "../src/model-physical-publication";
import type { PublishedModel } from "../src/model-registry";
import { normalizeRegistryCreationDraft } from "../src/registry-creation-draft";
import {
  dehydrateTypedResourceData,
  hydrateTypedResourceData,
} from "../src/typed-resource-storage";

function definition(): ModelDefinition {
  return {
    definitionVersion: 1,
    key: "temporal_record",
    display: { singular: "Temporal Record", plural: "Temporal Records" },
    fields: {
      name: { type: "string", required: true },
      when: { type: "temporal_range", nullable: true },
    },
    access: ["read", "write"],
  };
}

function published(): PublishedModel {
  return {
    id: "mdl_temporal_record",
    key: "temporal_record",
    version: 1,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: "initial",
    definition: definition(),
    publishedAt: "2026-09-15T00:00:00.000Z",
  };
}

describe("TemporalRange CRUD storage", () => {
  it("validates and normalizes canonical resource values", () => {
    const normalized = validateResourceData(definition(), {
      name: "Meeting",
      when: {
        kind: "instant",
        start: "2026-09-20T10:00:00+08:00",
        endExclusive: "2026-09-20T11:00:00+08:00",
      },
    }, "create");

    expect(normalized.when).toEqual({
      kind: "instant",
      start: "2026-09-20T02:00:00.000Z",
      endExclusive: "2026-09-20T03:00:00.000Z",
    });

    expect(() => validateResourceData(definition(), {
      name: "Ambiguous",
      when: {
        kind: "instant",
        start: "2026-09-20T10:00:00",
        endExclusive: "2026-09-20T11:00:00",
      },
    }, "create")).toThrow("absolute RFC 3339");
  });

  it("dehydrates and hydrates date and instant variants through one logical field", () => {
    const model = published();
    const instant = validateResourceData(model.definition, {
      name: "Meeting",
      when: {
        kind: "instant",
        start: "2026-09-20T10:00:00+08:00",
        endExclusive: "2026-09-20T11:00:00+08:00",
      },
    }, "create");
    const storedInstant = dehydrateTypedResourceData(model, instant);
    expect(storedInstant).toEqual({
      name: "Meeting",
      __tr_when_kind: "instant",
      __tr_when_start: "2026-09-20T02:00:00.000Z",
      __tr_when_end: "2026-09-20T03:00:00.000Z",
    });
    expect(hydrateTypedResourceData(model, storedInstant, "rec_instant")).toEqual(instant);

    const date = {
      name: "Holiday",
      when: {
        kind: "date",
        start: "2026-09-20",
        endExclusive: "2026-09-22",
      },
    };
    expect(hydrateTypedResourceData(
      model,
      dehydrateTypedResourceData(model, date),
      "rec_date",
    )).toEqual(date);
  });

  it("preserves nullable absence and rejects partially stored values", () => {
    const model = published();
    expect(dehydrateTypedResourceData(model, { name: "Unscheduled", when: null })).toEqual({
      name: "Unscheduled",
      __tr_when_kind: null,
      __tr_when_start: null,
      __tr_when_end: null,
    });
    expect(hydrateTypedResourceData(model, {
      name: "Unscheduled",
      __tr_when_kind: null,
      __tr_when_start: null,
      __tr_when_end: null,
    }, "rec_null")).toEqual({ name: "Unscheduled", when: null });

    expect(() => hydrateTypedResourceData(model, {
      name: "Corrupt",
      __tr_when_kind: "date",
      __tr_when_start: "2026-09-20",
      __tr_when_end: null,
    }, "rec_corrupt")).toThrow("partially stored");
  });

  it("normalizes Creation Draft ranges and discards invalid inferred values", () => {
    const model = published();
    const normalized = normalizeRegistryCreationDraft({
      status: "ready",
      modelKey: model.key,
      draft: {
        name: "Meeting",
        when: {
          kind: "instant",
          start: "2026-09-20T10:00:00+08:00",
          endExclusive: "2026-09-20T11:00:00+08:00",
        },
      },
      missingFields: [],
      warnings: [],
    }, { models: [model], people: [] });
    expect(normalized.status).toBe("ready");
    if (normalized.status !== "ready") return;
    expect(normalized.draft.when).toEqual({
      kind: "instant",
      start: "2026-09-20T02:00:00.000Z",
      endExclusive: "2026-09-20T03:00:00.000Z",
    });

    const invalid = normalizeRegistryCreationDraft({
      status: "ready",
      modelKey: model.key,
      draft: {
        name: "Broken",
        when: {
          kind: "date",
          start: "2026-09-22",
          endExclusive: "2026-09-20",
        },
      },
      missingFields: [],
      warnings: [],
    }, { models: [model], people: [] });
    expect(invalid.status).toBe("ready");
    if (invalid.status !== "ready") return;
    expect(invalid.draft.when).toBeNull();
    expect(invalid.warnings).toContainEqual({
      code: "INVALID_INFERRED_VALUE",
      field: "when",
      message: "An invalid inferred value was discarded.",
    });
  });

  it("publishes the direct TemporalRange filter surface", () => {
    const model = published();
    model.definition.query = { filterable: ["when"] };
    const target = canonicalQuerySemanticDescriptor(model).filter.targets.find(
      (candidate) => candidate.field === "when",
    );
    expect(target).toEqual({
      field: "when",
      kind: "field",
      valueType: "temporal_range",
      operators: [
        "overlaps",
        "contains",
        "before",
        "after",
        "kindIs",
        "isNull",
        "isNotNull",
      ],
      nullable: true,
    });
  });

  it("publishes physical DDL and generated contracts without leaking physical columns", async () => {
    const prepared: string[] = [];
    const statements = physicalPublicationStatements({
      DB: {
        prepare(sql: string) {
          prepared.push(sql);
          return { sql } as unknown as D1PreparedStatement;
        },
      } as unknown as D1Database,
    } as any, null, definition());

    expect(statements).toHaveLength(1);
    expect(prepared[0]).toContain('"__tr_when_kind" TEXT');
    expect(prepared[0]).toContain('"__tr_when_start" TEXT');
    expect(prepared[0]).toContain('"__tr_when_end" TEXT');

    const contract = await generateModelContract([published()]);
    const defs = contract.jsonSchema.$defs as Record<string, any>;
    const createWhen = defs.TemporalRecordCreate.properties.when;
    const resourceWhen = defs.TemporalRecordResource.properties.when;
    expect(createWhen.anyOf ?? createWhen.oneOf).toBeTruthy();
    expect(resourceWhen.anyOf ?? resourceWhen.oneOf).toBeTruthy();
    expect(JSON.stringify(contract.jsonSchema)).not.toContain("__tr_when_");
    expect(JSON.stringify(contract.openapi)).not.toContain("__tr_when_");
  });
});
