import type { FieldType, ModelDefinition } from "./model-definition";

export const GENERIC_COMPARISON_OPERATORS = ["eq", "lt", "lte", "gt", "gte"] as const;
export type GenericComparisonOperator = typeof GENERIC_COMPARISON_OPERATORS[number];
export type GenericComparisonValueType = Extract<FieldType, "date" | "instant" | "datetime" | "integer" | "number">;
export type GenericQueryFieldSource = "model" | "envelope";
export type GenericQueryTransportKind = "legacy" | "explicit";

export type GenericComparisonTransport = {
  operator: GenericComparisonOperator;
  parameter: string;
  transport: GenericQueryTransportKind;
};

export type GenericLocalDateWindowTransport = {
  dateStartParameter: string;
  dateEndExclusiveParameter: string;
  timezoneParameter: string;
  bounds: "[)";
  lowerOperator: "gte";
  upperOperator: "lt";
};

export type GenericComparisonFieldSemantic = {
  field: string;
  source: GenericQueryFieldSource;
  valueType: GenericComparisonValueType;
  operators: GenericComparisonTransport[];
  localDateWindow?: GenericLocalDateWindowTransport;
};

const COMPARABLE_TYPES = new Set<GenericComparisonValueType>(["date", "instant", "datetime", "integer", "number"]);
const ENVELOPE_FIELDS = [
  { field: "createdAt", valueType: "instant" },
  { field: "updatedAt", valueType: "instant" },
] as const satisfies ReadonlyArray<{ field: string; valueType: GenericComparisonValueType }>;

export function isGenericComparableFieldType(type: FieldType): type is GenericComparisonValueType {
  return COMPARABLE_TYPES.has(type as GenericComparisonValueType);
}

export function explicitComparisonParameter(field: string, operator: GenericComparisonOperator): string {
  return `${field}.${operator}`;
}

export function localDateWindowParameters(field: string): GenericLocalDateWindowTransport {
  return {
    dateStartParameter: `${field}.dateStart`,
    dateEndExclusiveParameter: `${field}.dateEndExclusive`,
    timezoneParameter: `${field}.timezone`,
    bounds: "[)",
    lowerOperator: "gte",
    upperOperator: "lt",
  };
}

function explicitOperators(field: string): GenericComparisonTransport[] {
  return GENERIC_COMPARISON_OPERATORS.map((operator) => ({
    operator,
    parameter: explicitComparisonParameter(field, operator),
    transport: "explicit",
  }));
}

function modelFieldSemantics(
  field: string,
  valueType: GenericComparisonValueType,
): GenericComparisonFieldSemantic {
  const operators: GenericComparisonTransport[] = [
    { operator: "eq", parameter: field, transport: "legacy" },
    { operator: "gte", parameter: `${field}From`, transport: "legacy" },
    { operator: "lte", parameter: `${field}To`, transport: "legacy" },
    ...explicitOperators(field),
  ];
  return {
    field,
    source: "model",
    valueType,
    operators,
    ...((valueType === "instant" || valueType === "datetime") ? { localDateWindow: localDateWindowParameters(field) } : {}),
  };
}

function envelopeFieldSemantics(
  field: string,
  valueType: GenericComparisonValueType,
): GenericComparisonFieldSemantic {
  return {
    field,
    source: "envelope",
    valueType,
    operators: explicitOperators(field),
    ...((valueType === "instant" || valueType === "datetime") ? { localDateWindow: localDateWindowParameters(field) } : {}),
  };
}

/**
 * Compiles the platform-owned comparison-query contract for one Model Definition.
 *
 * Model `query.filterable` continues to declare queryability rather than a second
 * operator DSL. Comparable model fields inherit stable platform comparison
 * semantics. Platform envelope timestamps are always comparison-queryable.
 * Legacy `field`, `fieldFrom`, and `fieldTo` transports remain explicit aliases
 * for eq/gte/lte; new transports use collision-free `field.operator` names.
 */
export function genericComparisonFieldSemantics(
  definition: ModelDefinition,
): GenericComparisonFieldSemantic[] {
  const modelFields = (definition.query?.filterable ?? []).flatMap((field) => {
    const definitionField = definition.fields[field];
    return definitionField && isGenericComparableFieldType(definitionField.type)
      ? [modelFieldSemantics(field, definitionField.type === "datetime" ? "instant" : definitionField.type)]
      : [];
  });
  return [
    ...modelFields,
    ...ENVELOPE_FIELDS.map(({ field, valueType }) => envelopeFieldSemantics(field, valueType)),
  ];
}
