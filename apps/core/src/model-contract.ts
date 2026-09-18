import { calendarViewingWindowSemanticQuery } from "./calendar-query-semantics";
import { canonicalQueryContractSchemas } from "./canonical-query-contract";
import type { FieldDefinition, ModelDefinition } from "./model-definition";
import type { PublishedModel } from "./model-registry";
import { referenceLabelSemantic } from "./reference-label";
import { genericComparisonFieldSemantics } from "./query-semantics";

export type JsonSchema = Record<string, unknown>;
export type OpenApiDocument = Record<string, unknown>;

export type ModelContractSnapshot = {
  id: string;
  hash: string;
  manifest: {
    kind: "lifespace-model-contract";
    models: Array<{ key: string; version: number; schemaHash: string }>;
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

function relationMetadata(field: FieldDefinition): JsonSchema | null {
  switch (field.type) {
    case "person":
      return { targetModel: "person", cardinality: "one" };
    case "person_list":
      return { targetModel: "person", cardinality: "many" };
    case "record":
      return { targetModel: field.targetModel, cardinality: "one" };
    case "record_list":
      return { targetModel: field.targetModel, cardinality: "many" };
    default:
      return null;
  }
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
    case "instant":
    case "datetime":
      schema = { type: "string", format: "date-time" };
      break;
    case "range<date>":
      schema = {
        type: "object",
        additionalProperties: false,
        required: ["start", "endExclusive"],
        properties: {
          start: { type: "string", format: "date" },
          endExclusive: { type: "string", format: "date" },
        },
      };
      break;
    case "range<instant>":
      schema = {
        type: "object",
        additionalProperties: false,
        required: ["start", "endExclusive"],
        properties: {
          start: { type: "string", format: "date-time" },
          endExclusive: { type: "string", format: "date-time" },
        },
      };
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
    case "temporal_range":
      schema = {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { const: "date" },
              start: { type: "string", format: "date" },
              endExclusive: { type: "string", format: "date" },
            },
            required: ["kind", "start", "endExclusive"],
          },
          {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { const: "instant" },
              start: { type: "string", format: "date-time" },
              endExclusive: { type: "string", format: "date-time" },
            },
            required: ["kind", "start", "endExclusive"],
          },
        ],
        "x-lifespace-type": "temporal_range",
        "x-lifespace-bounds": "[)",
      };
      break;
  }
  const result = nullable(schema, field);
  const relation = relationMetadata(field);
  if (relation) result["x-lifespace-relation"] = relation;
  if (field.title) result.title = field.title;
  if (field.description) result.description = field.description;
  if (field.readOnly) result.readOnly = true;
  return result;
}

function provenanceReferenceSchema(): JsonSchema {
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { const: "record" },
          recordId: { type: "string", pattern: "^rec_[A-Za-z0-9]+$", maxLength: 100 },
          version: { type: "integer", minimum: 1 },
        },
        required: ["type", "recordId"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { const: "external" },
          system: { type: "string", minLength: 1, maxLength: 100 },
          ref: { type: "string", minLength: 1, maxLength: 2000 },
        },
        required: ["type", "system", "ref"],
      },
    ],
  };
}

function provenanceSchema(readOnly = false): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    ...(readOnly ? { readOnly: true } : {}),
    properties: {
      source: { type: "string", minLength: 1, maxLength: 100 },
      sourceRef: provenanceReferenceSchema(),
      derivedFrom: {
        type: "array",
        maxItems: 50,
        items: provenanceReferenceSchema(),
      },
    },
    required: ["source"],
  };
}

function hasDefault(definition: ModelDefinition, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(definition.defaults ?? {}, key);
}

function schemaWithDefault(definition: ModelDefinition, key: string, field: FieldDefinition): JsonSchema {
  const schema = fieldSchema(field);
  return hasDefault(definition, key) ? { ...schema, default: structuredClone(definition.defaults![key]) } : schema;
}

function writableFields(definition: ModelDefinition, mode: "create" | "update"): Array<[string, FieldDefinition]> {
  return Object.entries(definition.fields).filter(([, field]) => {
    if (field.readOnly) return false;
    if (mode === "update" && field.immutable) return false;
    return true;
  });
}

