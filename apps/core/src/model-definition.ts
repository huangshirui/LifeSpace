import { validateCapabilities, type CapabilityDefinitions } from "./capability-definition";
import { validateModelPolicies, type ModelPoliciesDefinition } from "./policy-definition";
import {
  parseReferenceLabelTemplate,
  REFERENCE_LABEL_TEMPLATE_MAX_LENGTH,
  type ReferenceLabelDefinition,
} from "./reference-label-syntax";
import {
  isSemanticRelationPredicate,
  semanticRelationAllowsSource,
  type SemanticRelationDefinition,
  type SemanticRelationPredicate,
} from "./semantic-relation-definition";
import {
  validateCalendarTimeRangeCollisions,
  validateTimeRanges,
  type TimeRangeDefinitions,
} from "./time-range-definition";
import { isRfc3339Instant } from "./time-semantics";
import { validateWorkflowActions, type WorkflowActionsDefinition } from "./workflow-definition";

export type { ReferenceLabelDefinition } from "./reference-label-syntax";
export type { SemanticRelationDefinition, SemanticRelationPredicate } from "./semantic-relation-definition";
export type { TimeRangeBounds, TimeRangeDefinition, TimeRangeDefinitions } from "./time-range-definition";

export const MODEL_DEFINITION_VERSION = 1 as const;

export const CANONICAL_FIELD_TYPES = [
  "string",
  "text",
  "integer",
  "number",
  "boolean",
  "date",
  "instant",
  "range<date>",
  "range<instant>",
  "temporal_range",
  "recurrence_rule",
  "entity_ref",
  "timezone",
  "enum",
  "person",
  "person_list",
  "record",
  "record_list",
] as const;

export const LEGACY_FIELD_TYPES = ["datetime"] as const;
export const FIELD_TYPES = [...CANONICAL_FIELD_TYPES, ...LEGACY_FIELD_TYPES] as const;

export type CanonicalFieldType = typeof CANONICAL_FIELD_TYPES[number];
export type FieldType = typeof FIELD_TYPES[number];

export function canonicalFieldType(type: FieldType): CanonicalFieldType {
  return type === "datetime" ? "instant" : type;
}

export function isInstantFieldType(type: FieldType): boolean {
  return type === "instant" || type === "datetime";
}

export function isFirstClassRangeFieldType(type: FieldType): type is "range<date>" | "range<instant>" {
  return type === "range<date>" || type === "range<instant>";
}

export function rangeFieldValueType(type: "range<date>" | "range<instant>"): "date" | "instant" {
  return type === "range<date>" ? "date" : "instant";
}
export type ModelAccess = "read" | "write" | "manage";
export type ModelDefaultValue = string | number | boolean | null | string[];

export type FieldDefinition = {
  type: FieldType;
  title?: string;
  description?: string;
  required?: boolean;
  nullable?: boolean;
  immutable?: boolean;
  readOnly?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  values?: string[];
  targetModel?: string;
};

export type QueryDefinition = {
  searchable?: string[];
  filterable?: string[];
  sortable?: string[];
};

export type ModelDefinition = {
  definitionVersion: typeof MODEL_DEFINITION_VERSION;
  origin?: "external";
  key: string;
  description?: string;
  display: {
    singular: string;
    plural: string;
  };
  fields: Record<string, FieldDefinition>;
  semanticRelations?: SemanticRelationDefinition;
  timeRanges?: TimeRangeDefinitions;
  referenceLabel?: ReferenceLabelDefinition;
  defaults?: Record<string, ModelDefaultValue>;
  query?: QueryDefinition;
  access: ModelAccess[];
  lifecycle?: {
    optimisticConcurrency?: true;
    softDelete?: true;
  };
  capabilities?: CapabilityDefinitions;
  policies?: ModelPoliciesDefinition;
  actions?: WorkflowActionsDefinition;
};

export type ModelValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type ModelValidationResult =
  | { valid: true; definition: ModelDefinition; hashInput: string }
  | { valid: false; issues: ModelValidationIssue[] };

