import { describe, expect, it } from "vitest";
import { generateModelContract } from "../src/model-contract";
import type { ModelDefinition } from "../src/model-definition";
import type { PublishedModel } from "../src/model-registry";

function published(key: string): PublishedModel {
  const definition: ModelDefinition = {
    definitionVersion: 1,
    key,
    display: { singular: key, plural: `${key}s` },
    fields: {
      name: { type: "string", required: true },
      status: { type: "enum", required: true, readOnly: true, values: ["open", "done"] },
    },
    defaults: { status: "open" },
    query: { searchable: ["name"], filterable: ["status"], sortable: ["name"] },
    access: ["read", "write"],
  };
  return {
    id: `mdl_${key}`,
    key,
    version: 1,
    state: "published",
    schemaHash: key.padEnd(64, "a").slice(0, 64),
    compatibility: "initial",
    definition,
    publishedAt: "2026-09-28T00:00:00.000Z",
  };
}

function hasDelegationParameter(path: any): boolean {
  return (path.parameters ?? []).some(
    (entry: any) => entry.$ref === "#/components/parameters/DelegationId",
  );
}

describe("generated Authority v2 and Batch Model Contract", () => {
  it("publishes one cross-model atomic Batch route and explicit Delegation selectors", async () => {
    const contract = await generateModelContract([published("alpha"), published("beta")]);
    const document = contract.openapi as any;

    const batch = document.paths["/api/v1/spaces/{spaceId}/models/batch"];
    expect(batch.post.operationId).toBe("batch_mutate_models");
    expect(batch.post["x-lifespace-batch-semantics"]).toEqual({
      atomic: true,
      maxOperations: 20,
      changeEvidence: "one-change-per-item-plus-one-change-set",
      authority: "verified-once-and-de-duplicated-by-authority-key",
      concurrency: "optional-client-version-or-current-set-wise-snapshot",
    });
    expect(batch.post.requestBody.content["application/json"].schema.$ref)
      .toBe("#/components/schemas/BatchMutationRequest");

    const request = document.components.schemas.BatchMutationRequest;
    expect(request.properties.operations.minItems).toBe(1);
    expect(request.properties.operations.maxItems).toBe(20);

    const operation = document.components.schemas.BatchOperation;
    expect(operation.oneOf.map((entry: any) => entry.$ref)).toEqual([
      "#/components/schemas/AlphaBatchCreateOperation",
      "#/components/schemas/BetaBatchCreateOperation",
      "#/components/schemas/AlphaBatchUpdateOperation",
      "#/components/schemas/BetaBatchUpdateOperation",
      "#/components/schemas/BatchDeleteOperation",
      "#/components/schemas/BatchSemanticRelationOperation",
    ]);
    expect(request.properties.atomicConsistency).toMatchObject({ type: "boolean", default: true });
    expect(request.properties.delegationId.pattern).toBe("^dlg_");
    expect(document.components.schemas.BatchSemanticEntityRef.oneOf[1].required).toContain("clientRef");
    const semanticPaths = document.paths["/api/v1/spaces/{spaceId}/semantic-relations"];
    expect(semanticPaths.get.responses["200"].content["application/json"].schema.$ref).toBe("#/components/schemas/SemanticRelationQueryResponse");
    expect(semanticPaths.post.responses["200"].content["application/json"].schema.$ref).toBe("#/components/schemas/SemanticRelationResponse");
    expect(semanticPaths.get.responses["404"].content["application/json"].schema.$ref).toBe("#/components/schemas/SemanticRelationError");

    expect(document.components.schemas.AlphaBatchCreateOperation.properties.delegationId.pattern)
      .toBe("^dlg_[A-Za-z0-9_-]+$");
    expect(document.components.schemas.AlphaBatchUpdateOperation.required)
      .toEqual(["operation", "modelKey", "recordId", "data"]);
    expect(document.components.schemas.BatchDeleteOperation.required)
      .toEqual(["operation", "modelKey", "recordId"]);
    expect(document.components.schemas.AlphaBatchUpdateOperation.properties.version.description)
      .toContain("Optional expected record version");
    expect(document.components.schemas.BatchDeleteOperation.properties.version.description)
      .toContain("Optional expected record version");
    expect(document.components.schemas.AlphaBatchUpdateOperation.properties.delegationId.pattern)
      .toBe("^dlg_[A-Za-z0-9_-]+$");
    expect(document.components.schemas.BatchDeleteOperation.properties.delegationId.pattern)
      .toBe("^dlg_[A-Za-z0-9_-]+$");

    const collection = document.paths["/api/v1/spaces/{spaceId}/models/alpha/records"];
    const query = document.paths["/api/v1/spaces/{spaceId}/models/alpha/records/query"];
    const record = document.paths["/api/v1/spaces/{spaceId}/models/alpha/records/{recordId}"];
    expect(hasDelegationParameter(collection)).toBe(true);
    expect(hasDelegationParameter(query)).toBe(true);
    expect(hasDelegationParameter(record)).toBe(true);
    expect(document.components.parameters.DelegationId).toMatchObject({
      name: "X-LifeSpace-Delegation-Id",
      in: "header",
      required: false,
    });
  });
});

