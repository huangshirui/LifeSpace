import type { FieldDefinition, ModelValidationIssue } from "./model-definition";

export type PolicyScalar = string | number | boolean | null;
export type PolicyReference = { $ref: string };
export type PolicyLiteral = { value: PolicyScalar };
export type PolicyOperand = PolicyReference | PolicyLiteral;

export type PolicyExpression =
  | { op: "eq" | "neq"; left: PolicyOperand; right: PolicyOperand }
  | { all: PolicyExpression[] }
  | { any: PolicyExpression[] }
  | { not: PolicyExpression };

export type ModelPoliciesDefinition = {
  create?: PolicyExpression;
  read?: PolicyExpression;
  update?: PolicyExpression;
  delete?: PolicyExpression;
};

export type PolicyValidationOptions = {
  operation: "create" | "read" | "update" | "delete" | "action";
  allowInput?: boolean;
  allowRecord?: boolean;
};

type OperandType = {
  kind: "string" | "number" | "boolean" | "null" | "unknown";
  nullable?: boolean;
};

const FIELD_REF = /^(record|input)\.([a-z][A-Za-z0-9]{0,62})$/;
const ACTOR_REFS = new Set(["actor.type", "actor.id", "actor.personId"]);
const COMPARISON_OPS = new Set(["eq", "neq"]);
const MAX_POLICY_DEPTH = 8;
const MAX_POLICY_NODES = 64;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(issues: ModelValidationIssue[], path: string, code: string, message: string) {
  issues.push({ path, code, message });
}

function fieldType(field: FieldDefinition): OperandType {
  switch (field.type) {
    case "integer":
    case "number": return { kind: "number", nullable: field.nullable };
    case "boolean": return { kind: "boolean", nullable: field.nullable };
    case "string":
    case "text":
    case "date":
    case "datetime":
    case "timezone":
    case "enum":
    case "person":
    case "record": return { kind: "string", nullable: field.nullable };
    case "person_list":
    case "record_list": return { kind: "unknown", nullable: field.nullable };
  }
}

function scalarType(value: PolicyScalar): OperandType {
  if (value === null) return { kind: "null" };
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  return { kind: "string" };
}

function referenceType(
  reference: string,
  fields: Record<string, FieldDefinition>,
  options: PolicyValidationOptions,
  issues: ModelValidationIssue[],
  path: string,
): OperandType {
  if (ACTOR_REFS.has(reference)) {
    if (reference === "actor.personId") return { kind: "string", nullable: true };
    return { kind: "string" };
  }
  const match = FIELD_REF.exec(reference);
  if (!match) {
    issue(issues, path, "INVALID_POLICY_REFERENCE", `${reference} is not a supported policy reference`);
    return { kind: "unknown" };
  }
  const [, source, fieldKey] = match;
  if (source === "record" && options.allowRecord !== true) {
    issue(issues, path, "POLICY_RECORD_REFERENCE_NOT_ALLOWED", `record references are not allowed for ${options.operation}`);
  }
  if (source === "input" && options.allowInput !== true) {
    issue(issues, path, "POLICY_INPUT_REFERENCE_NOT_ALLOWED", `input references are not allowed for ${options.operation}`);
  }
  const field = fields[fieldKey];
  if (!field) {
    issue(issues, path, "UNKNOWN_POLICY_FIELD", `${fieldKey} is not a declared field`);
    return { kind: "unknown" };
  }
  return fieldType(field);
}

function operand(
  raw: unknown,
  fields: Record<string, FieldDefinition>,
  options: PolicyValidationOptions,
  issues: ModelValidationIssue[],
  path: string,
): { value?: PolicyOperand; type: OperandType } {
  if (!isObject(raw)) {
    issue(issues, path, "INVALID_POLICY_OPERAND", "Policy operands must be {$ref: ...} or {value: ...}");
    return { type: { kind: "unknown" } };
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    issue(issues, path, "INVALID_POLICY_OPERAND", "Policy operand must contain exactly one property");
    return { type: { kind: "unknown" } };
  }
  if (typeof raw.$ref === "string") {
    return {
      value: { $ref: raw.$ref },
      type: referenceType(raw.$ref, fields, options, issues, `${path}.$ref`),
    };
  }
  if (Object.prototype.hasOwnProperty.call(raw, "value")) {
    const value = raw.value;
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      issue(issues, `${path}.value`, "INVALID_POLICY_LITERAL", "Policy literals must be string, number, boolean, or null");
      return { type: { kind: "unknown" } };
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      issue(issues, `${path}.value`, "INVALID_POLICY_LITERAL", "Policy number literals must be finite");
      return { type: { kind: "unknown" } };
    }
    return { value: { value: value as PolicyScalar }, type: scalarType(value as PolicyScalar) };
  }
  issue(issues, path, "INVALID_POLICY_OPERAND", "Policy operands support only $ref or value");
  return { type: { kind: "unknown" } };
}