function calendarCreateConstraint(model: PublishedModel): JsonSchema | null {
  const c = model.definition.capabilities?.calendar;
  if (!c || "rangeField" in c) return null;
  return {
    oneOf: [
      {
        title: "All-day Calendar resource",
        required: [c.allDayField, c.allDayStartField, c.allDayEndExclusiveField],
        properties: {
          [c.allDayField]: { const: true },
          [c.allDayStartField]: { type: "string", format: "date" },
          [c.allDayEndExclusiveField]: { type: "string", format: "date" },
          [c.timedStartField]: { type: "null" },
          [c.timedEndField]: { type: "null" },
          [c.startTimezoneField]: { type: "null" },
          [c.endTimezoneField]: { type: "null" },
        },
      },
      {
        title: "Timed Calendar resource",
        required: [c.allDayField, c.timedStartField, c.timedEndField, c.startTimezoneField, c.endTimezoneField],
        properties: {
          [c.allDayField]: { const: false },
          [c.timedStartField]: { type: "string", format: "date-time" },
          [c.timedEndField]: { type: "string", format: "date-time" },
          [c.startTimezoneField]: { type: "string", "x-lifespace-format": "iana-timezone" },
          [c.endTimezoneField]: { type: "string", "x-lifespace-format": "iana-timezone" },
          [c.allDayStartField]: { type: "null" },
          [c.allDayEndExclusiveField]: { type: "null" },
        },
      },
    ],
    "x-lifespace-range-semantics": "half-open; end must be later than start",
  };
}

function createSchema(model: PublishedModel): JsonSchema {
  const definition = model.definition;
  const fields = writableFields(definition, "create");
  const base: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      ...Object.fromEntries(fields.map(([key, field]) => [key, schemaWithDefault(definition, key, field)])),
      provenance: provenanceSchema(),
    },
    required: fields
      .filter(([key, field]) => field.required && !hasDefault(definition, key))
      .map(([key]) => key),
  };
  const calendar = calendarCreateConstraint(model);
  return calendar ? { ...base, allOf: [calendar] } : base;
}

function concurrencyVersionSchema(): JsonSchema {
  return {
    type: "integer",
    minimum: 1,
    description: "Current record version used for optimistic concurrency. This is technical mutation metadata, not semantic Action input.",
    "x-lifespace-input-role": "concurrency",
  };
}

function actionConcurrencyMetadata(): JsonSchema {
  return {
    strategy: "record-version",
    required: true,
    transport: { in: "body", name: "version" },
  };
}

function updateSchema(model: PublishedModel): JsonSchema {
  const fields = writableFields(model.definition, "update");
  const calendar = model.definition.capabilities?.calendar;
  return {
    type: "object",
    additionalProperties: false,
    minProperties: 2,
    properties: {
      version: concurrencyVersionSchema(),
      ...Object.fromEntries(fields.map(([key, field]) => [key, fieldSchema(field)])),
      provenance: provenanceSchema(),
    },
    required: ["version"],
    ...(fields.length
      ? { anyOf: fields.map(([key]) => ({ required: [key] })) }
      : { not: {} }),
    ...(calendar && !("rangeField" in calendar)
      ? { "x-lifespace-calendar-update": "A mode switch must provide a complete valid timed or all-day Calendar shape." }
      : {}),
  };
}

function temporalComputedSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      today: { type: "string", format: "date" },
      state: {
        type: "string",
        enum: ["normal", "threshold_reached", "future", "upcoming", "today", "past", "due", "overdue"],
      },
      attentionLevel: { type: "string", enum: ["none", "info", "warning", "critical"] },
      isAttentionRequired: { type: "boolean" },
      elapsedDays: { type: "integer" },
      remainingDays: { anyOf: [{ type: "integer" }, { type: "null" }] },
      progressRatio: { type: "number" },
      nextDueDate: { type: "string", format: "date" },
    },
    required: ["today", "state", "attentionLevel", "isAttentionRequired"],
  };
}

function resourceAuditActorSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    readOnly: true,
    properties: {
      type: { type: "string", enum: ["user", "service", "device"] },
      id: { type: "string", minLength: 1 },
      displayName: { type: "string", minLength: 1 },
    },
    required: ["type", "id", "displayName"],
  };
}

