import { describe, expect, it } from "vitest";
import { EVENT_MODEL_DEFINITION } from "../src/builtin-models";
import { canonicalQuerySemanticDescriptor } from "../src/canonical-query-contract";
import { validateResourceData } from "../src/generic-resource";
import { generateModelContract } from "../src/model-contract";
import { compilePhysicalSchema } from "../src/physical-schema";
import type { PublishedModel } from "../src/model-registry";

const LEGACY_EVENT_TIME_FIELDS = [
  "isAllDay",
  "startAt",
  "endAt",
  "startTimezone",
  "endTimezone",
  "startDate",
  "endDateExclusive",
] as const;

function publishedEvent(): PublishedModel {
  return {
    id: "mdl_event_temporal_range",
    key: "event",
    version: 7,
    state: "published",
    schemaHash: "7b189b870a3da40ecc6d4ae7926c600f8beec5bc3af342539279d934da3243c6",
    compatibility: "breaking",
    definition: EVENT_MODEL_DEFINITION,
    publishedAt: "2026-09-17T00:00:00.000Z",
  };
}

describe("Event canonical TemporalRange migration", () => {
  it("uses one required when field as the only Event time truth", () => {
    expect(EVENT_MODEL_DEFINITION.fields.when).toMatchObject({
      type: "temporal_range",
      required: true,
    });
    for (const field of LEGACY_EVENT_TIME_FIELDS) {
      expect(EVENT_MODEL_DEFINITION.fields).not.toHaveProperty(field);
    }
    expect(EVENT_MODEL_DEFINITION.capabilities?.calendar).toEqual({
      rangeField: "when",
      attendeePersonField: "attendeePersonIds",
    });
    expect(EVENT_MODEL_DEFINITION.query).toEqual({
      searchable: ["summary", "description", "location"],
      filterable: ["status", "when", "attendeePersonIds", "location"],
      sortable: ["when", "summary"],
    });
  });

  it("accepts date and instant variants through ordinary Generic Runtime validation", () => {
    const allDay = validateResourceData(EVENT_MODEL_DEFINITION, {
      summary: "Holiday",
      when: { kind: "date", start: "2026-09-20", endExclusive: "2026-09-22" },
      status: "active",
    }, "create");
    expect(allDay.when).toEqual({
      kind: "date",
      start: "2026-09-20",
      endExclusive: "2026-09-22",
    });

    const timed = validateResourceData(EVENT_MODEL_DEFINITION, {
      summary: "Meeting",
      when: {
        kind: "instant",
        start: "2026-09-20T10:00:00+08:00",
        endExclusive: "2026-09-20T11:00:00+08:00",
      },
      status: "active",
    }, "create");
    expect(timed.when).toEqual({
      kind: "instant",
      start: "2026-09-20T02:00:00.000Z",
      endExclusive: "2026-09-20T03:00:00.000Z",
    });
  });

  it("compiles the Event table and indexes from the canonical temporal_range field", () => {
    const plan = compilePhysicalSchema(EVENT_MODEL_DEFINITION);
    expect(plan.columns.map((column) => column.fieldKey)).toEqual([
      "summary",
      "description",
      "__loc_location_name",
      "__loc_location_address",
      "__loc_location_latitude",
      "__loc_location_longitude",
      "__tr_when_kind",
      "__tr_when_start",
      "__tr_when_end",
      "status",
    ]);
    expect(plan.relationFields).toEqual(["attendeePersonIds"]);
    expect(plan.indexes.map((index) => index.name)).toEqual([
      "idx_mdl_event_location",
      "idx_mdl_event_status",
      "idx_mdl_event_summary",
      "idx_mdl_event_when",
    ]);
  });

  it("publishes one real when query target and no legacy Calendar transport contract", async () => {
    const model = publishedEvent();
    const descriptor = canonicalQuerySemanticDescriptor(model);
    expect(descriptor.filter.targets.filter((target) => target.field === "when")).toEqual([
      {
        field: "when",
        kind: "field",
        valueType: "temporal_range",
        operators: ["overlaps", "contains", "before", "after", "kindIs"],
        nullable: false,
      },
    ]);
    expect(descriptor.sort.temporalRange).not.toBeNull();

    const contract = await generateModelContract([model]);
    const defs = contract.jsonSchema.$defs as Record<string, any>;
    const create = defs.EventCreate as Record<string, any>;
    expect(create.properties.when).toBeDefined();
    for (const field of LEGACY_EVENT_TIME_FIELDS) expect(create.properties[field]).toBeUndefined();
    expect(create.allOf).toBeUndefined();

    const collection = (contract.openapi.paths as Record<string, any>)[
      "/api/v1/spaces/{spaceId}/models/event/records"
    ];
    const getParameterNames = collection.get.parameters
      .map((parameter: Record<string, unknown>) => parameter.name)
      .filter(Boolean);
    expect(getParameterNames).not.toContain("rangeStart");
    expect(getParameterNames).not.toContain("windowStartDate");
  });
});
