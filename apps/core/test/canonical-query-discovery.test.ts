import { describe, expect, it } from "vitest";
import { EVENT_MODEL_DEFINITION } from "../src/builtin-models";
import { canonicalQuerySemanticDescriptor } from "../src/canonical-query-contract";
import { generateModelContract } from "../src/model-contract";
import type { ModelDefinition } from "../src/model-definition";
import { projectModelSemanticFacts } from "../src/model-semantic-projection";
import type { PublishedModel } from "../src/model-registry";

function eventModel(): PublishedModel {
  return {
    id: "mdl_event",
    key: EVENT_MODEL_DEFINITION.key,
    version: 6,
    state: "published",
    schemaHash: "be9bdea442a30108a22a2da77a96ab23aba5122ec3c2b1de20a6312cebb0cc8a",
    compatibility: "breaking",
    definition: EVENT_MODEL_DEFINITION,
    publishedAt: "2026-09-17T00:00:00.000Z",
  };
}

function canonicalCalendarModel(): PublishedModel {
  const definition: ModelDefinition = {
    definitionVersion: 1,
    key: "calendar_probe",
    display: { singular: "Calendar Probe", plural: "Calendar Probes" },
    fields: {
      name: { type: "string", required: true },
      when: { type: "temporal_range", required: true },
      attendeePersonIds: { type: "person_list" },
    },
    query: {
      searchable: ["name"],
      filterable: ["when", "attendeePersonIds"],
      sortable: ["when", "name"],
    },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
    capabilities: {
      calendar: {
        rangeField: "when",
        attendeePersonField: "attendeePersonIds",
      },
    },
  };
  return {
    id: "mdl_calendar_probe",
    key: definition.key,
    version: 1,
    state: "published",
    schemaHash: "b".repeat(64),
    compatibility: "initial",
    definition,
    publishedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Canonical Query discovery convergence", () => {
  it("projects Runtime Discovery and immutable Model Contract metadata from one descriptor", async () => {
    const model = eventModel();
    const descriptor = canonicalQuerySemanticDescriptor(model);
    const runtime = projectModelSemanticFacts(model);
    const contract = await generateModelContract([model]);
    const schema = (contract.openapi.components as {
      schemas: Record<string, Record<string, unknown>>;
    }).schemas.EventCanonicalQuery;

    expect(runtime.query.canonical).toEqual(descriptor);
    expect(runtime.query.legacyDeprecated).toBe(true);
    expect(schema["x-lifespace-semantic-descriptor"]).toEqual(descriptor);
    expect((schema.properties as Record<string, unknown>).search).toBeDefined();
  });

  it("publishes the exact operator matrix accepted by canonical Event Runtime", () => {
    const descriptor = canonicalQuerySemanticDescriptor(eventModel());
    const target = (field: string) => descriptor.filter.targets.find((candidate) => candidate.field === field);

    expect(target("createdAt")).toMatchObject({
      kind: "envelope",
      operators: ["eq", "ne", "lt", "lte", "gt", "gte", "within"],
      nullable: false,
    });
    expect(target("when")).toMatchObject({
      kind: "field",
      valueType: "temporal_range",
      operators: ["overlaps", "contains", "before", "after", "kindIs"],
      nullable: false,
    });

    const attendee = descriptor.filter.targets.find((candidate) => candidate.acceptsCurrentActorPersonAlias === "me");
    expect(attendee).toMatchObject({
      kind: "field",
      operators: ["contains"],
      acceptsCurrentActorPersonAlias: "me",
    });
    expect(descriptor.invocation).toEqual({
      method: "POST",
      pathTemplate: "/api/v1/spaces/{spaceId}/models/{modelKey}/records/query",
    });
  });

  it("does not duplicate the real temporal_range target with the legacy virtual when alias", () => {
    const descriptor = canonicalQuerySemanticDescriptor(canonicalCalendarModel());
    const whenTargets = descriptor.filter.targets.filter((candidate) => candidate.field === "when");

    expect(whenTargets).toEqual([
      {
        field: "when",
        kind: "field",
        valueType: "temporal_range",
        operators: ["overlaps", "contains", "before", "after", "kindIs"],
        nullable: false,
      },
    ]);
    expect(descriptor.sort.fields).toContain("when");
    expect(descriptor.sort.temporalRange).not.toBeNull();
  });
});