function resourceSchema(model: PublishedModel): JsonSchema {
  const definition = model.definition;
  const properties: Record<string, unknown> = {
    id: { type: "string", pattern: "^rec_" },
    spaceId: { type: "string", pattern: "^spc_" },
    modelKey: { type: "string", const: definition.key },
    modelVersion: { type: "integer", minimum: 1 },
    ...Object.fromEntries(Object.entries(definition.fields).map(([key, field]) => [key, fieldSchema(field)])),
    provenance: provenanceSchema(true),
    createdBy: resourceAuditActorSchema(),
    updatedBy: resourceAuditActorSchema(),
    version: { type: "integer", minimum: 1 },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  };
  const required = [
    "id",
    "spaceId",
    "modelKey",
    "modelVersion",
    ...Object.entries(definition.fields).filter(([, field]) => field.required).map(([key]) => key),
    "createdBy",
    "updatedBy",
    "version",
    "createdAt",
    "updatedAt",
  ];
  if (definition.capabilities?.temporal) {
    properties.computed = {
      type: "object",
      additionalProperties: false,
      properties: { temporal: temporalComputedSchema() },
      required: ["temporal"],
      readOnly: true,
    };
    required.push("computed");
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
    "x-lifespace-reference-label": referenceLabelSemantic(definition),
  };
}

function versionRequestSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: { version: concurrencyVersionSchema() },
    required: ["version"],
  };
}

function temporalOccurrenceRequestSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      version: concurrencyVersionSchema(),
      occurredOn: { type: "string", format: "date" },
      note: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }] },
    },
    required: ["version", "occurredOn"],
  };
}

function temporalOccurrenceSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", pattern: "^tmo_" },
      recordId: { type: "string", pattern: "^rec_" },
      occurredOn: { type: "string", format: "date" },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
      source: { type: "string", enum: ["initial", "manual"] },
      intervalDays: { anyOf: [{ type: "integer" }, { type: "null" }] },
      recordedBy: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["user", "service", "device"] },
          id: { type: "string" },
          displayName: { type: "string" },
        },
        required: ["type", "id", "displayName"],
      },
      createdAt: { type: "string", format: "date-time" },
    },
    required: ["id", "recordId", "occurredOn", "note", "source", "intervalDays", "recordedBy", "createdAt"],
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

