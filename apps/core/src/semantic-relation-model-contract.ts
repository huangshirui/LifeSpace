import type {
  JsonSchema,
  OpenApiDocument,
} from "./model-contract";
import type { PublishedModel } from "./model-registry";
import { semanticRelationDiscovery, SEMANTIC_RELATION_RUNTIME } from "./semantic-relation-definition";

function schemaPrefix(modelKey: string): string {
  return modelKey.replace(/(^|_)([a-z])/g, (_match, _prefix, letter: string) => letter.toUpperCase());
}

function entityRefSchema(modelKeys: readonly string[]): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "modelKey", "recordId"],
    properties: {
      kind: { const: "record" },
      modelKey: { type: "string", enum: [...modelKeys] },
      recordId: { type: "string", pattern: "^rec_[A-Za-z0-9_-]+$" },
    },
  };
}

function registeredPredicates(models: readonly PublishedModel[]): string[] {
  return [...new Set(models.flatMap((model) => model.definition.semanticRelations?.outgoing ?? []))].sort();
}

function addSemanticRelationSchemas(
  models: readonly PublishedModel[],
  openapi: OpenApiDocument,
): void {
  const components = openapi.components as { schemas: Record<string, JsonSchema> };
  const schemas = components.schemas;
  const modelKeys = models.map((model) => model.key);
  const predicates = registeredPredicates(models);

  schemas.SemanticEntityRef = entityRefSchema(modelKeys);
  schemas.SemanticRelation = {
    type: "object",
    additionalProperties: false,
    required: ["id", "spaceId", "source", "predicate", "target", "createdAt"],
    properties: {
      id: { type: "string", pattern: "^rel_[A-Za-z0-9_-]+$" },
      spaceId: { type: "string", pattern: "^spc_[A-Za-z0-9_-]+$" },
      source: { $ref: "#/components/schemas/SemanticEntityRef" },
      predicate: { type: "string", enum: predicates },
      target: { $ref: "#/components/schemas/SemanticEntityRef" },
      createdAt: { type: "string", format: "date-time" },
      sourceRecord: { type: "object", additionalProperties: true },
      targetRecord: { type: "object", additionalProperties: true },
      sourceLabel: { type: "string" },
      targetLabel: { type: "string" },
    },
  };
  schemas.SemanticRelationCreate = {
    type: "object",
    additionalProperties: false,
    required: ["source", "predicate", "target"],
    properties: {
      source: { $ref: "#/components/schemas/SemanticEntityRef" },
      predicate: { type: "string", enum: predicates },
      target: { $ref: "#/components/schemas/SemanticEntityRef" },
    },
  };
  schemas.BatchSemanticRelationCreate = {
    type: "object",
    additionalProperties: false,
    required: ["predicate", "target"],
    properties: {
      predicate: { type: "string", enum: predicates },
      target: { $ref: "#/components/schemas/SemanticEntityRef" },
    },
  };
  schemas.BatchSemanticEntityRef = {
    oneOf: [
      { $ref: "#/components/schemas/SemanticEntityRef" },
      { type: "object", additionalProperties: false, required: ["kind", "modelKey", "clientRef"],
        properties: { kind: { const: "record" }, modelKey: { type: "string", enum: modelKeys },
          clientRef: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,62}$" } } },
    ],
  };
  (schemas.BatchSemanticRelationCreate.properties as Record<string, unknown>).target = { $ref: "#/components/schemas/BatchSemanticEntityRef" };
  schemas.BatchSemanticRelationOperation = {
    oneOf: [
      { type: "object", additionalProperties: false, required: ["operation", "source", "predicate", "target"],
        properties: { operation: { const: "relation_create" },
          source: { $ref: "#/components/schemas/BatchSemanticEntityRef" },
          target: { $ref: "#/components/schemas/BatchSemanticEntityRef" },
          predicate: { type: "string", enum: predicates }, delegationId: { type: "string", pattern: "^dlg_" } } },
      { type: "object", additionalProperties: false, required: ["operation", "relationId"],
        properties: { operation: { const: "relation_delete" }, relationId: { type: "string", pattern: "^rel_" },
          delegationId: { type: "string", pattern: "^dlg_" } } },
    ],
  };
  (schemas.BatchOperation.oneOf as unknown[]).push({ $ref: "#/components/schemas/BatchSemanticRelationOperation" });
  const requestProperties = schemas.BatchMutationRequest.properties as Record<string, unknown>;
  requestProperties.atomicConsistency = { type: "boolean", default: true,
    description: "Compatible Batch default is atomic. False enables independent per-item results. Native D1 only; external/cross-store atomic requests are rejected." };
  requestProperties.delegationId = { type: "string", pattern: "^dlg_", description: "Default Delegation selector; an item may supply its own explicit selector." };

  for (const model of models) {
    const name = `${schemaPrefix(model.key)}BatchCreateOperation`;
    const create = schemas[name];
    if (!create) continue;
    const properties = create.properties as Record<string, unknown>;
    properties.clientRef = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,62}$",
      description: "Unique request-local create reference. The server assigns the persistent Record ID." };
    if (!model.definition.semanticRelations?.outgoing?.length) continue;
    properties.semanticRelations = {
      type: "array",
      maxItems: 20,
      uniqueItems: true,
      items: { $ref: "#/components/schemas/BatchSemanticRelationCreate" },
      description: "Optional edges owned by this create action. Targets are existing same-Space records or request-local creates, and must pass current read Authority/Policy.",
    };
  }

  const resultItem = schemas.BatchMutationResultItem;
  if (resultItem) {
    const properties = resultItem.properties as Record<string, unknown>;
    properties.semanticRelationIds = {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", pattern: "^rel_[A-Za-z0-9_-]+$" },
    };
    properties.status = { const: "succeeded" };
  }
  const ordinaryResult = structuredClone(schemas.BatchMutationResultItem);
  const bulkError = (schemas.BulkMutationResultItem.oneOf as JsonSchema[])[1]!;
  const failed = structuredClone(bulkError);
  (failed.properties as Record<string, unknown>).operation = { type: "string" };
  schemas.BatchMutationResultItem = { oneOf: [ordinaryResult,
    { type: "object", additionalProperties: false, required: ["index", "operation", "modelKey", "status", "relationId"],
      properties: { index: { type: "integer", minimum: 0, maximum: 19 },
        operation: { enum: ["relation_create", "relation_delete"] }, modelKey: { type: "null" },
        status: { const: "succeeded" }, relationId: { type: "string", pattern: "^rel_" } } }, failed] };
  const data = (schemas.BatchMutationResponse.properties as Record<string, JsonSchema>).data!;
  const dataProperties = data.properties as Record<string, unknown>;
  dataProperties.atomicConsistency = { type: "boolean" };
  const bulkData = structuredClone(data);
  bulkData.required = ["bulkId", "items", "atomicConsistency"];
  const bulkProperties = bulkData.properties as Record<string, unknown>;
  delete bulkProperties.changeSetId;
  bulkProperties.bulkId = { type: "string", pattern: "^blk_" };
  bulkProperties.atomicConsistency = { const: false };
  (schemas.BatchMutationResponse.properties as Record<string, unknown>).data = { oneOf: [data, bulkData] };
  schemas.SemanticRelationResponse = { type: "object", additionalProperties: false, required: ["data"],
    properties: { data: { $ref: "#/components/schemas/SemanticRelation" } } };
  schemas.SemanticRelationQueryResponse = { type: "object", additionalProperties: false, required: ["data"],
    properties: { data: { type: "object", additionalProperties: false, required: ["items", "nextCursor"],
      properties: { items: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/SemanticRelation" } },
        nextCursor: { type: ["string", "null"] } } } } };
  schemas.SemanticRelationError = { type: "object", required: ["error"], properties: {
    error: { type: "object", required: ["code", "message", "requestId"], properties: {
      code: { type: "string" }, message: { type: "string" }, requestId: { type: "string" } } } } };
}

