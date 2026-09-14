import { describe, expect, it } from "vitest";
import { EVENT_MODEL_DEFINITION } from "../src/builtin-models";
import { canonicalQuerySemanticDescriptor } from "../src/canonical-query-contract";
import { generateModelContract } from "../src/model-contract";
import { projectModelSemanticFacts } from "../src/model-semantic-projection";
import type { PublishedModel } from "../src/model-registry";

function eventModel(): PublishedModel {
  return {
    id: "mdl_event",
    key: EVENT_MODEL_DEFINITION.key,
    version: 1,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: "initial",
    definition: EVENT_MODEL_DEFINITION,
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

  it("publishes the exact operator matrix accepted by Canonical Query Runtime", () => {
    const descriptor = canonicalQuerySemanticDescriptor(eventModel());
    const target = (field: string) => descriptor.filter.targets.find((candidate) => candidate.field === field);

    expect(target("createdAt")).toMatchObject({
      kind: "envelope",
      operators: ["eq", "ne", "lt", "lte", "gt", "gte", "within"],
      nullable: false,
    });
    expect(target("when")).toMatchObject({
      kind: "calendar-range",
      operators: ["overlaps", "contains", "before", "after", "kindIs"],
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
});