const MODEL_KEY = /^[a-z][a-z0-9_]{1,62}$/;
const FIELD_KEY = /^[a-z][A-Za-z0-9]{0,62}$/;
const RESERVED_FIELDS = new Set([
  "id",
  "spaceId",
  "modelKey",
  "modelVersion",
  "version",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "createdBy",
  "updatedBy",
]);
const FIELD_TYPE_SET = new Set<string>(FIELD_TYPES);
const ACCESS_SET = new Set<string>(["read", "write", "manage"]);
const REFERENCE_LABEL_FIELD_TYPES = new Set<FieldType>([
  "string",
  "text",
  "integer",
  "number",
  "boolean",
  "date",
  "instant",
  "datetime",
  "timezone",
  "enum",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(issues: ModelValidationIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

function boundedText(
  issues: ModelValidationIssue[],
  value: unknown,
  path: string,
  max: number,
  required = false,
): string | undefined {
  if (value === undefined) {
    if (required) issue(issues, path, "TEXT_REQUIRED", `${path} is required`);
    return undefined;
  }
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    issue(issues, path, "INVALID_TEXT", `${path} must contain 1-${max} characters`);
    return undefined;
  }
  return value.trim();
}

function integerConstraint(
  issues: ModelValidationIssue[],
  value: unknown,
  path: string,
  minimum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < minimum) {
    issue(issues, path, "INVALID_CONSTRAINT", `${path} must be an integer >= ${minimum}`);
    return undefined;
  }
  return Number(value);
}

function stringArray(
  issues: ModelValidationIssue[],
  value: unknown,
  path: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    issue(issues, path, "INVALID_LIST", `${path} must be an array of non-empty strings`);
    return undefined;
  }
  if (new Set(value).size !== value.length) {
    issue(issues, path, "DUPLICATE_VALUE", `${path} must not contain duplicates`);
  }
  return [...value];
}

function validateSemanticRelations(
  raw: unknown,
  modelKey: string,
  issues: ModelValidationIssue[],
): SemanticRelationDefinition | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    issue(issues, "semanticRelations", "INVALID_SEMANTIC_RELATIONS", "semanticRelations must be an object");
    return undefined;
  }
  for (const property of Object.keys(raw)) {
    if (property !== "outgoing") {
      issue(
        issues,
        `semanticRelations.${property}`,
        "UNKNOWN_PROPERTY",
        `Unsupported semanticRelations property ${property}`,
      );
    }
  }
  const outgoingInput = stringArray(issues, raw.outgoing, "semanticRelations.outgoing");
  if (!outgoingInput?.length) {
    issue(
      issues,
      "semanticRelations.outgoing",
      "SEMANTIC_RELATIONS_OUTGOING_REQUIRED",
      "semanticRelations.outgoing must contain at least one registered predicate",
    );
    return undefined;
  }
  if (outgoingInput.length > 20) {
    issue(
      issues,
      "semanticRelations.outgoing",
      "TOO_MANY_SEMANTIC_RELATIONS",
      "semanticRelations.outgoing may contain at most 20 predicates",
    );
  }
  const outgoing: SemanticRelationPredicate[] = [];
  for (const predicate of outgoingInput) {
    if (!isSemanticRelationPredicate(predicate)) {
      issue(
        issues,
        "semanticRelations.outgoing",
        "UNKNOWN_SEMANTIC_RELATION_PREDICATE",
        `${predicate} is not registered by LifeSpace`,
      );
      continue;
    }
    if (MODEL_KEY.test(modelKey) && !semanticRelationAllowsSource(predicate, modelKey)) {
      issue(
        issues,
        "semanticRelations.outgoing",
        "SEMANTIC_RELATION_SOURCE_NOT_ALLOWED",
        `${predicate} is not registered for source model ${modelKey}`,
      );
      continue;
    }
    outgoing.push(predicate);
  }
  return outgoing.length ? { outgoing } : undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function canonicalModelDefinition(definition: ModelDefinition): string {
  return JSON.stringify(canonicalize(definition));
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function validDefault(field: FieldDefinition, value: unknown): value is ModelDefaultValue {
  if (["recurrence_rule", "entity_ref"].includes(field.type) || field.type === "temporal_range" || isFirstClassRangeFieldType(field.type)) return false;
  if (value === null) return field.nullable === true;

  if (field.type === "person" || field.type === "record") return false;
  if (field.type === "person_list" || field.type === "record_list") {
    return Array.isArray(value) && value.length === 0;
  }

  if (field.type === "string" || field.type === "text") {
    if (typeof value !== "string") return false;
    const normalized = field.type === "string" ? value.trim() : value;
    return (field.minLength === undefined || normalized.length >= field.minLength)
      && (field.maxLength === undefined || normalized.length <= field.maxLength);
  }

  if (field.type === "integer" || field.type === "number") {
    return typeof value === "number"
      && Number.isFinite(value)
      && (field.type !== "integer" || Number.isInteger(value))
      && (field.minimum === undefined || value >= field.minimum)
      && (field.maximum === undefined || value <= field.maximum);
  }

  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "date") return typeof value === "string" && validDate(value);
  if (isInstantFieldType(field.type)) return isRfc3339Instant(value);
  if (field.type === "timezone") return typeof value === "string" && validTimezone(value);
  if (field.type === "enum") return typeof value === "string" && Boolean(field.values?.includes(value));
  return false;
}

