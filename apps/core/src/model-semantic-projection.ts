import { isCanonicalCalendarCapability, type CalendarCapabilityDefinition, type TemporalCapabilityDefinition } from "./capability-definition";
import { canonicalQuerySemanticDescriptor, type CanonicalQuerySemanticDescriptor } from "./canonical-query-contract";
import { calendarViewingWindowSemanticQuery } from "./calendar-query-semantics";
import { isFirstClassRangeFieldType, type FieldDefinition, type ModelAccess } from "./model-definition";
import type { PublishedModel } from "./model-registry";
import { referenceLabelSemantic, type ReferenceLabelSemantic } from "./reference-label";
import { relationSemanticMetadata, type RelationResolutionDescriptor } from "./relation-semantic";
import { semanticRelationDiscovery, SEMANTIC_RELATION_RUNTIME } from "./semantic-relation-definition";
import { genericComparisonFieldSemantics, type GenericComparisonFieldSemantic } from "./query-semantics";
import { projectTimeRangeSemantics, type TimeRangeSemantic } from "./time-range-definition";

export type ModelRelationSemantic = {
  targetModel: string;
  cardinality: "one" | "many";
  resolution: RelationResolutionDescriptor;
};

export type ModelSemanticField = FieldDefinition & {
  key: string;
  relation?: ModelRelationSemantic;
};

export type ModelSemanticActionInputField = {
  key: string;
  type: FieldDefinition["type"];
  title?: string;
  description?: string;
  required?: boolean;
  nullable?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  values?: string[];
};

export type ModelSemanticActionConcurrency = {
  strategy: "record-version";
  required: true;
  transport: { in: "body"; name: "version" };
};

export type ModelSemanticAction = {
  key: string;
  access: ModelAccess;
  kind: "workflow" | "capability";
  input: { fields: ModelSemanticActionInputField[] };
  concurrency: ModelSemanticActionConcurrency;
  invocation: {
    method: "POST";
    pathTemplate: string;
  };
};

export type ModelSemanticFilter = {
  field: string;
  parameter: string;
  mode: "exact" | "enum-set";
  range?: { fromParameter: string; toParameter: string };
  acceptsCurrentActorPersonAlias?: "me";
};

export type ModelSemanticQueryParameter = {
  parameter: string;
  type: "boolean" | "date" | "datetime";
  default?: boolean;
  pairedWith?: string;
};

export type ModelSemanticCapabilityQuery = ReturnType<typeof calendarViewingWindowSemanticQuery>;
export type ModelSemanticRelations = ReturnType<typeof semanticRelationDiscovery>;

export type ModelSemanticQueryFacts = {
  canonical: CanonicalQuerySemanticDescriptor;
  legacyDeprecated: true;
  searchable: string[];
  filterable: string[];
  sortable: string[];
  search: null | {
    parameter: "q";
    minLength: 1;
    maxLength: 100;
  };
  filters: ModelSemanticFilter[];
  comparisons: GenericComparisonFieldSemantic[];
  sort: {
    parameter: "sort";
    syntax: "field:direction";
    repeatable: true;
    ordered: true;
    maxCriteria: 8;
    genericDefault: ["createdAt:desc"];
    envelopeFields: ["createdAt", "updatedAt"];
    nullPlacement: "last";
    genericValues: string[];
    semantic: {
      standalone: true;
      values: string[];
      defaults: {
        temporal?: "effectiveDate:asc";
        calendar?: "calendarStart:asc";
      };
    };
  };
  pagination: {
    limit: { parameter: "limit"; minimum: 1; maximum: 200; default: 100 };
    cursor: { parameter: "cursor"; type: "string" };
  };
  capabilityParameters: ModelSemanticQueryParameter[];
  capabilityQueries: ModelSemanticCapabilityQuery[];
};

export type ModelSemanticCapabilityBindings = {
  calendar?: CalendarCapabilityDefinition;
  temporal?: TemporalCapabilityDefinition;
};

