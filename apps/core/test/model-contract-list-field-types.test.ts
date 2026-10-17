import { describe, expect, it } from "vitest";
import { generateModelContract } from "../src/model-contract";
import type { ModelDefinition } from "../src/model-definition";
import type { PublishedModel } from "../src/model-registry";

function published(): PublishedModel {
  const definition: ModelDefinition = {
    definitionVersion: 1,
    key: "list_field_contract",
    display: { singular: "List Field Contract", plural: "List Field Contracts" },
    fields: {
      tags: { type: "enum_list", values: ["a", "b"] },
      files: { type: "file_ref_list" },
    },
    access: ["read", "write"],
  };
  return {
    id: "mdl_list_field_contract",
    key: definition.key,
    version: 1,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: "initial",
    definition,
    publishedAt: "2026-10-17T00:00:00.000Z",
  };
}

describe("canonical list field Model Contract", () => {
  it("publishes enum_list and file_ref_list consistently in OpenAPI and JSON Schema", async () => {
    const contract = await generateModelContract([published()]);
    const openapi = contract.openapi as any;
    const jsonSchema = contract.jsonSchema as any;

    const create = openapi.components.schemas.ListFieldContractCreate.properties;
    expect(create.tags).toEqual({
      type: "array",
      uniqueItems: true,
      items: { type: "string", enum: ["a", "b"] },
    });
    expect(create.files).toEqual({
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "url"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 512 },
          url: { type: "string", format: "uri", maxLength: 8192 },
          expiresAt: { type: "string", format: "date-time" },
        },
      },
      "x-lifespace-type": "file_ref_list",
      "x-lifespace-storage": "references-only",
    });

    expect(jsonSchema.$defs.ListFieldContractCreate.properties.tags).toEqual(create.tags);
    expect(jsonSchema.$defs.ListFieldContractCreate.properties.files).toEqual(create.files);
  });
});
