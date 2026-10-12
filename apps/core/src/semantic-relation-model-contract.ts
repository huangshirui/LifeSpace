import {
  generateModelContract as generateBaseModelContract,
  type JsonSchema,
  type ModelContractSnapshot,
  type OpenApiDocument,
} from "./model-contract";
import type { PublishedModel } from "./model-registry";
import { semanticRelationDiscovery } from "./semantic-relation-definition";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalize(object[key])]));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

  for (const model of models) {
    if (!model.definition.semanticRelations?.outgoing?.length) continue;
    const name = `${schemaPrefix(model.key)}BatchCreateOperation`;
    const create = schemas[name];
    if (!create) continue;
    const properties = create.properties as Record<string, unknown>;
    properties.semanticRelations = {
      type: "array",
      maxItems: 20,
      uniqueItems: true,
      items: { $ref: "#/components/schemas/BatchSemanticRelationCreate" },
      description: "Optional Semantic Relations whose source is the Record created by this Batch operation. Targets must already exist in the same Space and pass current read Authority/Policy.",
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
  }
}

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
      responses: { "200": { description: "Visible Semantic Relations" } },
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
      responses: { "200": { description: "Created or existing Semantic Relation" } },
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
      responses: {
        "200": { description: "Visible Semantic Relation" },
        "404": { description: "Missing or opaque-hidden relation" },
      },
    },
    delete: {
      operationId: "delete_semantic_relation",
      tags: ["Semantic Relations"],
      description: "Deletes only the edge. Endpoint Records remain. Requires current source write and target read Authority/Policy.",
      responses: { "204": { description: "Deleted" } },
    },
  };
}

function addSemanticRelationMetadata(models: readonly PublishedModel[], jsonSchema: JsonSchema): void {
  const metadata = jsonSchema["x-lifespace-models"] as Record<string, Record<string, unknown>>;
  for (const model of models) {
    const entry = metadata[model.key];
    if (!entry) continue;
    entry.semanticRelations = semanticRelationDiscovery(model.key, model.definition.semanticRelations);
  }
}

export async function generateModelContract(models: PublishedModel[]): Promise<ModelContractSnapshot> {
  const snapshot = await generateBaseModelContract(models);
  addSemanticRelationSchemas(models, snapshot.openapi);
  addSemanticRelationPaths(snapshot.openapi);
  addSemanticRelationMetadata(models, snapshot.jsonSchema);
  const hash = await sha256(JSON.stringify(canonicalize({
    manifest: snapshot.manifest,
    openapi: snapshot.openapi,
    jsonSchema: snapshot.jsonSchema,
  })));
  return { ...snapshot, id: `mct_${hash}`, hash };
}