export type ModelSemanticProjection = {
  key: string;
  version: number;
  schemaHash: string;
  display: { singular: string; plural: string };
  description: string | null;
  referenceLabel: ReferenceLabelSemantic;
  declaredAccess: ModelAccess[];
  fields: ModelSemanticField[];
  semanticRelations: ModelSemanticRelations;
  semanticRelationRuntime: typeof SEMANTIC_RELATION_RUNTIME;
  timeRanges: TimeRangeSemantic[];
  defaults: Record<string, unknown>;
  query: ModelSemanticQueryFacts;
  actions: ModelSemanticAction[];
  capabilities: string[];
  capabilityBindings: ModelSemanticCapabilityBindings;
};

const RECORD_VERSION_CONCURRENCY: ModelSemanticActionConcurrency = {
  strategy: "record-version",
  required: true,
  transport: { in: "body", name: "version" },
};

export function modelActionConcurrency(): ModelSemanticActionConcurrency {
  return structuredClone(RECORD_VERSION_CONCURRENCY);
}

export function relationSemantic(field: FieldDefinition): ModelRelationSemantic | null {
  return relationSemanticMetadata(field);
}

export function modelFieldSemanticFacts(model: PublishedModel): ModelSemanticField[] {
  return Object.entries(model.definition.fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, field]) => {
      const relation = relationSemantic(field);
      return {
        key,
        ...structuredClone(field),
        ...(relation ? { relation } : {}),
      };
    });
}

function supportsRange(field: FieldDefinition): boolean {
  return field.type === "date" || field.type === "instant" || field.type === "datetime" || field.type === "integer" || field.type === "number";
}

function acceptsCurrentActorPersonAlias(model: PublishedModel, fieldKey: string, field: FieldDefinition): boolean {
  if (field.type !== "person" && field.type !== "person_list") return false;
  return model.definition.capabilities?.temporal?.subjectPersonField === fieldKey
    || model.definition.capabilities?.calendar?.attendeePersonField === fieldKey;
}

export function modelQuerySemanticFacts(model: PublishedModel): ModelSemanticQueryFacts {
  const searchable = [...(model.definition.query?.searchable ?? [])];
  const filterable = [...(model.definition.query?.filterable ?? [])];
  const sortable = [...(model.definition.query?.sortable ?? [])];
  const filters = filterable.flatMap((fieldKey) => {
    const field = model.definition.fields[fieldKey];
    if (!field || field.type === "temporal_range" || isFirstClassRangeFieldType(field.type)) return [];
    return [{
      field: fieldKey,
      parameter: fieldKey,
      mode: field.type === "enum" ? "enum-set" as const : "exact" as const,
      ...(supportsRange(field)
        ? { range: { fromParameter: `${fieldKey}From`, toParameter: `${fieldKey}To` } }
        : {}),
      ...(acceptsCurrentActorPersonAlias(model, fieldKey, field) ? { acceptsCurrentActorPersonAlias: "me" as const } : {}),
    }];
  });

  const genericValues = [
    "createdAt:asc",
    "createdAt:desc",
    "updatedAt:asc",
    "updatedAt:desc",
    ...sortable.flatMap((fieldKey) => [`${fieldKey}:asc`, `${fieldKey}:desc`]),
  ];
  const semanticValues: string[] = [];
  const semanticDefaults: ModelSemanticQueryFacts["sort"]["semantic"]["defaults"] = {};
  const capabilityParameters: ModelSemanticQueryParameter[] = [];
  const capabilityQueries: ModelSemanticCapabilityQuery[] = [];

  if (model.definition.capabilities?.temporal) {
    capabilityParameters.push({ parameter: "attentionOnly", type: "boolean", default: false });
    semanticValues.push("attention:desc", "effectiveDate:asc", "effectiveDate:desc");
    semanticDefaults.temporal = "effectiveDate:asc";
  }

  const calendar = model.definition.capabilities?.calendar;
  if (calendar && !isCanonicalCalendarCapability(calendar)) {
    capabilityParameters.push(
      { parameter: "rangeStart", type: "datetime", pairedWith: "rangeEnd" },
      { parameter: "rangeEnd", type: "datetime", pairedWith: "rangeStart" },
      { parameter: "dateStart", type: "date", pairedWith: "dateEndExclusive" },
      { parameter: "dateEndExclusive", type: "date", pairedWith: "dateStart" },
    );
    const calendarQuery = calendarViewingWindowSemanticQuery();
    capabilityQueries.push(calendarQuery);
    semanticValues.push(...calendarQuery.ordering.values);
    semanticDefaults.calendar = calendarQuery.ordering.default;
  }

  return {
    canonical: canonicalQuerySemanticDescriptor(model),
    legacyDeprecated: true,
    searchable,
    filterable,
    sortable,
    search: searchable.length ? { parameter: "q", minLength: 1, maxLength: 100 } : null,
    filters,
    comparisons: genericComparisonFieldSemantics(model.definition),
    sort: {
      parameter: "sort",
      syntax: "field:direction",
      repeatable: true,
      ordered: true,
      maxCriteria: 8,
      genericDefault: ["createdAt:desc"],
      envelopeFields: ["createdAt", "updatedAt"],
      nullPlacement: "last",
      genericValues,
      semantic: {
        standalone: true,
        values: semanticValues,
        defaults: semanticDefaults,
      },
    },
    pagination: {
      limit: { parameter: "limit", minimum: 1, maximum: 200, default: 100 },
      cursor: { parameter: "cursor", type: "string" },
    },
    capabilityParameters,
    capabilityQueries,
  };
}

