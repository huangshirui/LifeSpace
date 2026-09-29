import { describe, expect, it } from "vitest";
import { generateModelContract } from "../src/model-contract";
import { validateModelDefinition, type ModelDefinition } from "../src/model-definition";
import type { PublishedModel } from "../src/model-registry";

function definition(): ModelDefinition {
  return {
    definitionVersion: 1,
    key: "provenance_contract",
    display: { singular: "Provenance Contract", plural: "Provenance Contracts" },
    fields: {
      name: { type: "string", required: true },
    },
    access: ["read", "write"],
  };
}

function published(definitionOverride = definition()): PublishedModel {
  return {
    id: "mdl_provenance_contract",
    key: definitionOverride.key,
    version: 1,
    state: "published",
    schemaHash: "c".repeat(64),
    compatibility: "initial",
    definition: definitionOverride,
    publishedAt: "2026-09-28T00:00:00.000Z",
  };
}

describe("retired Resource Provenance envelope", () => {
  it("does not synthesize provenance into ordinary Model Contracts", async () => {
    const contract = await generateModelContract([published()]);
    const schemas = (contract.openapi as any).components.schemas;
    expect(schemas.ProvenanceContractCreate.properties.provenance).toBeUndefined();
    expect(schemas.ProvenanceContractUpdate.properties.provenance).toBeUndefined();
    expect(schemas.ProvenanceContractResource.properties.provenance).toBeUndefined();
  });

  it("allows provenance to be an ordinary model field instead of reserving a platform envelope", async () => {
    const candidate = definition();
    candidate.fields.provenance = { type: "record", targetModel: "source_document" };

    const validated = validateModelDefinition(candidate);
    expect(validated.valid).toBe(true);
    if (!validated.valid) return;

    const contract = await generateModelContract([published(validated.definition)]);
    const schemas = (contract.openapi as any).components.schemas;
    expect(schemas.ProvenanceContractCreate.properties.provenance["x-lifespace-relation"]).toEqual({
      targetModel: "source_document",
      cardinality: "one",
    });
  });
});
