import type { PublishedModel } from "./model-registry";
import { projectTimeRangeSemantics } from "./time-range-definition";

export type CanonicalQueryContractSchemas = {
  filter: Record<string, unknown>;
  query: Record<string, unknown>;
};

const VALUE_OPERATORS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "within",
  "contains",
  "overlaps",
  "before",
  "after",
  "kindIs",
] as const;
const NULL_OPERATORS = ["isNull", "isNotNull"] as const;

function rangeOperandSchema(): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "startDate", "endDateExclusive", "timezone"],
        properties: {
          kind: { const: "local_date_window" },
          startDate: { type: "string", format: "date" },
          endDateExclusive: { type: "string", format: "date" },
          timezone: { type: "string", "x-lifespace-format": "iana-timezone" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "start", "endExclusive"],
        properties: {
          kind: { const: "date" },
          start: { type: "string", format: "date" },
          endExclusive: { type: "string", format: "date" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "start", "endExclusive"],
        properties: {
          kind: { const: "instant" },
          start: { type: "string", format: "date-time" },
          endExclusive: { type: "string", format: "date-time" },
        },
      },
    ],
  };
}

function predicateValueSchema(): Record<string, unknown> {
  return {
    description: "Value shape is validated against the selected field semantic type and operator by Canonical Query Runtime.",
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      rangeOperandSchema(),
    ],
  };
}

function queryTargetFields(model: PublishedModel): string[] {
  const filterable = new Set(model.definition.query?.filterable ?? []);
  const fields = new Set(["createdAt", "updatedAt", ...filterable]);
  for (const range of projectTimeRangeSemantics(model.definition)) {
    if (range.source === "model" && filterable.has(range.startField) && filterable.has(range.endField)) {
      fields.add(range.key);
    }
  }
  if (model.definition.capabilities?.calendar) fields.add("when");
  return [...fields].sort();
}

export function canonicalQueryContractSchemas(
  model: PublishedModel,
  filterRef: string,
): CanonicalQueryContractSchemas {
  const targets = queryTargetFields(model);
  const fieldSchema = { type: "string", enum: targets };
  const filter = {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["and"],
        properties: {
          and: { type: "array", minItems: 1, maxItems: 100, items: { $ref: filterRef } },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["or"],
        properties: {
          or: { type: "array", minItems: 1, maxItems: 100, items: { $ref: filterRef } },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["field", "op"],
        properties: {
          field: fieldSchema,
          op: { type: "string", enum: [...NULL_OPERATORS] },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["field", "op", "value"],
        properties: {
          field: fieldSchema,
          op: { type: "string", enum: [...VALUE_OPERATORS] },
          value: predicateValueSchema(),
        },
      },
    ],
    "x-lifespace-max-depth": 8,
    "x-lifespace-max-nodes": 100,
    "x-lifespace-operator-selection": "derived-from-field-semantic-type",
    "x-lifespace-relation-membership-primitive": "contains",
  };

  const sortableFields = [...new Set([
    "createdAt",
    "updatedAt",
    ...(model.definition.query?.sortable ?? []),
  ])].sort();
  const properties: Record<string, unknown> = {
    filter: { $ref: filterRef },
    sort: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      default: [{ field: "createdAt", direction: "desc" }],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "direction"],
        properties: {
          field: { type: "string", enum: sortableFields },
          direction: { type: "string", enum: ["asc", "desc"] },
        },
      },
      "x-lifespace-null-placement": "last",
      "x-lifespace-stable-tie-breaker": "record-id-asc",
    },
    page: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
        cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
  };
  if (model.definition.query?.searchable?.length) {
    properties.search = {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 100 } },
      "x-lifespace-searchable-fields": [...model.definition.query.searchable],
    };
  }

  const query = {
    type: "object",
    additionalProperties: false,
    properties,
    "x-lifespace-canonical-query": true,
    "x-lifespace-pipeline": ["search", "filter", "sort", "cursor-pagination"],
    "x-lifespace-cursor": {
      opaque: true,
      binds: ["normalized-search", "normalized-filter", "effective-sort", "temporal-viewing-context", "continuation-key"],
      snapshotConsistency: false,
    },
  };
  return { filter, query };
}
