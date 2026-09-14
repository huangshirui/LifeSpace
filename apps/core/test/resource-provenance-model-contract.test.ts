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
      note: { type: "text", nullable: true },
    },
    access: ["read", "write"],
  };
}

function published(): PublishedModel {
  const model = definition();
  return {
    id: "mdl_provenance_contract",
    key: model.key,
    version: 1,
    state: "published",
    schemaHash: "c".repeat(64),
    compatibility: "initial",
    definition: model,
    publishedAt: "2026-09-14T00:00:00.000Z",
  };
}

describe("Information Provenance generated contract", () => {
  it("reserves provenance as Generic Runtime envelope metadata", () => {
    const input = definition() as ModelDefinition;
    input.fields.provenance = { type: "string" };
    const result = validateModelDefinition(input);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues).toContainEqual(expect.objectContaining({
      path: "fields.provenance",
      code: "RESERVED_FIELD",
    }));
  });

  it("projects provenance into create, update and resource schemas without allowing provenance-only PATCH", async () => {
    const contract = await generateModelContract([published()]);
    const schemas = (contract.openapi as any).components.schemas;
    const create = schemas.ProvenanceContractCreate;
    const update = schemas.ProvenanceContractUpdate;
    const resource = schemas.ProvenanceContractResource;

    expect(create.properties.provenance.required).toEqual(["source"]);
    expect(create.properties.provenance.properties.sourceRef.oneOf).toHaveLength(2);
    expect(create.properties.provenance.properties.derivedFrom.maxItems).toBe(50);

    expect(update.properties.provenance.required).toEqual(["source"]);
    expect(update.anyOf).toEqual([
      { required: ["name"] },
      { required: ["note"] },
    ]);
    expect(update.anyOf).not.toContainEqual({ required: ["provenance"] });

    expect(resource.properties.provenance.readOnly).toBe(true);
    expect(resource.required).not.toContain("provenance");

    const bundle = contract.jsonSchema as any;
    expect(bundle.$defs.ProvenanceContractCreate.properties.provenance.required).toEqual(["source"]);
    expect(bundle.$defs.ProvenanceContractResource.properties.provenance.readOnly).toBe(true);
  });
});
