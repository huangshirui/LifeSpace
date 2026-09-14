import { describe, expect, it } from "vitest";
import { generateModelContract } from "../src/model-contract";
import type { ModelDefinition } from "../src/model-definition";
import type { PublishedModel } from "../src/model-registry";

function published(): PublishedModel {
  const definition: ModelDefinition = {
    definitionVersion: 1,
    key: "query_contract",
    display: { singular: "Query Contract", plural: "Query Contracts" },
    fields: {
      name: { type: "string", required: true },
      status: { type: "enum", required: true, values: ["open", "done"] },
      dueDate: { type: "date", nullable: true },
      assigneePersonIds: { type: "person_list" },
    },
    query: {
      searchable: ["name"],
      filterable: ["status", "dueDate", "assigneePersonIds"],
      sortable: ["dueDate", "name"],
    },
    access: ["read"],
  };
  return {
    id: "mdl_query_contract",
    key: definition.key,
    version: 1,
    state: "published",
    schemaHash: "b".repeat(64),
    compatibility: "initial",
    definition,
    publishedAt: "2026-09-14T00:00:00.000Z",
  };
}

describe("generated Canonical Typed Query Model Contract", () => {
  it("publishes the structured query route and recursive contract without adapter query modes", async () => {
    const contract = await generateModelContract([published()]);
    const document = contract.openapi as any;
    const path = document.paths["/api/v1/spaces/{spaceId}/models/query_contract/records/query"];
    expect(path.post["x-lifespace-canonical-query"]).toBe(true);
    expect(path.post.requestBody.content["application/json"].schema.$ref)
      .toBe("#/components/schemas/QueryContractCanonicalQuery");

    const query = document.components.schemas.QueryContractCanonicalQuery;
    expect(query["x-lifespace-canonical-query"]).toBe(true);
    expect(query["x-lifespace-pipeline"]).toEqual(["search", "filter", "sort", "cursor-pagination"]);
    expect(query.properties.search["x-lifespace-searchable-fields"]).toEqual(["name"]);
    expect(query.properties.sort.default).toEqual([{ field: "createdAt", direction: "desc" }]);
    expect(query.properties.sort.items.properties.field.enum).toEqual([
      "createdAt",
      "dueDate",
      "name",
      "updatedAt",
    ]);

    const filter = document.components.schemas.QueryContractCanonicalFilter;
    const nullPredicate = filter.oneOf[2];
    const valuePredicate = filter.oneOf[3];
    expect(valuePredicate.properties.field.enum).toEqual([
      "assigneePersonIds",
      "createdAt",
      "dueDate",
      "status",
      "updatedAt",
    ]);
    expect(nullPredicate.required).toEqual(["field", "op"]);
    expect(nullPredicate.properties.op.enum).toEqual(["isNull", "isNotNull"]);
    expect(nullPredicate.properties.value).toBeUndefined();
    expect(valuePredicate.required).toEqual(["field", "op", "value"]);
    expect(valuePredicate.properties.op.enum).toContain("contains");
    expect(valuePredicate.properties.op.enum).toContain("within");
    expect(valuePredicate.properties.op.enum).not.toContain("isNull");
    expect(filter["x-lifespace-max-depth"]).toBe(8);
    expect(filter["x-lifespace-relation-membership-primitive"]).toBe("contains");

    const bundle = contract.jsonSchema as any;
    expect(bundle.$defs.QueryContractCanonicalQuery["x-lifespace-canonical-query"]).toBe(true);
    expect(bundle["x-lifespace-models"].query_contract.canonicalQuerySchema)
      .toBe("#/$defs/QueryContractCanonicalQuery");
    expect(bundle["x-lifespace-models"].query_contract.canonicalFilterSchema)
      .toBe("#/$defs/QueryContractCanonicalFilter");
  });
});