function parameterMap(model: PublishedModel): Map<string, Record<string, unknown>> {
  const parameters = new Map<string, Record<string, unknown>>();
  const put = (parameter: Record<string, unknown> & { name: string }) => parameters.set(parameter.name, parameter);

  if (model.definition.query?.searchable?.length) {
    put({ name: "q", in: "query", schema: { type: "string", minLength: 1, maxLength: 100 } });
  }

  const temporal = model.definition.capabilities?.temporal;
  const calendar = model.definition.capabilities?.calendar;
  const calendarQuery = calendar && !("rangeField" in calendar) ? calendarViewingWindowSemanticQuery() : null;

  for (const fieldKey of model.definition.query?.filterable ?? []) {
    const field = model.definition.fields[fieldKey];
    if (!field || field.type === "temporal_range" || field.type === "range<date>" || field.type === "range<instant>") continue;
    let schema = fieldSchema({ ...field, nullable: false, readOnly: false });
    if (field.type === "enum") {
      schema = { type: "string", ...(field.title ? { title: field.title } : {}), description: "One enum value, or a comma-separated set of enum values" };
    }
    if (
      (temporal?.subjectPersonField === fieldKey || calendar?.attendeePersonField === fieldKey)
      && (field.type === "person" || field.type === "person_list")
    ) {
      schema = {
        anyOf: [{ type: "string", pattern: "^per_" }, { const: "me" }],
        ...(field.title ? { title: field.title } : {}),
        ...(field.description ? { description: field.description } : {}),
        "x-lifespace-relation": relationMetadata(field),
      };
    }
    put({ name: fieldKey, in: "query", schema });
    if (["date", "instant", "datetime", "integer", "number"].includes(field.type)) {
      put({ name: `${fieldKey}From`, in: "query", schema: fieldSchema({ ...field, nullable: false, readOnly: false }) });
      put({ name: `${fieldKey}To`, in: "query", schema: fieldSchema({ ...field, nullable: false, readOnly: false }) });
    }
  }

  for (const semantic of genericComparisonFieldSemantics(model.definition)) {
    const valueSchema: JsonSchema = semantic.source === "model"
      ? fieldSchema({ ...model.definition.fields[semantic.field]!, nullable: false, readOnly: false })
      : { type: "string", format: "date-time" };
    for (const transport of semantic.operators) {
      const metadata = {
        "x-lifespace-query-field": semantic.field,
        "x-lifespace-query-source": semantic.source,
        "x-lifespace-operator": transport.operator,
        "x-lifespace-transport": transport.transport,
      };
      const existing = parameters.get(transport.parameter);
      if (existing) parameters.set(transport.parameter, { ...existing, ...metadata });
      else put({ name: transport.parameter, in: "query", schema: structuredClone(valueSchema), ...metadata });
    }
    if (semantic.localDateWindow) {
      const windowMetadata = {
        "x-lifespace-query-field": semantic.field,
        "x-lifespace-query-source": semantic.source,
        "x-lifespace-window-bounds": semantic.localDateWindow.bounds,
        "x-lifespace-window-lower-operator": semantic.localDateWindow.lowerOperator,
        "x-lifespace-window-upper-operator": semantic.localDateWindow.upperOperator,
      };
      put({
        name: semantic.localDateWindow.dateStartParameter,
        in: "query",
        schema: { type: "string", format: "date" },
        ...windowMetadata,
        "x-lifespace-local-date-window-role": "date-start",
      });
      put({
        name: semantic.localDateWindow.dateEndExclusiveParameter,
        in: "query",
        schema: { type: "string", format: "date" },
        ...windowMetadata,
        "x-lifespace-local-date-window-role": "date-end-exclusive",
      });
      put({
        name: semantic.localDateWindow.timezoneParameter,
        in: "query",
        schema: { type: "string", "x-lifespace-format": "iana-timezone" },
        ...windowMetadata,
        "x-lifespace-local-date-window-role": "viewing-timezone",
      });
    }
  }

  const genericSortValues = new Set([
    "createdAt:asc",
    "createdAt:desc",
    "updatedAt:asc",
    "updatedAt:desc",
  ]);
  for (const fieldKey of model.definition.query?.sortable ?? []) {
    if (model.definition.fields[fieldKey]?.type === "temporal_range") continue;
    genericSortValues.add(`${fieldKey}:asc`);
    genericSortValues.add(`${fieldKey}:desc`);
  }
  const semanticSortValues = new Set<string>();

  if (temporal) {
    put({ name: "attentionOnly", in: "query", schema: { type: "boolean", default: false } });
    semanticSortValues.add("attention:desc");
    semanticSortValues.add("effectiveDate:asc");
    semanticSortValues.add("effectiveDate:desc");
  }

  if (calendarQuery) {
    put({ name: "rangeStart", in: "query", schema: { type: "string", format: "date-time" }, "x-lifespace-paired-with": "rangeEnd", "x-lifespace-compatibility-for": calendarQuery.key });
    put({ name: "rangeEnd", in: "query", schema: { type: "string", format: "date-time" }, "x-lifespace-paired-with": "rangeStart", "x-lifespace-compatibility-for": calendarQuery.key });
    put({ name: "dateStart", in: "query", schema: { type: "string", format: "date" }, "x-lifespace-paired-with": "dateEndExclusive", "x-lifespace-compatibility-for": calendarQuery.key });
    put({ name: "dateEndExclusive", in: "query", schema: { type: "string", format: "date" }, "x-lifespace-paired-with": "dateStart", "x-lifespace-compatibility-for": calendarQuery.key });
    for (const parameter of calendarQuery.parameters) {
      put({
        name: parameter.parameter,
        in: "query",
        schema: parameter.type === "timezone"
          ? { type: "string", "x-lifespace-format": "iana-timezone" }
          : { type: "string", format: "date" },
        "x-lifespace-capability-query": calendarQuery.key,
        "x-lifespace-query-semantics": calendarQuery.semantics,
        "x-lifespace-query-role": parameter.role,
        "x-lifespace-required-with": calendarQuery.parameters
          .filter((candidate) => candidate.parameter !== parameter.parameter)
          .map((candidate) => candidate.parameter),
        "x-lifespace-recurrence-expansion": calendarQuery.recurrenceExpansion,
      });
    }
    for (const value of calendarQuery.ordering.values) semanticSortValues.add(value);
  }

  const genericSortSchema: JsonSchema = {
    type: "array",
    minItems: 1,
    maxItems: 8,
    items: { type: "string", enum: [...genericSortValues] },
    ...(semanticSortValues.size ? {} : { default: ["createdAt:desc"] }),
  };
  put({
    name: "sort",
    in: "query",
    style: "form",
    explode: true,
    description: semanticSortValues.size
      ? "Ordered Generic Query sort criteria may be supplied by repeating sort=field:direction up to 8 times. Capability semantic sort values are standalone and cannot be combined with Generic Query sort criteria."
      : "Ordered sort criteria. Repeat sort=field:direction up to 8 times; criterion order is significant.",
    schema: semanticSortValues.size
      ? {
          oneOf: [
            genericSortSchema,
            { type: "string", enum: [...semanticSortValues] },
          ],
          "x-lifespace-defaults": {
            generic: ["createdAt:desc"],
            ...(temporal ? { temporal: "effectiveDate:asc" } : {}),
            ...(calendarQuery ? { calendar: calendarQuery.ordering.default } : {}),
          },
        }
      : genericSortSchema,
    ...(calendarQuery ? { "x-lifespace-capability-query-ordering": structuredClone(calendarQuery.ordering) } : {}),
  });
  put({ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 100 } });
  put({ name: "cursor", in: "query", schema: { type: "string" } });
  return parameters;
}

