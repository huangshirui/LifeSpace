import { describe, expect, it } from "vitest";
import { generateModelContract } from "../src/model-contract";
import type { ModelDefinition } from "../src/model-definition";
import type { PublishedModel } from "../src/model-registry";

const definition: ModelDefinition = {
  definitionVersion: 1,
  key: "relation_probe",
  route: "relation-probes",
  display: { singular: "Relation Probe", plural: "Relation Probes" },
  fields: {
    ownerPersonId: { type: "person", title: "Owner" },
    memberPersonIds: { type: "person_list", title: "Members" },
    parentRecordId: { type: "record", title: "Parent", targetModel: "task" },
    childRecordIds: { type: "record_list", title: "Children", targetModel: "task" },
  },
  access: ["read", "write"],
};

const model: PublishedModel = {
  id: "mdl_relation_probe",
  key: definition.key,
  route: definition.route,
  version: 1,
  state: "published",
  schemaHash: "0".repeat(64),
  compatibility: "initial",
  definition,
  publishedAt: "2026-09-04T00:00:00.000Z",
};

describe("Model Contract relation metadata", () => {
  it("keeps target and cardinality explicit independently from field title", async () => {
    const contract = await generateModelContract([model]);
    const defs = contract.jsonSchema.$defs as Record<string, { properties: Record<string, Record<string, unknown>> }>;
    const properties = defs.RelationProbeCreate.properties;

    expect(properties.ownerPersonId.title).toBe("Owner");
    expect(properties.ownerPersonId["x-lifespace-relation"]).toEqual({ targetModel: "person", cardinality: "one" });
    expect(properties.memberPersonIds["x-lifespace-relation"]).toEqual({ targetModel: "person", cardinality: "many" });
    expect(properties.parentRecordId["x-lifespace-relation"]).toEqual({ targetModel: "task", cardinality: "one" });
    expect(properties.childRecordIds["x-lifespace-relation"]).toEqual({ targetModel: "task", cardinality: "many" });

    expect(properties.parentRecordId["x-lifespace-target-model"]).toBe("task");
    expect((properties.childRecordIds.items as Record<string, unknown>)["x-lifespace-target-model"]).toBe("task");

    const openapiSchemas = (contract.openapi.components as { schemas: Record<string, { properties: Record<string, Record<string, unknown>> }> }).schemas;
    expect(openapiSchemas.RelationProbeCreate.properties.childRecordIds["x-lifespace-relation"]).toEqual({
      targetModel: "task",
      cardinality: "many",
    });
  });
});
