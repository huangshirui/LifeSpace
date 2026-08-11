import type { FieldDefinition, ModelDefinition } from "./model-definition";
import type { PublishedModel } from "./model-registry";

export type JsonSchema = Record<string, unknown>;
export type OpenApiDocument = Record<string, unknown>;

export type ModelContractSnapshot = {
  id: string;
  hash: string;
  manifest: {
    kind: "lifespace-model-contract";
    models: Array<{
      key: string;
      route: string;
      version: number;
      schemaHash: string;
    }>;
  };
  openapi: OpenApiDocument;
  jsonSchema: JsonSchema;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalize(object[key])]));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function nullable(schema: JsonSchema, field: FieldDefinition): JsonSchema {
  if (!field.nullable) return schema;
  return { anyOf: [schema, { type: "null" }] };
}

function fieldSchema(field: FieldDefinition): JsonSchema {
  let schema: JsonSchema;
  switch (field.type) {
    case "string":
    case "text":
      schema = {
        type: "string",
        ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
        ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
      };
      break;
    case "integer":
    case "number":
      schema = {
        type: field.type,
        ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
        ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
      };
      break;
    case "boolean":
      schema = { type: "boolean" };
      break;
    case "date":
      schema = { type: "string", format: "date" };
      break;
    case "datetime":
      schema = { type: "string", format: "date-time" };
      break;
    case "timezone":
      schema = { type: "string", "x-lifespace-format": "iana-timezone" };
      break;
    case "enum":
      schema = { type: "string", enum: field.values ?? [] };
      break;
    case "person":
      schema = { type: "string", pattern: "^per_" };
      break;
    case "person_list":
      schema = { type: "array", uniqueItems: true, items: { type: "string", pattern: "^per_" } };
      break;
    case "record":
      schema = { type: "string", pattern: "^rec_", "x-lifespace-target-model": field.targetModel };
      break;
    case "record_list":
      schema = {
        type: "array",
        uniqueItems: true,
        items: { type: "string", pattern: "^rec_", "x-lifespace-target-model": field.targetModel },
      };
      break;
  }
  const result = nullable(schema, field);
  if (field.readOnly) result.readOnly = true;
  return result;
}

function writableFields(definition: ModelDefinition, mode: "create" | "update"): Array<[string, FieldDefinition]> {
  return Object.entries(definition.fields).filter(([, field]) => {
    if (field.readOnly) return false;
    if (mode === "update" && field.immutable) return false;
    return true;
  });
}

function createSchema(definition: ModelDefinition): JsonSchema {
  const fields = writableFields(definition, "create");
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(fields.map(([key, field]) => [key, fieldSchema(field)])),
    required: fields.filter(([, field]) => field.required).map(([key]) => key),
  };
}

function updateSchema(definition: ModelDefinition): JsonSchema {
  const fields = writableFields(definition, "update");
  return {
    type: "object",
    additionalProperties: false,
    minProperties: 2,
    properties: {
      version: { type: "integer", minimum: 1 },
      ...Object.fromEntries(fields.map(([key, field]) => [key, fieldSchema(field)])),
    },
    required: ["version"],
  };
}

function resourceSchema(definition: ModelDefinition): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", pattern: "^rec_" },
      spaceId: { type: "string", pattern: "^spc_" },
      modelKey: { type: "string", const: definition.key },
      modelVersion: { type: "integer", minimum: 1 },
      ...Object.fromEntries(Object.entries(definition.fields).map(([key, field]) => [key, fieldSchema(field)])),
      version: { type: "integer", minimum: 1 },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    required: [
      "id",
      "spaceId",
      "modelKey",
      "modelVersion",
      ...Object.entries(definition.fields).filter(([, field]) => field.required).map(([key]) => key),
      "version",
      "createdAt",
      "updatedAt",
    ],
  };
}

function versionRequestSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: { version: { type: "integer", minimum: 1 } },
    required: ["version"],
  };
}

function schemaName(model: PublishedModel, suffix: string): string {
  return `${model.key.replace(/(^|_)([a-z])/g, (_match, _prefix, letter: string) => letter.toUpperCase())}${suffix}`;
}

function responseSchemaRef(name: string): JsonSchema {
  return {
    type: "object",
    required: ["data"],
    properties: { data: { $ref: `#/components/schemas/${name}` } },
  };
}

function queryParameters(model: PublishedModel): unknown[] {
  const parameters: unknown[] = [];
  if (model.definition.query?.searchable?.length) {
    parameters.push({ name: "q", in: "query", schema: { type: "string", minLength: 1, maxLength: 100 } });
  }
  for (const fieldKey of model.definition.query?.filterable ?? []) {
    const field = model.definition.fields[fieldKey];
    if (!field) continue;
    let schema = fieldSchema({ ...field, nullable: false, readOnly: false });
    if (field.type === "enum") {
      schema = { type: "string", description: "One enum value, or a comma-separated set of enum values" };
    }
    parameters.push({ name: fieldKey, in: "query", schema });
    if (["date", "datetime", "integer", "number"].includes(field.type)) {
      parameters.push({ name: `${fieldKey}From`, in: "query", schema: fieldSchema({ ...field, nullable: false, readOnly: false }) });
      parameters.push({ name: `${fieldKey}To`, in: "query", schema: fieldSchema({ ...field, nullable: false, readOnly: false }) });
    }
  }
  const sortValues = ["createdAt:asc", "createdAt:desc", "updatedAt:asc", "updatedAt:desc"];
  for (const fieldKey of model.definition.query?.sortable ?? []) {
    sortValues.push(`${fieldKey}:asc`, `${fieldKey}:desc`);
  }
  parameters.push({ name: "sort", in: "query", schema: { type: "string", enum: sortValues, default: "createdAt:desc" } });
  parameters.push({ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 100 } });
  parameters.push({ name: "cursor", in: "query", schema: { type: "string" } });
  return parameters;
}