function validateReferenceLabel(
  raw: unknown,
  fields: Record<string, FieldDefinition>,
  issues: ModelValidationIssue[],
): ReferenceLabelDefinition | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    issue(issues, "referenceLabel", "INVALID_REFERENCE_LABEL", "referenceLabel must be an object");
    return undefined;
  }

  const startIssueCount = issues.length;
  const allowed = new Set(["field", "template"]);
  for (const property of Object.keys(raw)) {
    if (!allowed.has(property)) {
      issue(issues, `referenceLabel.${property}`, "UNKNOWN_PROPERTY", `Unsupported referenceLabel property ${property}`);
    }
  }

  const hasField = Object.prototype.hasOwnProperty.call(raw, "field");
  const hasTemplate = Object.prototype.hasOwnProperty.call(raw, "template");
  if (hasField === hasTemplate) {
    issue(
      issues,
      "referenceLabel",
      "INVALID_REFERENCE_LABEL",
      "referenceLabel must contain exactly one of field or template",
    );
    return undefined;
  }

  if (hasField) {
    const fieldKey = typeof raw.field === "string" ? raw.field : "";
    if (!FIELD_KEY.test(fieldKey)) {
      issue(issues, "referenceLabel.field", "INVALID_REFERENCE_LABEL_FIELD", "referenceLabel.field must be a valid field key");
      return undefined;
    }
    const field = fields[fieldKey];
    if (!field) {
      issue(issues, "referenceLabel.field", "UNKNOWN_REFERENCE_LABEL_FIELD", `${fieldKey} is not a declared field`);
    } else if (!REFERENCE_LABEL_FIELD_TYPES.has(field.type)) {
      issue(
        issues,
        "referenceLabel.field",
        "INVALID_REFERENCE_LABEL_FIELD_TYPE",
        "referenceLabel may reference only scalar fields",
      );
    }
    return issues.length === startIssueCount ? { field: fieldKey } : undefined;
  }

  const template = typeof raw.template === "string" ? raw.template.trim() : "";
  if (!template || template.length > REFERENCE_LABEL_TEMPLATE_MAX_LENGTH) {
    issue(
      issues,
      "referenceLabel.template",
      "INVALID_REFERENCE_LABEL_TEMPLATE",
      `referenceLabel.template must contain 1-${REFERENCE_LABEL_TEMPLATE_MAX_LENGTH} characters`,
    );
    return undefined;
  }
  const parsed = parseReferenceLabelTemplate(template);
  if (!parsed) {
    issue(
      issues,
      "referenceLabel.template",
      "INVALID_REFERENCE_LABEL_TEMPLATE",
      "referenceLabel.template must use only simple {field} placeholders and at most 8 placeholders",
    );
    return undefined;
  }
  for (const fieldKey of parsed.fields) {
    const field = fields[fieldKey];
    if (!field) {
      issue(
        issues,
        "referenceLabel.template",
        "UNKNOWN_REFERENCE_LABEL_FIELD",
        `${fieldKey} is not a declared field`,
      );
    } else if (!REFERENCE_LABEL_FIELD_TYPES.has(field.type)) {
      issue(
        issues,
        "referenceLabel.template",
        "INVALID_REFERENCE_LABEL_FIELD_TYPE",
        `${fieldKey} is not a scalar field and cannot be used in a reference label`,
      );
    }
  }
  return issues.length === startIssueCount ? { template } : undefined;
}

