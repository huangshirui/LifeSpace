from pathlib import Path
import json


def replace(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing expected text in {path}: {old[:120]!r}")
    p.write_text(s.replace(old, new, 1))


# 1) One canonical field vocabulary and one canonical field-definition validator.
replace(
    "apps/core/src/model-definition.ts",
    '''export type CanonicalFieldType = typeof CANONICAL_FIELD_TYPES[number];
export type FieldType = typeof FIELD_TYPES[number];

export function canonicalFieldType(type: FieldType): CanonicalFieldType {
''',
    '''export type CanonicalFieldType = typeof CANONICAL_FIELD_TYPES[number];
export type FieldType = typeof FIELD_TYPES[number];
export type CanonicalFieldDefinition = Omit<FieldDefinition, "type"> & { type: CanonicalFieldType };

const CANONICAL_FIELD_TYPE_SET = new Set<string>(CANONICAL_FIELD_TYPES);
export function isCanonicalFieldType(value: unknown): value is CanonicalFieldType {
  return typeof value === "string" && CANONICAL_FIELD_TYPE_SET.has(value);
}

export function canonicalFieldType(type: FieldType): CanonicalFieldType {
''',
)
p = Path("apps/core/src/model-definition.ts")
s = p.read_text()
helper = '''

export type CanonicalFieldValidationResult =
  | { valid: true; definition: CanonicalFieldDefinition }
  | { valid: false; issues: ModelValidationIssue[] };

/**
 * Validate one field with the exact Model Definition v1 field semantics while
 * excluding legacy aliases. External adapters use this instead of maintaining
 * a second field-type/constraint validator.
 */
export function validateCanonicalFieldDefinition(input: unknown): CanonicalFieldValidationResult {
  if (!isObject(input) || !isCanonicalFieldType(input.type)) {
    return {
      valid: false,
      issues: [{
        path: "type",
        code: "UNSUPPORTED_FIELD_TYPE",
        message: `Unsupported canonical field type ${isObject(input) ? String(input.type ?? "<missing>") : "<missing>"}`,
      }],
    };
  }
  const probe = validateModelDefinition({
    definitionVersion: MODEL_DEFINITION_VERSION,
    key: "canonical_field_probe",
    display: { singular: "Canonical field probe", plural: "Canonical field probes" },
    fields: { value: input },
    access: ["read"],
  });
  if (!probe.valid) {
    const fieldIssues = probe.issues
      .filter((entry) => entry.path === "fields.value" || entry.path.startsWith("fields.value."))
      .map((entry) => ({
        ...entry,
        path: entry.path === "fields.value" ? "$" : entry.path.slice("fields.value.".length),
      }));
    return { valid: false, issues: fieldIssues.length ? fieldIssues : probe.issues };
  }
  const definition = probe.definition.fields.value;
  if (!definition || !isCanonicalFieldType(definition.type)) {
    return {
      valid: false,
      issues: [{ path: "type", code: "UNSUPPORTED_FIELD_TYPE", message: "Field must use a canonical field type" }],
    };
  }
  return { valid: true, definition: definition as CanonicalFieldDefinition };
}
'''
if "export function validateCanonicalFieldDefinition" not in s:
    p.write_text(s + helper)

# 2) Native and External Runtime share the same canonical value normalizer.
replace(
    "apps/core/src/generic-resource.ts",
    "function validateFieldValue(fieldKey: string, field: FieldDefinition, value: unknown): unknown {",
    "export function normalizeCanonicalFieldValue(fieldKey: string, field: FieldDefinition, value: unknown): unknown {",
)
replace(
    "apps/core/src/generic-resource.ts",
    "result[fieldKey] = validateFieldValue(fieldKey, field, effectiveInput[fieldKey]);",
    "result[fieldKey] = normalizeCanonicalFieldValue(fieldKey, field, effectiveInput[fieldKey]);",
)

# 3) Canonical Query operator vocabulary is exported once.
replace(
    "apps/core/src/canonical-query-contract.ts",
    '''const VALUE_OPERATORS = [
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
''',
    '''export const CANONICAL_QUERY_VALUE_OPERATORS = [
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
export const CANONICAL_QUERY_NULL_OPERATORS = ["isNull", "isNotNull"] as const;
export const CANONICAL_QUERY_OPERATORS = [
  ...CANONICAL_QUERY_VALUE_OPERATORS,
  ...CANONICAL_QUERY_NULL_OPERATORS,
] as const;
''',
)
p = Path("apps/core/src/canonical-query-contract.ts")
s = p.read_text().replace("enum: [...NULL_OPERATORS]", "enum: [...CANONICAL_QUERY_NULL_OPERATORS]")
s = s.replace("enum: [...VALUE_OPERATORS]", "enum: [...CANONICAL_QUERY_VALUE_OPERATORS]")
p.write_text(s)

# 4) Canonical query operand normalization can be reused by External Runtime.
replace(
    "apps/core/src/canonical-query.ts",
    'import type { GenericResource } from "./generic-resource";',
    'import { normalizeCanonicalFieldValue, type GenericResource } from "./generic-resource";',
)
marker = 'function projectOperand(value: RangeOperand, valueType: "date" | "instant" | "datetime", path: string): QueryRange {'
p = Path("apps/core/src/canonical-query.ts")
s = p.read_text()
helper = '''export function normalizeCanonicalQueryOperand(
  field: FieldDefinition,
  op: string,
  value: unknown,
  path = "value",
): unknown {
  if (op === "kindIs") {
    if (field.type !== "temporal_range" || (value !== "date" && value !== "instant")) {
      throw new ApiError("INVALID_QUERY", `${path} must be date or instant for kindIs`, 400);
    }
    return value;
  }
  if (op === "within") {
    if (field.type !== "date" && field.type !== "instant" && field.type !== "datetime") {
      throw new ApiError("INVALID_QUERY", `${path} uses within only with date/instant fields`, 400);
    }
    return parseRangeOperand(value, path);
  }
  if (
    ["overlaps", "before", "after"].includes(op)
    || (op === "contains" && (isFirstClassRangeFieldType(field.type) || field.type === "temporal_range"))
  ) {
    if (!isFirstClassRangeFieldType(field.type) && field.type !== "temporal_range") {
      throw new ApiError("INVALID_QUERY", `${path} uses a range operator with a non-range field`, 400);
    }
    return parseRangeOperand(value, path);
  }
  if (op === "contains" && ["person", "person_list", "record", "record_list"].includes(field.type)) {
    if (typeof value !== "string" || !value) throw new ApiError("INVALID_QUERY", `${path} must contain an ID`, 400);
    return value;
  }
  try {
    return normalizeCanonicalFieldValue(path, field, value);
  } catch {
    throw new ApiError("INVALID_QUERY", `${path} does not match the canonical field type`, 400);
  }
}

'''
if "export function normalizeCanonicalQueryOperand" not in s:
    if marker not in s:
        raise SystemExit("canonical query insertion marker missing")
    s = s.replace(marker, helper + marker, 1)
s = s.replace(
    'if (field.type !== "date" && field.type !== "datetime") throw new ApiError("INVALID_QUERY", `${predicate.field}.within requires date or datetime`, 400);',
    'if (field.type !== "date" && field.type !== "instant" && field.type !== "datetime") throw new ApiError("INVALID_QUERY", `${predicate.field}.within requires date or instant`, 400);',
)
p.write_text(s)

# 5) External snapshot uses CanonicalFieldDefinition, not a second type system.
replace(
    "apps/core/src/external-model.ts",
    'import type { ModelAccess } from "./model-definition";',
    'import { CANONICAL_QUERY_OPERATORS } from "./canonical-query-contract";\nimport {\n  validateCanonicalFieldDefinition,\n  type CanonicalFieldDefinition,\n  type ModelAccess,\n} from "./model-definition";',
)
replace(
    "apps/core/src/external-model.ts",
    '''export type ExternalField = {
  key: string;
  sourceFieldId: string;
  title: string;
  type: "string" | "text" | "number" | "boolean" | "enum" | "instant";
  nullable: boolean;
  readable: true;
  writable: boolean;
  operators: string[];
  sortable: boolean;
  values?: string[];
};''',
    '''export type ExternalField = CanonicalFieldDefinition & {
  key: string;
  sourceFieldId: string;
  title: string;
  nullable: boolean;
  readable: true;
  writable: boolean;
  operators: string[];
  sortable: boolean;
};''',
)
p = Path("apps/core/src/external-model.ts")
s = p.read_text()
start = s.index("  const seen = new Set<string>();\n  const ids = new Set<string>();\n  for (const raw of input.fields) {")
end = s.index("  const caps = objectInput(input.capabilities);", start)
new_block = '''  const seen = new Set<string>();
  const ids = new Set<string>();
  const normalizedFields: ExternalField[] = [];
  const canonicalProperties = [
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
  ] as const;
  for (const raw of input.fields) {
    const f = objectInput(raw);
    onlyKeys(f, [
      "key",
      "sourceFieldId",
      ...canonicalProperties,
      "readable",
      "writable",
      "operators",
      "sortable",
    ]);
    if (
      typeof f.key !== "string" ||
      !/^f_[a-f0-9]{32}$/.test(f.key) ||
      seen.has(f.key)
    )
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    seen.add(f.key);
    const id = boundedString(f.sourceFieldId, "sourceFieldId");
    if (ids.has(id)) throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    ids.add(id);
    boundedString(f.title, "title", 80);
    if (
      f.readable !== true ||
      typeof f.writable !== "boolean" ||
      typeof f.sortable !== "boolean" ||
      typeof f.nullable !== "boolean"
    )
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    const canonicalRaw = Object.fromEntries(
      canonicalProperties
        .filter((property) => Object.prototype.hasOwnProperty.call(f, property))
        .map((property) => [property, f[property]]),
    );
    const canonical = validateCanonicalFieldDefinition(canonicalRaw);
    if (!canonical.valid)
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    if (canonical.definition.readOnly === true && f.writable === true)
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    if (
      !Array.isArray(f.operators) ||
      f.operators.some(
        (op) =>
          typeof op !== "string" ||
          !CANONICAL_QUERY_OPERATORS.includes(
            op as (typeof CANONICAL_QUERY_OPERATORS)[number],
          ),
      )
    )
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    if (
      canonical.definition.nullable !== true &&
      f.operators.some((op) => op === "isNull" || op === "isNotNull")
    )
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    normalizedFields.push({
      ...canonical.definition,
      key: f.key,
      sourceFieldId: id,
      title: canonical.definition.title ?? String(f.title),
      nullable: canonical.definition.nullable === true,
      readable: true,
      writable: f.writable,
      operators: [...f.operators] as string[],
      sortable: f.sortable,
    });
  }
'''
s = s[:start] + new_block + s[end:]
s = s.replace(
    "  return input as unknown as ExternalSnapshot;\n}",
    "  return { ...input, fields: normalizedFields } as unknown as ExternalSnapshot;\n}",
    1,
)
p.write_text(s)

# 6) External Runtime reuses canonical value/query normalization and field constraints.
replace(
    "apps/core/src/external-runtime.ts",
    'import { ApiError, success } from "./http";',
    'import { ApiError, success } from "./http";\nimport { normalizeCanonicalQueryOperand } from "./canonical-query";\nimport { normalizeCanonicalFieldValue } from "./generic-resource";',
)
p = Path("apps/core/src/external-runtime.ts")
s = p.read_text()
s = s.replace(
    "    relationTargetResolution: read && Boolean(m.businessDefinition) && m.snapshot.capabilities.get,",
    '''    relationTargetResolution:
      read &&
      Boolean(m.businessDefinition) &&
      m.snapshot.capabilities.get &&
      m.snapshot.capabilities.relationTargetResolution,''',
)
start = s.index("function typedValue(field: ExternalField, value: unknown) {")
end = s.index("function validateQuery(m: ExternalModel, input: Record<string, unknown>) {", start)
new_block = '''function canonicalExternalValue(field: ExternalField, value: unknown): unknown {
  try {
    return normalizeCanonicalFieldValue(field.key, field, value);
  } catch {
    throw new ApiError(
      "VALIDATION_ERROR",
      "Value does not match current canonical External schema",
      422,
    );
  }
}
function validateData(
  m: ExternalModel,
  input: Record<string, unknown>,
  operation: "create" | "update",
): Record<string, unknown> {
  if (canonicalExternalJson(input).length > 128000)
    throw new ApiError("INVALID_REQUEST", "External input is too large", 400);
  if (operation === "create") {
    const missing = m.snapshot.fields.find(
      (field) =>
        field.required === true &&
        field.readOnly !== true &&
        !Object.prototype.hasOwnProperty.call(input, field.key),
    );
    if (missing)
      throw new ApiError(
        "VALIDATION_ERROR",
        `Required field ${missing.key} is missing`,
        422,
      );
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = m.snapshot.fields.find((candidate) => candidate.key === key);
    if (!field?.writable || field.readOnly === true)
      throw new ApiError(
        "VALIDATION_ERROR",
        "Field is unavailable or read-only",
        422,
      );
    if (operation === "update" && field.immutable === true)
      throw new ApiError(
        "VALIDATION_ERROR",
        `Field ${field.key} is immutable`,
        422,
      );
    normalized[key] = canonicalExternalValue(field, value);
  }
  return normalized;
}
'''
s = s[:start] + new_block + s[end:]
s = s.replace(
    "      typedValue(field, f.value);",
    '''      try {
        normalizeCanonicalQueryOperand(
          field,
          String(f.op),
          f.value,
          `${field.key}.value`,
        );
      } catch {
        throw new ApiError(
          "INVALID_QUERY",
          "Query value does not match the canonical field/operator semantics",
          422,
        );
      }''',
)
old = '''  for (const [key, value] of Object.entries(data)) {
    const f = m.snapshot.fields.find((x) => x.key === key);
    if (!f) throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    typedValue(f, value);
  }
  if (m.snapshot.fields.some((f) => !(f.key in data)))
    throw new ExternalError("EXTERNAL_SCHEMA_CHANGED", 409);
  return {
    id: r.id,
    spaceId: m.space_id,
    modelKey: externalBusinessKey(m),
    origin: "external",
    schemaHash: m.schema_hash,
    ...data,
'''
new = '''  const normalizedData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const field = m.snapshot.fields.find((candidate) => candidate.key === key);
    if (!field) throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    try {
      normalizedData[key] = normalizeCanonicalFieldValue(field.key, field, value);
    } catch {
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    }
  }
  if (m.snapshot.fields.some((field) => !(field.key in data)))
    throw new ExternalError("EXTERNAL_SCHEMA_CHANGED", 409);
  return {
    id: r.id,
    spaceId: m.space_id,
    modelKey: externalBusinessKey(m),
    origin: "external",
    schemaHash: m.schema_hash,
    ...normalizedData,
'''
if old not in s:
    raise SystemExit("externalRecordDto block missing")
s = s.replace(old, new, 1)
s = s.replace(
    '''      if (operation === "create" || operation === "update")
        validateData(m, input);
      if (operation !== "query") return input;''',
    '''      if (operation === "create" || operation === "update")
        return validateData(m, input, operation);
      if (operation !== "query") return input;''',
)
p.write_text(s)

# 7) Public External contract exposes the whole Canonical Field Language.
api_path = Path("apps/core/external-model.openapi.yaml")
api = json.loads(api_path.read_text())
api["info"]["version"] = "0.4.0"
api["info"]["description"] = (
    "Provider-neutral External Model binding and dynamic Generic Runtime contract. "
    "External fields use the same LifeSpace Canonical Field Language as Native models; "
    "provider adapters expose only the canonical types/capabilities they can map without loss. "
    "Connection creation and provider credential ownership are defined by external-connection.openapi.yaml. "
    "Provider business data remains external. No transaction/version/distributed atomicity guarantee is introduced."
)
canonical_types = [
    "string", "text", "integer", "number", "boolean", "date", "instant",
    "range<date>", "range<instant>", "temporal_range", "recurrence_rule",
    "entity_ref", "timezone", "enum", "person", "person_list", "record", "record_list",
]
operators = [
    "eq", "ne", "lt", "lte", "gt", "gte", "within", "contains",
    "overlaps", "before", "after", "kindIs", "isNull", "isNotNull",
]
field = api["components"]["schemas"]["ExternalField"]
field["properties"]["type"] = {
    "type": "string",
    "enum": canonical_types,
    "description": "LifeSpace CanonicalFieldType; External does not define a second field-type vocabulary.",
}
field["properties"]["description"] = {"type": "string", "maxLength": 300}
field["properties"]["required"] = {"type": "boolean"}
field["properties"]["immutable"] = {"type": "boolean"}
field["properties"]["readOnly"] = {"type": "boolean"}
field["properties"]["minLength"] = {"type": "integer", "minimum": 0}
field["properties"]["maxLength"] = {"type": "integer", "minimum": 1}
field["properties"]["minimum"] = {"type": "number"}
field["properties"]["maximum"] = {"type": "number"}
field["properties"]["targetModel"] = {"type": "string"}
field["properties"]["operators"] = {
    "type": "array",
    "items": {"type": "string", "enum": operators},
}
field["properties"]["values"] = {
    "type": "array",
    "maxItems": 50,
    "items": {"type": "string"},
}
api["components"]["schemas"]["DynamicRecord"]["additionalProperties"] = True
api["components"]["schemas"]["DynamicRecord"]["description"] = (
    "Flattened dynamic field values are validated against the current Canonical Field Definition "
    "in the Space-local External snapshot. No Native version or audit fields are fabricated."
)
api["components"]["schemas"]["ExternalWriteData"]["additionalProperties"] = True
predicate = api["components"]["schemas"].get("ExternalFilterPredicate")
if predicate and isinstance(predicate, dict):
    props = predicate.get("properties", {})
    if "value" in props:
        props["value"] = {
            "description": "Canonical Query operand shape is determined by the selected canonical field type and advertised operator."
        }
api_path.write_text(json.dumps(api, ensure_ascii=False, indent=2) + "\n")

# 8) Contract guard: External type enum must equal the canonical source of truth.
p = Path("apps/core/scripts/check-external-model-contract.mjs")
s = p.read_text().replace(
    'assert.equal(api.info.version, "0.3.0");',
    'assert.equal(api.info.version, "0.4.0");',
)
anchor = 'assert(!api.components.schemas.DynamicRecord.properties.version);\n'
guard = '''const modelDefinition = readFileSync(new URL("src/model-definition.ts", root), "utf8");
const canonicalTypeBlock = modelDefinition.match(/export const CANONICAL_FIELD_TYPES = \\[([\\s\\S]*?)\\] as const;/u);
assert(canonicalTypeBlock, "CANONICAL_FIELD_TYPES source block is required");
const canonicalTypes = [...canonicalTypeBlock[1].matchAll(/"([^"\\n]+)"/gu)].map((match) => match[1]);
assert.deepEqual(api.components.schemas.ExternalField.properties.type.enum, canonicalTypes);
const externalRuntime = readFileSync(new URL("src/external-runtime.ts", root), "utf8");
assert(externalRuntime.includes("normalizeCanonicalFieldValue"));
assert(!externalRuntime.includes("function typedValue("));
const externalModel = readFileSync(new URL("src/external-model.ts", root), "utf8");
assert(externalModel.includes("CanonicalFieldDefinition"));
assert(externalModel.includes("validateCanonicalFieldDefinition"));
'''
if guard not in s:
    s = s.replace(anchor, anchor + guard, 1)
p.write_text(s)

# 9) Repository contract version declaration.
replace(
    "apps/core/AGENTS.md",
    "current External Model version: 0.3.0",
    "current External Model version: 0.4.0",
)

# 10) Regression tests: every canonical type is valid for External; legacy-only alias is not.
Path("apps/core/test/external-canonical-field-language.test.ts").write_text(r'''import { describe, expect, it } from "vitest";
import { CANONICAL_FIELD_TYPES } from "../src/model-definition";
import { validateExternalSnapshot } from "../src/external-model";

const baseSnapshot = (type: string) => ({
  resourceId: "synthetic_resource",
  displayName: "Synthetic canonical fields",
  fields: [{
    key: `f_${"a".repeat(32)}`,
    sourceFieldId: "provider_field_1",
    title: "Value",
    type,
    nullable: false,
    readable: true,
    writable: true,
    operators: [],
    sortable: false,
    ...(type === "enum" ? { values: ["a", "b"] } : {}),
    ...(type === "record" || type === "record_list" ? { targetModel: "task" } : {}),
  }],
  capabilities: {
    get: true,
    query: true,
    create: true,
    update: true,
    delete: true,
    batchWrite: true,
    atomicBatch: false,
    transaction: false,
    versionedWrite: false,
    actions: false,
    relationTargetResolution: false,
  },
  queryLimits: { maxDepth: 2, maxNodes: 100, maxSort: 8, maxPageSize: 100 },
  adapterState: {},
});

describe("External Canonical Field Language", () => {
  it("accepts every current CanonicalFieldType without an External-specific whitelist", () => {
    for (const type of CANONICAL_FIELD_TYPES) {
      expect(validateExternalSnapshot(baseSnapshot(type)).fields[0]?.type).toBe(type);
    }
  });

  it("rejects the legacy Native datetime alias because External speaks canonical types only", () => {
    expect(() => validateExternalSnapshot(baseSnapshot("datetime"))).toThrow();
  });

  it("uses the canonical enum bound rather than a separate External bound", () => {
    const snapshot = baseSnapshot("enum");
    snapshot.fields[0]!.values = Array.from({ length: 51 }, (_, index) => `v${index}`);
    expect(() => validateExternalSnapshot(snapshot)).toThrow();
  });
});
''')