function queryParameters(model: PublishedModel): unknown[] {
  return [...parameterMap(model).values()];
}

function addTemporalContract(
  model: PublishedModel,
  schemas: Record<string, JsonSchema>,
  paths: Record<string, unknown>,
  recordPath: string,
  resourceName: string,
): void {
  const temporal = model.definition.capabilities?.temporal;
  if (!temporal?.occurrences) return;

  const occurrenceName = schemaName(model, "TemporalOccurrence");
  const occurrenceListName = schemaName(model, "TemporalOccurrenceListResponse");
  const occurrenceRequestName = schemaName(model, "RecordOccurrenceRequest");
  schemas[occurrenceName] = temporalOccurrenceSchema();
  schemas[occurrenceRequestName] = temporalOccurrenceRequestSchema();
  schemas[occurrenceListName] = {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["items", "nextCursor"],
        properties: {
          items: { type: "array", items: { $ref: `#/components/schemas/${occurrenceName}` } },
          nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
  };

  paths[`${recordPath}/occurrences`] = {
    parameters: [
      { $ref: "#/components/parameters/SpaceId" },
      { $ref: "#/components/parameters/RecordId" },
    ],
    get: {
      operationId: `list_${model.key}_occurrences`,
      tags: [model.definition.display.plural],
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 100 } },
        { name: "cursor", in: "query", schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Temporal occurrence history",
          content: { "application/json": { schema: { $ref: `#/components/schemas/${occurrenceListName}` } } },
        },
      },
    },
  };

  paths[`${recordPath}/actions/record-occurrence`] = {
    parameters: [
      { $ref: "#/components/parameters/SpaceId" },
      { $ref: "#/components/parameters/RecordId" },
    ],
    post: {
      operationId: `record_occurrence_${model.key}`,
      tags: [model.definition.display.plural],
      "x-lifespace-concurrency": actionConcurrencyMetadata(),
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${occurrenceRequestName}` } } },
      },
      responses: {
        "200": {
          description: "Temporal occurrence recorded",
          content: { "application/json": { schema: responseSchemaRef(resourceName) } },
        },
      },
    },
  };
}

function modelOpenApi(model: PublishedModel, schemas: Record<string, JsonSchema>, paths: Record<string, unknown>): void {
  const createName = schemaName(model, "Create");
  const updateName = schemaName(model, "Update");
  const resourceName = schemaName(model, "Resource");
  const versionName = schemaName(model, "VersionRequest");
  const listName = schemaName(model, "ListResponse");
  const canonicalFilterName = schemaName(model, "CanonicalFilter");
  const canonicalQueryName = schemaName(model, "CanonicalQuery");

  schemas[createName] = createSchema(model);
  schemas[updateName] = updateSchema(model);
  schemas[resourceName] = resourceSchema(model);
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
  const canonicalQuery = canonicalQueryContractSchemas(model, `#/components/schemas/${canonicalFilterName}`);
  schemas[canonicalFilterName] = canonicalQuery.filter;
  schemas[canonicalQueryName] = canonicalQuery.query;

  const collectionPath = `/api/v1/spaces/{spaceId}/models/${model.key}/records`;
  const recordPath = `${collectionPath}/{recordId}`;
  paths[collectionPath] = {
    parameters: [{ $ref: "#/components/parameters/SpaceId" }],
    get: {
      operationId: `list_${model.key}`,
      tags: [model.definition.display.plural],
      parameters: queryParameters(model),
      responses: {
        "200": {
          description: "Model records",
          content: { "application/json": { schema: { $ref: `#/components/schemas/${listName}` } } },
        },
      },
    },
    post: {
      operationId: `create_${model.key}`,
      tags: [model.definition.display.plural],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${createName}` } } },
      },
      responses: {
        "201": {
          description: "Created model record",
          content: { "application/json": { schema: responseSchemaRef(resourceName) } },
        },
      },
    },
  };

  paths[`${collectionPath}/query`] = {
    parameters: [{ $ref: "#/components/parameters/SpaceId" }],
    post: {
      operationId: `query_${model.key}`,
      tags: [model.definition.display.plural],
      "x-lifespace-canonical-query": true,
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${canonicalQueryName}` } } },
      },
      responses: {
        "200": {
          description: "Canonical Typed Query result",
          content: { "application/json": { schema: { $ref: `#/components/schemas/${listName}` } } },
        },
      },
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
      responses: {
        "200": {
          description: "Model record",
          content: { "application/json": { schema: responseSchemaRef(resourceName) } },
        },
      },
    },
    patch: {
      operationId: `update_${model.key}`,
      tags: [model.definition.display.plural],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${updateName}` } } },
      },
      responses: {
        "200": {
          description: "Updated model record",
          content: { "application/json": { schema: responseSchemaRef(resourceName) } },
        },
      },
    },
    delete: {
      operationId: `delete_${model.key}`,
      tags: [model.definition.display.plural],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: `#/components/schemas/${versionName}` } } },
      },
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
        "x-lifespace-concurrency": actionConcurrencyMetadata(),
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: `#/components/schemas/${versionName}` } } },
        },
        responses: {
          "200": {
            description: "Action result",
            content: { "application/json": { schema: responseSchemaRef(resourceName) } },
          },
        },
      },
    };
  }

  addTemporalContract(model, schemas, paths, recordPath, resourceName);
}