function response(schema: string, description: string) {
  return { description, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } };
}
const errors = Object.fromEntries([400, 401, 403, 404, 409, 500, 503].map((status) => [String(status), response("SemanticRelationError", "Invalid, denied, unavailable or conflicted operation")]));

function addSemanticRelationPaths(openapi: OpenApiDocument): void {
  const paths = openapi.paths as Record<string, unknown>;
  paths["/api/v1/spaces/{spaceId}/semantic-relations"] = {
    parameters: [{ $ref: "#/components/parameters/SpaceId" }],
    get: {
      operationId: "query_semantic_relations",
      tags: ["Semantic Relations"],
      description: "Queries governed business-semantic edges. Both endpoints must be currently readable. Visibility filtering is bounded and occurs before result truncation.",
      parameters: [
        { name: "sourceModelKey", in: "query", schema: { type: "string" } },
        { name: "sourceRecordId", in: "query", schema: { type: "string", pattern: "^rec_" } },
        { name: "targetModelKey", in: "query", schema: { type: "string" } },
        { name: "targetRecordId", in: "query", schema: { type: "string", pattern: "^rec_" } },
        { name: "predicate", in: "query", schema: { type: "string" } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
        { name: "cursor", in: "query", schema: { type: "string" } },
        { name: "hydrate", in: "query", schema: { type: "string", enum: ["source", "target", "both"] } },
        { $ref: "#/components/parameters/DelegationId" },
      ],
      responses: { ...errors, "200": response("SemanticRelationQueryResponse", "Visible Semantic Relations") },
    },
    post: {
      operationId: "create_semantic_relation",
      tags: ["Semantic Relations"],
      description: "Idempotently creates one governed edge. Requires current source write and target read Authority/Policy; duplicate creation does not duplicate Change evidence.",
      parameters: [{ $ref: "#/components/parameters/DelegationId" }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/SemanticRelationCreate" } } },
      },
      responses: { ...errors, "200": response("SemanticRelationResponse", "Created or existing Semantic Relation") },
    },
  };
  paths["/api/v1/spaces/{spaceId}/semantic-relations/{relationId}"] = {
    parameters: [
      { $ref: "#/components/parameters/SpaceId" },
      { name: "relationId", in: "path", required: true, schema: { type: "string", pattern: "^rel_" } },
      { $ref: "#/components/parameters/DelegationId" },
    ],
    get: {
      operationId: "get_semantic_relation",
      tags: ["Semantic Relations"],
      parameters: [{ name: "hydrate", in: "query", schema: { type: "string", enum: ["source", "target", "both"] } }],
      responses: {
        ...errors,
        "200": response("SemanticRelationResponse", "Visible Semantic Relation"),
      },
    },
    delete: {
      operationId: "delete_semantic_relation",
      tags: ["Semantic Relations"],
      description: "Deletes only the edge. Endpoint Records remain. Requires current source write and target read Authority/Policy.",
      responses: { ...errors, "204": { description: "Deleted" } },
    },
  };
}

function addSemanticRelationMetadata(models: readonly PublishedModel[], jsonSchema: JsonSchema): void {
  const metadata = jsonSchema["x-lifespace-models"] as Record<string, Record<string, unknown>>;
  for (const model of models) {
    const entry = metadata[model.key];
    if (!entry) continue;
    entry.semanticRelations = semanticRelationDiscovery(model.key, model.definition.semanticRelations);
    entry.semanticRelationRuntime = SEMANTIC_RELATION_RUNTIME;
  }
}

export function applySemanticRelationContract(models: PublishedModel[], openapi: OpenApiDocument, jsonSchema: JsonSchema): void {
  addSemanticRelationSchemas(models, openapi);
  addSemanticRelationPaths(openapi);
  addSemanticRelationMetadata(models, jsonSchema);
}