export function validateModelDefinition(input: unknown): ModelValidationResult {
  const issues: ModelValidationIssue[] = [];
  if (!isObject(input)) {
    return {
      valid: false,
      issues: [{ path: "$", code: "INVALID_DEFINITION", message: "Model definition must be an object" }],
    };
  }

  const allowedTopLevel = new Set([
    "definitionVersion",
    "origin",
    "key",
    "description",
    "display",
    "fields",
    "semanticRelations",
    "timeRanges",
    "referenceLabel",
    "defaults",
    "query",
    "access",
    "lifecycle",
    "capabilities",
    "policies",
    "actions",
  ]);
  for (const property of Object.keys(input)) {
    if (!allowedTopLevel.has(property)) {
      issue(issues, property, "UNKNOWN_PROPERTY", `Unsupported model property ${property}`);
    }
  }

  if (input.definitionVersion !== MODEL_DEFINITION_VERSION) {
    issue(
      issues,
      "definitionVersion",
      "UNSUPPORTED_DEFINITION_VERSION",
      `definitionVersion must be ${MODEL_DEFINITION_VERSION}`,
    );
  }

  const key = typeof input.key === "string" ? input.key : "";
  if (!MODEL_KEY.test(key)) {
    issue(issues, "key", "INVALID_MODEL_KEY", "key must match /^[a-z][a-z0-9_]{1,62}$/");
  }
  const semanticRelations = validateSemanticRelations(input.semanticRelations, key, issues);
  if (input.origin !== undefined && input.origin !== "native" && input.origin !== "external") issue(issues, "origin", "INVALID_MODEL_ORIGIN", "origin must be native or external");

  const description = boundedText(issues, input.description, "description", 500);

  const display = isObject(input.display) ? input.display : {};
  for (const property of Object.keys(display)) {
    if (property !== "singular" && property !== "plural") {
      issue(issues, `display.${property}`, "UNKNOWN_PROPERTY", `Unsupported display property ${property}`);
    }
  }
  const singular = typeof display.singular === "string" ? display.singular.trim() : "";
  const plural = typeof display.plural === "string" ? display.plural.trim() : "";
  if (!singular || singular.length > 80) {
    issue(
      issues,
      "display.singular",
      "INVALID_DISPLAY_NAME",
      "display.singular must contain 1-80 characters",
    );
  }
  if (!plural || plural.length > 80) {
    issue(
      issues,
      "display.plural",
      "INVALID_DISPLAY_NAME",
      "display.plural must contain 1-80 characters",
    );
  }

  const fieldsInput = isObject(input.fields) ? input.fields : null;
  if (input.origin === "external") {
    if (!fieldsInput || Object.keys(fieldsInput).length) issue(issues, "fields", "EXTERNAL_FIELDS_PROVIDER_OWNED", "External definitions require fields: {}; provider schema is discovered per Space binding");
    for (const property of ["defaults", "query", "lifecycle", "capabilities", "policies", "actions", "timeRanges", "referenceLabel"]) {
      if (input[property] !== undefined) issue(issues, property, "EXTERNAL_NATIVE_SEMANTICS_UNSUPPORTED", "External definitions do not inherit Native runtime semantics");
    }
    const access = input.access;
    if (!Array.isArray(access) || !access.length || access.some(value => value !== "read" && value !== "write") || new Set(access).size !== access.length) issue(issues, "access", "INVALID_ACCESS", "External access must contain unique read/write values");
    if (issues.length) return { valid: false, issues };
    const definition: ModelDefinition = { definitionVersion: MODEL_DEFINITION_VERSION, origin: "external", key, ...(description ? { description } : {}), display: { singular, plural }, fields: {}, access: access as ModelAccess[], ...(semanticRelations ? { semanticRelations } : {}) };
    return { valid: true, definition, hashInput: canonicalModelDefinition(definition) };
  }
  if (!fieldsInput || Object.keys(fieldsInput).length === 0) {
    issue(issues, "fields", "FIELDS_REQUIRED", "At least one field is required");
  }
  const fields: Record<string, FieldDefinition> = {};

  if (fieldsInput) {
    if (Object.keys(fieldsInput).length > 100) {
      issue(issues, "fields", "TOO_MANY_FIELDS", "A model may define at most 100 fields");
    }

    for (const [fieldKey, raw] of Object.entries(fieldsInput)) {
      const path = `fields.${fieldKey}`;
      if (!FIELD_KEY.test(fieldKey)) {
        issue(issues, path, "INVALID_FIELD_KEY", `${fieldKey} is not a valid field key`);
      }
      if (RESERVED_FIELDS.has(fieldKey)) {
        issue(issues, path, "RESERVED_FIELD", `${fieldKey} is managed by the Generic Runtime`);
      }
      if (!isObject(raw)) {
        issue(issues, path, "INVALID_FIELD", `${path} must be an object`);
        continue;
      }

      const allowed = new Set([
        "type",
        "title",
        "description",
        "required",
        "nullable",
        "immutable",
        "readOnly",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "values",
        "targetModel",
      ]);
      for (const property of Object.keys(raw)) {
        if (!allowed.has(property)) {
          issue(
            issues,
            `${path}.${property}`,
            "UNKNOWN_PROPERTY",
            `Unsupported field property ${property}`,
          );
        }
      }

      const type = typeof raw.type === "string" ? raw.type : "";
      if (!FIELD_TYPE_SET.has(type)) {
        issue(
          issues,
          `${path}.type`,
          "UNSUPPORTED_FIELD_TYPE",
          `Unsupported field type ${type || "<missing>"}`,
        );
        continue;
      }

      const fieldTitle = boundedText(issues, raw.title, `${path}.title`, 80);
      const fieldDescription = boundedText(issues, raw.description, `${path}.description`, 300);
      const required = raw.required === undefined ? undefined : raw.required === true;
      const nullable = raw.nullable === undefined ? undefined : raw.nullable === true;
      const immutable = raw.immutable === undefined ? undefined : raw.immutable === true;
      const readOnly = raw.readOnly === undefined ? undefined : raw.readOnly === true;

      for (const [name, value] of [
        ["required", raw.required],
        ["nullable", raw.nullable],
        ["immutable", raw.immutable],
        ["readOnly", raw.readOnly],
      ] as const) {
        if (value !== undefined && typeof value !== "boolean") {
          issue(issues, `${path}.${name}`, "INVALID_BOOLEAN", `${path}.${name} must be boolean`);
        }
      }
      if (required && nullable) {
        issue(
          issues,
          path,
          "CONTRADICTORY_NULLABILITY",
          "A required field cannot also be nullable in Model Definition v1",
        );
      }

      const minLength = integerConstraint(issues, raw.minLength, `${path}.minLength`, 0);
      const maxLength = integerConstraint(issues, raw.maxLength, `${path}.maxLength`, 1);
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        issue(issues, path, "INVALID_RANGE", "minLength cannot exceed maxLength");
      }
      if ((minLength !== undefined || maxLength !== undefined) && type !== "string" && type !== "text") {
        issue(
          issues,
          path,
          "INVALID_CONSTRAINT",
          "Length constraints apply only to string/text fields",
        );
      }

      const minimum = typeof raw.minimum === "number" && Number.isFinite(raw.minimum)
        ? raw.minimum
        : undefined;
      const maximum = typeof raw.maximum === "number" && Number.isFinite(raw.maximum)
        ? raw.maximum
        : undefined;
      if (raw.minimum !== undefined && minimum === undefined) {
        issue(issues, `${path}.minimum`, "INVALID_CONSTRAINT", "minimum must be a finite number");
      }
      if (raw.maximum !== undefined && maximum === undefined) {
        issue(issues, `${path}.maximum`, "INVALID_CONSTRAINT", "maximum must be a finite number");
      }
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
        issue(issues, path, "INVALID_RANGE", "minimum cannot exceed maximum");
      }
      if ((minimum !== undefined || maximum !== undefined) && type !== "integer" && type !== "number") {
        issue(
          issues,
          path,
          "INVALID_CONSTRAINT",
          "Numeric constraints apply only to integer/number fields",
        );
      }

      const values = stringArray(issues, raw.values, `${path}.values`);
      if (type === "enum") {
        if (!values?.length) {
          issue(issues, `${path}.values`, "ENUM_VALUES_REQUIRED", "enum fields require values");
        }
        if (values && values.length > 50) {
          issue(
            issues,
            `${path}.values`,
            "TOO_MANY_ENUM_VALUES",
            "enum fields may contain at most 50 values",
          );
        }
      } else if (values !== undefined) {
        issue(issues, `${path}.values`, "INVALID_CONSTRAINT", "values is only valid for enum fields");
      }

      const targetModel = typeof raw.targetModel === "string" ? raw.targetModel : undefined;
      const recordRelation = type === "record" || type === "record_list";
      if (recordRelation && (!targetModel || !MODEL_KEY.test(targetModel))) {
        issue(
          issues,
          `${path}.targetModel`,
          "TARGET_MODEL_REQUIRED",
          "record relations require a valid targetModel key",
        );
      }
      if (!recordRelation && raw.targetModel !== undefined) {
        issue(
          issues,
          `${path}.targetModel`,
          "INVALID_CONSTRAINT",
          "targetModel is only valid for record relations",
        );
      }

      fields[fieldKey] = {
        type: type as FieldType,
        ...(fieldTitle ? { title: fieldTitle } : {}),
        ...(fieldDescription ? { description: fieldDescription } : {}),
        ...(required === undefined ? {} : { required }),
        ...(nullable === undefined ? {} : { nullable }),
        ...(immutable === undefined ? {} : { immutable }),
        ...(readOnly === undefined ? {} : { readOnly }),
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
        ...(values === undefined ? {} : { values }),
        ...(targetModel === undefined ? {} : { targetModel }),
      };
    }
  }

  const timeRangeResult = validateTimeRanges(input.timeRanges, fields);
  issues.push(...timeRangeResult.issues);
  const referenceLabel = validateReferenceLabel(input.referenceLabel, fields, issues);

  const defaultsInput = input.defaults === undefined
    ? undefined
    : isObject(input.defaults)
      ? input.defaults
      : null;
  if (input.defaults !== undefined && !defaultsInput) {
    issue(issues, "defaults", "INVALID_DEFAULTS", "defaults must be an object");
  }
  const defaults: Record<string, ModelDefaultValue> = {};
  if (defaultsInput) {
    for (const [fieldKey, value] of Object.entries(defaultsInput)) {
      const field = fields[fieldKey];
      if (!field) {
        issue(
          issues,
          `defaults.${fieldKey}`,
          "UNKNOWN_DEFAULT_FIELD",
          `${fieldKey} is not a declared field`,
        );
        continue;
      }
      if (!validDefault(field, value)) {
        issue(
          issues,
          `defaults.${fieldKey}`,
          "INVALID_DEFAULT",
          `Default for ${fieldKey} does not satisfy the declared field type/constraints`,
        );
        continue;
      }
      defaults[fieldKey] = structuredClone(value);
    }
  }

  const accessInput = stringArray(issues, input.access, "access") ?? [];
  if (accessInput.length === 0) {
    issue(issues, "access", "ACCESS_REQUIRED", "At least one access capability is required");
  }
  for (const value of accessInput) {
    if (!ACCESS_SET.has(value)) {
      issue(issues, "access", "UNSUPPORTED_ACCESS", `Unsupported access capability ${value}`);
    }
  }
  if (accessInput.includes("write") && !accessInput.includes("read")) {
    issue(issues, "access", "INVALID_ACCESS", "write requires read");
  }
  if (accessInput.includes("manage") && !accessInput.includes("write")) {
    issue(issues, "access", "INVALID_ACCESS", "manage requires write");
  }

  const queryInput = input.query === undefined
    ? undefined
    : isObject(input.query)
      ? input.query
      : null;
  if (input.query !== undefined && !queryInput) {
    issue(issues, "query", "INVALID_QUERY", "query must be an object");
  }
  const query: QueryDefinition | undefined = queryInput
    ? {
        searchable: stringArray(issues, queryInput.searchable, "query.searchable"),
        filterable: stringArray(issues, queryInput.filterable, "query.filterable"),
        sortable: stringArray(issues, queryInput.sortable, "query.sortable"),
      }
    : undefined;
  if (query) {
    for (const [kind, fieldKeys] of Object.entries(query)) {
      for (const fieldKey of fieldKeys ?? []) {
        const field = fields[fieldKey];
        if (field && ["recurrence_rule", "entity_ref"].includes(field.type)) {
          issue(issues, `query.${kind}`, "UNSUPPORTED_QUERY_FIELD_TYPE", "Structured recurrence and entity reference fields have no scalar query ordering");
        } else if (!field) {
          issue(issues, `query.${kind}`, "UNKNOWN_QUERY_FIELD", `${fieldKey} is not a declared field`);
        } else if ((field.type === "temporal_range" || isFirstClassRangeFieldType(field.type)) && kind === "searchable") {
          issue(
            issues,
            `query.${kind}`,
            "UNSUPPORTED_QUERY_FIELD_TYPE",
            "Range-valued fields have no text-search projection",
          );
        } else if (isFirstClassRangeFieldType(field.type) && kind === "sortable") {
          issue(
            issues,
            `query.${kind}`,
            "UNSUPPORTED_QUERY_FIELD_TYPE",
            "range<date> and range<instant> do not define a canonical sort ordering; use them as filterable fields",
          );
        }
      }
    }
  }

  const lifecycleInput = input.lifecycle === undefined
    ? undefined
    : isObject(input.lifecycle)
      ? input.lifecycle
      : null;
  if (input.lifecycle !== undefined && !lifecycleInput) {
    issue(issues, "lifecycle", "INVALID_LIFECYCLE", "lifecycle must be an object");
  }
  const lifecycle = lifecycleInput
    ? {
        ...(lifecycleInput.optimisticConcurrency === true ? { optimisticConcurrency: true as const } : {}),
        ...(lifecycleInput.softDelete === true ? { softDelete: true as const } : {}),
      }
    : undefined;
  if (lifecycleInput) {
    for (const property of Object.keys(lifecycleInput)) {
      if (property !== "optimisticConcurrency" && property !== "softDelete") {
        issue(
          issues,
          `lifecycle.${property}`,
          "UNKNOWN_PROPERTY",
          `Unsupported lifecycle property ${property}`,
        );
      }
    }
    for (const property of ["optimisticConcurrency", "softDelete"] as const) {
      const value = lifecycleInput[property];
      if (value !== undefined && value !== true) {
        issue(
          issues,
          `lifecycle.${property}`,
          "UNSUPPORTED_LIFECYCLE_OVERRIDE",
          `${property} is a Generic Runtime invariant and may only be true in Model Definition v1`,
        );
      }
    }
  }

  const capabilityResult = validateCapabilities(input.capabilities, fields);
  issues.push(...capabilityResult.issues);
  if (key === "task" && capabilityResult.capabilities?.recurrence) issue(issues, "capabilities.recurrence", "RECURSIVE_RECURRENCE_TARGET", "The generated Task target cannot itself be a recurring plan");
  issues.push(...validateCalendarTimeRangeCollisions(
    timeRangeResult.timeRanges,
    capabilityResult.capabilities?.calendar,
  ));

  const modelPolicies = validateModelPolicies(input.policies, fields);
  issues.push(...modelPolicies.issues);

  const workflow = validateWorkflowActions(input.actions, fields);
  issues.push(...workflow.issues);
  if (workflow.actions) {
    for (const [actionKey, action] of Object.entries(workflow.actions)) {
      if (!accessInput.includes(action.access)) {
        issue(
          issues,
          `actions.${actionKey}.access`,
          "ACTION_ACCESS_NOT_EXPOSED",
          `Action access ${action.access} is not exposed by model ${key}`,
        );
      }
    }
  }
  if (
    capabilityResult.capabilities?.temporal?.occurrences === true
    && workflow.actions?.["record-occurrence"]
  ) {
    issue(
      issues,
      "actions.record-occurrence",
      "CAPABILITY_ACTION_COLLISION",
      "record-occurrence is owned by the Temporal capability",
    );
  }

  if (issues.length) return { valid: false, issues };

  const definition: ModelDefinition = {
    definitionVersion: MODEL_DEFINITION_VERSION,
    key,
    ...(description ? { description } : {}),
    display: { singular, plural },
    fields,
    ...(semanticRelations ? { semanticRelations } : {}),
    ...(timeRangeResult.timeRanges ? { timeRanges: timeRangeResult.timeRanges } : {}),
    ...(referenceLabel ? { referenceLabel } : {}),
    ...(Object.keys(defaults).length ? { defaults } : {}),
    ...(query ? { query } : {}),
    access: accessInput as ModelAccess[],
    ...(lifecycle ? { lifecycle } : {}),
    ...(capabilityResult.capabilities ? { capabilities: capabilityResult.capabilities } : {}),
    ...(modelPolicies.policies ? { policies: modelPolicies.policies } : {}),
    ...(workflow.actions ? { actions: workflow.actions } : {}),
  };

  return {
    valid: true,
    definition,
    hashInput: canonicalModelDefinition(definition),
  };
}