function jsonSchemaBundle(models: PublishedModel[]): JsonSchema {
  const defs: Record<string, JsonSchema> = {};
  const metadata: Record<string, unknown> = {};
  for (const model of models) {
    const prefix = schemaName(model, "");
    const canonicalFilterName = `${prefix}CanonicalFilter`;
    const canonicalQueryName = `${prefix}CanonicalQuery`;
    const canonicalQuery = canonicalQueryContractSchemas(model, `#/$defs/${canonicalFilterName}`);
    defs[`${prefix}Create`] = createSchema(model);
    defs[`${prefix}Update`] = updateSchema(model);
    defs[`${prefix}Resource`] = resourceSchema(model);
    defs[`${prefix}VersionRequest`] = versionRequestSchema();
    defs[canonicalFilterName] = canonicalQuery.filter;
    defs[canonicalQueryName] = canonicalQuery.query;
    const capabilityActions = model.definition.capabilities?.temporal?.occurrences ? ["record-occurrence"] : [];
    metadata[model.key] = {
      version: model.version,
      schemaHash: model.schemaHash,
      referenceLabel: referenceLabelSemantic(model.definition),
      createSchema: `#/$defs/${prefix}Create`,
      updateSchema: `#/$defs/${prefix}Update`,
      resourceSchema: `#/$defs/${prefix}Resource`,
      canonicalFilterSchema: `#/$defs/${canonicalFilterName}`,
      canonicalQuerySchema: `#/$defs/${canonicalQueryName}`,
      actions: [...Object.keys(model.definition.actions ?? {}).sort(), ...capabilityActions],
      capabilities: Object.keys(model.definition.capabilities ?? {}).sort(),
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
      description: "Concrete modelKey-addressed paths generated from an immutable LifeSpace Model Registry snapshot. Kernel APIs are versioned separately.",
    },
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT or lsp_pat_" },
      },
      parameters: {
        SpaceId: {
          name: "spaceId",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^spc_" },
        },
        RecordId: {
          name: "recordId",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^rec_" },
        },
      },
      schemas,
    },
  };
  const jsonSchema = jsonSchemaBundle(models);
  const hash = await sha256(canonicalJson({ manifest, openapi, jsonSchema }));
  return { id: `mct_${hash}`, hash, manifest, openapi, jsonSchema };
}