function temporalOccurrenceInputs(): ModelSemanticActionInputField[] {
  return [
    {
      key: "occurredOn",
      type: "date",
      title: "Occurrence Date",
      required: true,
      description: "Occurrence date in YYYY-MM-DD form. Runtime rules still validate it against the current anchor and Space date.",
    },
    {
      key: "note",
      type: "text",
      title: "Note",
      nullable: true,
      maxLength: 1000,
      description: "Optional occurrence note.",
    },
  ];
}

function actionPath(model: PublishedModel, actionKey: string): string {
  return `/api/v1/spaces/{spaceId}/models/${model.key}/records/{recordId}/actions/${actionKey}`;
}

export function modelActionSemanticFacts(model: PublishedModel): ModelSemanticAction[] {
  const workflow: ModelSemanticAction[] = Object.entries(model.definition.actions ?? {}).map(([key, action]) => ({
    key,
    access: action.access,
    kind: "workflow",
    input: { fields: [] },
    concurrency: modelActionConcurrency(),
    invocation: { method: "POST", pathTemplate: actionPath(model, key) },
  }));
  if (model.definition.capabilities?.temporal?.occurrences === true) {
    workflow.push({
      key: "record-occurrence",
      access: "write",
      kind: "capability",
      input: { fields: temporalOccurrenceInputs() },
      concurrency: modelActionConcurrency(),
      invocation: { method: "POST", pathTemplate: actionPath(model, "record-occurrence") },
    });
  }
  return workflow.sort((left, right) => left.key.localeCompare(right.key));
}

export function modelCapabilitySemanticFacts(model: PublishedModel): {
  capabilities: string[];
  capabilityBindings: ModelSemanticCapabilityBindings;
} {
  const calendar = model.definition.capabilities?.calendar;
  const temporal = model.definition.capabilities?.temporal;
  return {
    capabilities: Object.keys(model.definition.capabilities ?? {}).sort(),
    capabilityBindings: {
      ...(calendar ? { calendar: structuredClone(calendar) } : {}),
      ...(temporal ? { temporal: structuredClone(temporal) } : {}),
    },
  };
}

export function projectModelSemanticFacts(model: PublishedModel): ModelSemanticProjection {
  const capability = modelCapabilitySemanticFacts(model);
  return {
    key: model.key,
    version: model.version,
    schemaHash: model.schemaHash,
    display: structuredClone(model.definition.display),
    description: model.definition.description ?? null,
    referenceLabel: referenceLabelSemantic(model.definition),
    declaredAccess: [...model.definition.access],
    fields: modelFieldSemanticFacts(model),
    semanticRelations: semanticRelationDiscovery(model.key, model.definition.semanticRelations),
    semanticRelationRuntime: SEMANTIC_RELATION_RUNTIME,
    timeRanges: projectTimeRangeSemantics(model.definition),
    defaults: structuredClone(model.definition.defaults ?? {}),
    query: modelQuerySemanticFacts(model),
    actions: modelActionSemanticFacts(model),
    capabilities: capability.capabilities,
    capabilityBindings: capability.capabilityBindings,
  };
}