function modelOpenApi(model: PublishedModel, schemas: Record<string, JsonSchema>, paths: Record<string, unknown>) {
  const createName = schemaName(model, "Create");
  const updateName = schemaName(model, "Update");
  const resourceName = schemaName(model, "Resource");
  const versionName = schemaName(model, "VersionRequest");
  const listName = schemaName(model, "ListResponse");

  schemas[createName] = createSchema(model.definition);
  schemas[updateName] = updateSchema(model.definition);
  schemas[resourceName] = resourceSchema(model.definition);
  schemas[versionName] = versionRequestSchema();
  schemas[listName] = {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["items", "nextCursor"],
        properties: {
          items: { type: "array", items: { $ref: `#/components/schemas/${resourceName}` } },
          nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
  };

  const collectionPath = `/api/v1/spaces/{spaceId}/${model.route}`;
  const recordPath = `${collectionPath}/{recordId}`;
  paths[collectionPath] = {
    parameters: [{ $ref: "#/components/parameters/SpaceId" }],
    get: {
      operationId: `list_${model.key}`,
      tags: [model.definition.display.plural],
      parameters: queryParameters(model),
      responses: { "200": { description: "Model records", content: { "application/json": { schema: { $ref: `#/components/schemas/${listName}` } } } } },
    },
    post: {
      operationId: `create_${model.key}`,
      tags: [model.definition.display.plural],
      requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${createName}` } } } },
      responses: { "201": { description: "Created model record", content: { "application/json": { schema: responseSchemaRef(resourceName) } } } },
    },
  };
  paths[recordPath] = {
    parameters: [
      { $ref: "#/components/parameters/SpaceId" },
      { $ref: "#/components/parameters/RecordId" },
    ],
    get: {
      operationId: `get_${model.key}`,
      tags: [model.definition.display.plural],
      responses: { "200": { description: "Model record", content: { "application/json": { schema: responseSchemaRef(resourceName) } } } },
    },
    patch: {
      operationId: `update_${model.key}`,
      tags: [model.definition.display.plural],
      requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${updateName}` } } } },
      responses: { "200": { description: "Updated model record", content: { "application/json": { schema: responseSchemaRef(resourceName) } } } },
    },
    delete: {
      operationId: `delete_${model.key}`,
      tags: [model.definition.display.plural],
      requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${versionName}` } } } },
      responses: { "204": { description: "Deleted" } },
    },
  };

  for (const actionKey of Object.keys(model.definition.actions ?? {}).sort()) {
    paths[`${recordPath}/actions/${actionKey}`] = {
      parameters: [
        { $ref: "#/components/parameters/SpaceId" },
        { $ref: "#/components/parameters/RecordId" },
      ],
      post: {
        operationId: `${actionKey}_${model.key}`,
        tags: [model.definition.display.plural],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${versionName}` } } } },
        responses: { "200": { description: "Action result", content: { "application/json": { schema: responseSchemaRef(resourceName) } } } },
      },
    };
  }
}

function jsonSchemaBundle(models: PublishedModel[]): JsonSchema {
  const defs: Record<string, JsonSchema> = {};
  const metadata: Record<string, unknown> = {};
  for (const model of models) {
    const prefix = schemaName(model, "");
    defs[`${prefix}Create`] = createSchema(model.definition);
    defs[`${prefix}Update`] = updateSchema(model.definition);
    defs[`${prefix}Resource`] = resourceSchema(model.definition);
    defs[`${prefix}VersionRequest`] = versionRequestSchema();
    metadata[model.key] = {
      route: model.route,
      version: model.version,
      schemaHash: model.schemaHash,
      createSchema: `#/$defs/${prefix}Create`,
      updateSchema: `#/$defs/${prefix}Update`,
      resourceSchema: `#/$defs/${prefix}Resource`,
      actions: Object.keys(model.definition.actions ?? {}).sort(),
    };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "LifeSpace Model Registry Contract",
    "x-lifespace-models": metadata,
    $defs: defs,
  };
}

export async function generateModelContract(input: PublishedModel[]): Promise<ModelContractSnapshot> {
  const models = [...input].sort((left, right) => left.key.localeCompare(right.key));
  const manifest = {
    kind: "lifespace-model-contract" as const,
    models: models.map((model) => ({
      key: model.key,
      route: model.route,
      version: model.version,
      schemaHash: model.schemaHash,
    })),
  };
  const schemas: Record<string, JsonSchema> = {};
  const paths: Record<string, unknown> = {};
  for (const model of models) modelOpenApi(model, schemas, paths);

  const openapi: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: "LifeSpace Model Registry API Snapshot",
      version: "registry",
      description: "Concrete model routes generated from an immutable LifeSpace Model Registry snapshot. Kernel APIs are versioned separately.",
    },
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT or lsp_pat_" } },
      parameters: {
        SpaceId: { name: "spaceId", in: "path", required: true, schema: { type: "string", pattern: "^spc_" } },
        RecordId: { name: "recordId", in: "path", required: true, schema: { type: "string", pattern: "^rec_" } },
      },
      schemas,
    },
  };
  const jsonSchema = jsonSchemaBundle(models);
  const hash = await sha256(canonicalJson({ manifest, openapi, jsonSchema }));
  return { id: `mct_${hash}`, hash, manifest, openapi, jsonSchema };
}