function compatible(left: OperandType, right: OperandType): boolean {
  if (left.kind === "unknown" || right.kind === "unknown") return true;
  if (left.kind === "null") return right.nullable === true || right.kind === "null";
  if (right.kind === "null") return left.nullable === true;
  return left.kind === right.kind;
}

function validateExpression(
  raw: unknown,
  fields: Record<string, FieldDefinition>,
  options: PolicyValidationOptions,
  issues: ModelValidationIssue[],
  path: string,
  state: { nodes: number },
  depth: number,
): PolicyExpression | undefined {
  state.nodes += 1;
  if (state.nodes > MAX_POLICY_NODES) {
    issue(issues, path, "POLICY_TOO_COMPLEX", `Policy may contain at most ${MAX_POLICY_NODES} nodes`);
    return undefined;
  }
  if (depth > MAX_POLICY_DEPTH) {
    issue(issues, path, "POLICY_TOO_DEEP", `Policy nesting may not exceed ${MAX_POLICY_DEPTH}`);
    return undefined;
  }
  if (!isObject(raw)) {
    issue(issues, path, "INVALID_POLICY", "Policy expression must be an object");
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(raw, "op")) {
    const allowed = new Set(["op", "left", "right"]);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) issue(issues, `${path}.${key}`, "UNKNOWN_PROPERTY", `Unsupported comparison property ${key}`);
    const op = typeof raw.op === "string" ? raw.op : "";
    if (!COMPARISON_OPS.has(op)) issue(issues, `${path}.op`, "INVALID_POLICY_OPERATOR", "Policy comparison operator must be eq or neq");
    const left = operand(raw.left, fields, options, issues, `${path}.left`);
    const right = operand(raw.right, fields, options, issues, `${path}.right`);
    if (!compatible(left.type, right.type)) issue(issues, path, "INCOMPATIBLE_POLICY_OPERANDS", "Policy comparison operands are not type-compatible");
    if (COMPARISON_OPS.has(op) && left.value && right.value) return { op: op as "eq" | "neq", left: left.value, right: right.value };
    return undefined;
  }

  for (const operator of ["all", "any"] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, operator)) {
      if (Object.keys(raw).some((key) => key !== operator)) issue(issues, path, "INVALID_POLICY", `${operator} policy may not contain sibling properties`);
      const values = raw[operator];
      if (!Array.isArray(values) || values.length < 1 || values.length > 20) {
        issue(issues, `${path}.${operator}`, "INVALID_POLICY_GROUP", `${operator} must contain 1-20 policy expressions`);
        return undefined;
      }
      const children = values.map((value, index) => validateExpression(value, fields, options, issues, `${path}.${operator}.${index}`, state, depth + 1)).filter(Boolean) as PolicyExpression[];
      if (children.length === values.length) return operator === "all" ? { all: children } : { any: children };
      return undefined;
    }
  }

  if (Object.prototype.hasOwnProperty.call(raw, "not")) {
    if (Object.keys(raw).some((key) => key !== "not")) issue(issues, path, "INVALID_POLICY", "not policy may not contain sibling properties");
    const child = validateExpression(raw.not, fields, options, issues, `${path}.not`, state, depth + 1);
    return child ? { not: child } : undefined;
  }

  issue(issues, path, "INVALID_POLICY", "Policy must be a comparison, all, any, or not expression");
  return undefined;
}

export function validatePolicyExpression(
  raw: unknown,
  fields: Record<string, FieldDefinition>,
  options: PolicyValidationOptions,
  path = "policy",
): { policy?: PolicyExpression; issues: ModelValidationIssue[] } {
  const issues: ModelValidationIssue[] = [];
  const policy = validateExpression(raw, fields, options, issues, path, { nodes: 0 }, 1);
  return { ...(policy ? { policy } : {}), issues };
}

export function validateModelPolicies(
  raw: unknown,
  fields: Record<string, FieldDefinition>,
): { policies?: ModelPoliciesDefinition; issues: ModelValidationIssue[] } {
  const issues: ModelValidationIssue[] = [];
  if (raw === undefined) return { issues };
  if (!isObject(raw)) {
    issue(issues, "policies", "INVALID_POLICIES", "policies must be an object");
    return { issues };
  }
  const allowed = new Set(["create", "read", "update", "delete"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) issue(issues, `policies.${key}`, "UNKNOWN_PROPERTY", `Unsupported model policy ${key}`);
  const policies: ModelPoliciesDefinition = {};
  for (const operation of ["create", "read", "update", "delete"] as const) {
    if (raw[operation] === undefined) continue;
    const result = validatePolicyExpression(raw[operation], fields, {
      operation,
      allowInput: operation === "create" || operation === "update",
      // v1 list queries evaluate read policy once before pagination; record-aware
      // read predicates wait for the policy-aware query compiler.
      allowRecord: operation === "update" || operation === "delete",
    }, `policies.${operation}`);
    issues.push(...result.issues);
    if (result.policy) policies[operation] = result.policy;
  }
  return { ...(Object.keys(policies).length ? { policies } : {}), issues };
}
