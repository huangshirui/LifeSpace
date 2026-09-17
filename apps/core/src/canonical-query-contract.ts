import type { FieldDefinition } from "./model-definition";
import type { PublishedModel } from "./model-registry";
import { projectTimeRangeSemantics } from "./time-range-definition";

export type CanonicalQueryTargetDescriptor = {
  field: string;
  kind: "envelope" | "field" | "time-range" | "calendar-range";
  valueType: FieldDefinition["type"] | "date-range" | "instant-range" | "temporal-range";
  operators: string[];
  nullable: boolean;
  acceptsCurrentActorPersonAlias?: "me";
};

export type CanonicalQuerySemanticDescriptor = {
  invocation: {
    method: "POST";
    pathTemplate: "/api/v1/spaces/{spaceId}/models/{modelKey}/records/query";
  };
  composition: {
    selectionFacets: ["search", "filter"];
    selectionCombine: "intersection";
    ordering: "sort";
    pagination: "cursor-pagination";
  };
  search: null | { fields: string[]; minLength: 1; maxLength: 100 };
  filter: {
    maxDepth: 8;
    maxNodes: 100;
    targets: CanonicalQueryTargetDescriptor[];
  };
  sort: {
    fields: string[];
    directions: ["asc", "desc"];
    maxCriteria: 8;
    default: [{ field: "createdAt"; direction: "desc" }];
    nullPlacement: "last";
    stableTieBreaker: "record-id-asc";
    temporalRange: null | {
      context: "context.viewingTimezone";
      ordering: ["projectedStart", "projectedEnd", "record-id-asc"];
    };
  };
  pagination: {
    limit: { minimum: 1; maximum: 200; default: 100 };
    cursor: {
      opaque: true;
      binds: ["normalized-search", "normalized-filter", "effective-sort", "temporal-viewing-context", "continuation-key"];
      snapshotConsistency: false;
    };
  };
};

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

function currentActorAliasAllowed(model: PublishedModel, fieldKey: string, field: FieldDefinition): boolean {
  return (field.type === "person" || field.type === "person_list")
    && (model.definition.capabilities?.calendar?.attendeePersonField === fieldKey
      || model.definition.capabilities?.temporal?.subjectPersonField === fieldKey);
}

function fieldOperators(field: FieldDefinition): string[] {
  if (["person", "person_list", "record", "record_list"].includes(field.type)) return ["contains"];
  if (field.type === "temporal_range") {
    return [
      "overlaps",
      "contains",
      "before",
      "after",
      "kindIs",
      ...(field.nullable === true ? ["isNull", "isNotNull"] : []),
    ];
  }
  const operators = ["eq", "ne"];
  if (["date", "datetime", "integer", "number"].includes(field.type)) {
    operators.push("lt", "lte", "gt", "gte");
  }
  if (field.type === "date" || field.type === "datetime") operators.push("within");
  if (field.nullable === true) operators.push("isNull", "isNotNull");
  return operators;
}

export function canonicalQuerySemanticDescriptor(model: PublishedModel): CanonicalQuerySemanticDescriptor {
  const filterable = new Set(model.definition.query?.filterable ?? []);
  const targets: CanonicalQueryTargetDescriptor[] = [
    {
      field: "createdAt",
      kind: "envelope",
      valueType: "datetime",
      operators: ["eq", "ne", "lt", "lte", "gt", "gte", "within"],
      nullable: false,
    },
    {
      field: "updatedAt",
      kind: "envelope",
      valueType: "datetime",
      operators: ["eq", "ne", "lt", "lte", "gt", "gte", "within"],
      nullable: false,
    },
  ];
  for (const fieldKey of [...filterable].sort()) {
    const field = model.definition.fields[fieldKey];
    if (!field) continue;
    targets.push({
      field: fieldKey,
      kind: "field",
      valueType: field.type,
      operators: fieldOperators(field),
      nullable: field.nullable === true,
      ...(currentActorAliasAllowed(model, fieldKey, field) ? { acceptsCurrentActorPersonAlias: "me" as const } : {}),
    });
  }
  for (const range of projectTimeRangeSemantics(model.definition)) {
    if (range.source === "model" && filterable.has(range.startField) && filterable.has(range.endField)) {
      targets.push({
        field: range.key,
        kind: "time-range",
        valueType: range.valueType === "date" ? "date-range" : "instant-range",
        operators: ["overlaps", "contains", "before", "after"],
        nullable: false,
      });
    }
  }
  const calendar = model.definition.capabilities?.calendar;
  if (calendar && !("rangeField" in calendar)) {
    targets.push({
      field: "when",
      kind: "calendar-range",
      valueType: "temporal-range",
      operators: ["overlaps", "contains", "before", "after", "kindIs"],
      nullable: false,
    });
  }
  targets.sort((left, right) => left.field.localeCompare(right.field) || left.kind.localeCompare(right.kind));
  const sortable = [...new Set(["createdAt", "updatedAt", ...(model.definition.query?.sortable ?? [])])].sort();
  const hasTemporalSort = (model.definition.query?.sortable ?? []).some(
    (fieldKey) => model.definition.fields[fieldKey]?.type === "temporal_range",
  );
  const searchable = [...(model.definition.query?.searchable ?? [])];
  return {
    invocation: {
      method: "POST",
      pathTemplate: "/api/v1/spaces/{spaceId}/models/{modelKey}/records/query",
    },
    composition: {
      selectionFacets: ["search", "filter"],
      selectionCombine: "intersection",
      ordering: "sort",
      pagination: "cursor-pagination",
    },
    search: searchable.length ? { fields: searchable, minLength: 1, maxLength: 100 } : null,
    filter: { maxDepth: 8, maxNodes: 100, targets },
    sort: {
      fields: sortable,
      directions: ["asc", "desc"],
      maxCriteria: 8,
      default: [{ field: "createdAt", direction: "desc" }],
      nullPlacement: "last",
      stableTieBreaker: "record-id-asc",
      temporalRange: hasTemporalSort
        ? {
            context: "context.viewingTimezone",
            ordering: ["projectedStart", "projectedEnd", "record-id-asc"],
          }
        : null,
    },
    pagination: {
      limit: { minimum: 1, maximum: 200, default: 100 },
      cursor: {
        opaque: true,
        binds: ["normalized-search", "normalized-filter", "effective-sort", "temporal-viewing-context", "continuation-key"],
        snapshotConsistency: false,
      },
    },
  };
}

export function canonicalQueryContractSchemas(
  model: PublishedModel,
  filterRef: string,
): CanonicalQueryContractSchemas {
  const descriptor = canonicalQuerySemanticDescriptor(model);
  const targets = descriptor.filter.targets.map((target) => target.field);
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
    "x-lifespace-targets": descriptor.filter.targets,
  };

  const sortableFields = descriptor.sort.fields;
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
  if ((model.definition.query?.sortable ?? []).some(
    (fieldKey) => model.definition.fields[fieldKey]?.type === "temporal_range",
  )) {
    properties.context = {
      type: "object",
      additionalProperties: false,
      required: ["viewingTimezone"],
      properties: {
        viewingTimezone: {
          type: "string",
          "x-lifespace-format": "iana-timezone",
        },
      },
      "x-lifespace-required-with-sort-type": "temporal_range",
    };
  }
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
    "x-lifespace-composition": descriptor.composition,
    "x-lifespace-cursor": descriptor.pagination.cursor,
    "x-lifespace-semantic-descriptor": descriptor,
  };
  return { filter, query };
}
