import { ACTOR_TYPES, PRINCIPAL_TYPES } from "./env";
import type { FieldDefinition, ModelAccess, ModelValidationIssue } from "./model-definition";
import { validatePolicyExpression, type PolicyExpression } from "./policy-definition";

export const WORKFLOW_REFERENCES = [
  "now",
  "principal.id",
  "principal.type",
  "principal.personId",
  "actor.id",
  "actor.type",
  "actor.personId",
] as const;
export type FixedWorkflowReferenceName = typeof WORKFLOW_REFERENCES[number];
export type WorkflowReferenceName = FixedWorkflowReferenceName | `record.${string}`;
export type WorkflowReference = { $ref: WorkflowReferenceName };
export type WorkflowLiteral = string | number | boolean | null;
export type WorkflowAssignmentValue = WorkflowLiteral | WorkflowReference;
export type WorkflowGuardOperator = "eq" | "neq";

export type WorkflowGuardDefinition = {
  field: string;
  op: WorkflowGuardOperator;
  value: WorkflowLiteral;
  errorCode?: string;
  message?: string;
};

export type WorkflowCondition =
  | { field: string; op: WorkflowGuardOperator; value: WorkflowLiteral }
  | { personRelation: string; active: boolean }
  | { all: WorkflowCondition[] }
  | { any: WorkflowCondition[] }
  | { not: WorkflowCondition };

export type WorkflowBranchDefinition = {
  when: WorkflowCondition;
  set: Record<string, WorkflowAssignmentValue>;
};

export type WorkflowActionDefinition = {
  access: Extract<ModelAccess, "write" | "manage">;
  policy?: PolicyExpression;
  guards?: WorkflowGuardDefinition[];
  branches?: WorkflowBranchDefinition[];
  set: Record<string, WorkflowAssignmentValue>;
};

export type WorkflowActionsDefinition = Record<string, WorkflowActionDefinition>;

const ACTION_KEY = /^[a-z][a-z0-9-]{1,62}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const WORKFLOW_REFERENCE_SET = new Set<string>(WORKFLOW_REFERENCES);
const RECORD_REFERENCE = /^record\.([a-z][A-Za-z0-9]{0,62})$/;
const ACTION_ACCESS = new Set<string>(["write", "manage"]);
const GUARD_OPERATORS = new Set<string>(["eq", "neq"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(issues: ModelValidationIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

function literalCompatible(field: FieldDefinition, value: WorkflowLiteral): boolean {
  if (field.type === "temporal_range" || field.type === "range<date>" || field.type === "range<instant>") return false;
  if (value === null) return field.nullable === true;
  switch (field.type) {
    case "recurrence_rule":
    case "entity_ref": return false;
    case "string":
    case "text":
    case "date":
    case "instant":
    case "datetime":
    case "timezone":
    case "person":
    case "record":
    case "file":
      return typeof value === "string";
    case "enum":
      return typeof value === "string" && Boolean(field.values?.includes(value));
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum_list":
    case "file_list":
    case "file_ref_list":
    case "person_list":
    case "record_list":
      return false;
  }
}

function assignmentReference(
  value: unknown,
  fields: Record<string, FieldDefinition>,
): WorkflowReference | null {
  if (!isObject(value) || Object.keys(value).length !== 1 || typeof value.$ref !== "string") return null;
  if (WORKFLOW_REFERENCE_SET.has(value.$ref)) return { $ref: value.$ref as FixedWorkflowReferenceName };
  const match = RECORD_REFERENCE.exec(value.$ref);
  if (match && fields[match[1]]) return { $ref: value.$ref as `record.${string}` };
  return null;
}

function fieldTypesCompatible(target: FieldDefinition, source: FieldDefinition): boolean {
  if (target.type === source.type) return true;
  return (target.type === "string" || target.type === "text")
    && (source.type === "string" || source.type === "text");
}

function referenceCompatible(
  target: FieldDefinition,
  reference: WorkflowReferenceName,
  fields: Record<string, FieldDefinition>,
): boolean {
  if (reference === "now") return target.type === "instant" || target.type === "datetime";
  if (reference === "principal.id" || reference === "actor.id") {
    return target.type === "string" || target.type === "text";
  }
  if (reference === "principal.personId" || reference === "actor.personId") {
    return target.type === "person" || target.type === "string" || target.type === "text";
  }
  if (reference === "principal.type") {
    return target.type === "enum"
      && PRINCIPAL_TYPES.every((value) => target.values?.includes(value));
  }
  if (reference === "actor.type") {
    return target.type === "enum"
      && ACTOR_TYPES.every((value) => target.values?.includes(value));
  }
  const match = RECORD_REFERENCE.exec(reference);
  const source = match ? fields[match[1]] : undefined;
  return Boolean(source && fieldTypesCompatible(target, source));
}

function validateAssignments(
  raw: unknown,
  fields: Record<string, FieldDefinition>,
  path: string,
  issues: ModelValidationIssue[],
): Record<string, WorkflowAssignmentValue> {
  const input = isObject(raw) ? raw : null;
  if (!input || Object.keys(input).length === 0) {
    issue(issues, path, "ACTION_SET_REQUIRED", "An action/branch must assign at least one field");
    return {};
  }
  if (Object.keys(input).length > 20) {
    issue(issues, path, "TOO_MANY_ASSIGNMENTS", "An action/branch may assign at most 20 fields");
  }

  const set: Record<string, WorkflowAssignmentValue> = {};
  for (const [fieldKey, rawValue] of Object.entries(input)) {
    const assignmentPath = `${path}.${fieldKey}`;
    const field = fields[fieldKey];
    if (!field) {
      issue(issues, assignmentPath, "UNKNOWN_ACTION_FIELD", `${fieldKey} is not a declared field`);
      continue;
    }
    if (field.immutable) {
      issue(issues, assignmentPath, "IMMUTABLE_ACTION_FIELD", `Action cannot assign immutable field ${fieldKey}`);
    }

    const reference = assignmentReference(rawValue, fields);
    if (reference) {
      if (!referenceCompatible(field, reference.$ref, fields)) {
        issue(
          issues,
          assignmentPath,
          "INCOMPATIBLE_ACTION_REFERENCE",
          `${reference.$ref} is incompatible with ${fieldKey}`,
        );
      }
      set[fieldKey] = reference;
      continue;
    }
    if (isObject(rawValue) && typeof rawValue.$ref === "string") {
      issue(
        issues,
        assignmentPath,
        "INVALID_ACTION_REFERENCE",
        `${rawValue.$ref} is not a supported workflow reference`,
      );
      continue;
    }
    if (rawValue !== null && !["string", "number", "boolean"].includes(typeof rawValue)) {
      issue(
        issues,
        assignmentPath,
        "INVALID_ACTION_VALUE",
        "Action assignments must be scalar literals, null, or a supported $ref",
      );
      continue;
    }
    if (!literalCompatible(field, rawValue as WorkflowLiteral)) {
      issue(issues, assignmentPath, "INCOMPATIBLE_ACTION_VALUE", `Action value is incompatible with ${fieldKey}`);
      continue;
    }
    set[fieldKey] = rawValue as WorkflowLiteral;
  }
  return set;
}

function validateCondition(
  raw: unknown,
  fields: Record<string, FieldDefinition>,
  path: string,
  issues: ModelValidationIssue[],
  depth = 0,
  budget = { nodes: 0 },
): WorkflowCondition | null {
  budget.nodes += 1;
  if (depth > 4 || budget.nodes > 20) {
    issue(issues, path, "WORKFLOW_CONDITION_TOO_COMPLEX", "Workflow branch condition exceeds depth/node limits");
    return null;
  }
  if (!isObject(raw)) {
    issue(issues, path, "INVALID_WORKFLOW_CONDITION", "Workflow branch condition must be an object");
    return null;
  }

  const keys = Object.keys(raw);
  if (keys.includes("all") || keys.includes("any") || keys.includes("not")) {
    if (keys.length !== 1) {
      issue(issues, path, "INVALID_WORKFLOW_CONDITION", "Boolean workflow conditions accept exactly one operator");
      return null;
    }
    if ("not" in raw) {
      const child = validateCondition(raw.not, fields, `${path}.not`, issues, depth + 1, budget);
      return child ? { not: child } : null;
    }
    const operator = keys[0] as "all" | "any";
    const list = raw[operator];
    if (!Array.isArray(list) || list.length < 1 || list.length > 8) {
      issue(issues, `${path}.${operator}`, "INVALID_WORKFLOW_CONDITION", `${operator} must contain 1-8 conditions`);
      return null;
    }
    const children = list
      .map((item, index) => validateCondition(item, fields, `${path}.${operator}.${index}`, issues, depth + 1, budget))
      .filter((item): item is WorkflowCondition => Boolean(item));
    return children.length === list.length ? { [operator]: children } as WorkflowCondition : null;
  }

  if ("personRelation" in raw || "active" in raw) {
    if (keys.some((key) => key !== "personRelation" && key !== "active")) {
      issue(issues, path, "INVALID_WORKFLOW_CONDITION", "Person-relation condition accepts only personRelation and active");
      return null;
    }
    const fieldKey = typeof raw.personRelation === "string" ? raw.personRelation : "";
    const field = fields[fieldKey];
    if (!field || field.type !== "person") {
      issue(
        issues,
        `${path}.personRelation`,
        "INVALID_PERSON_RELATION_CONDITION",
        "personRelation must name a declared person field",
      );
    }
    if (typeof raw.active !== "boolean") {
      issue(issues, `${path}.active`, "INVALID_PERSON_RELATION_CONDITION", "active must be boolean");
    }
    return field?.type === "person" && typeof raw.active === "boolean"
      ? { personRelation: fieldKey, active: raw.active }
      : null;
  }

  if (keys.some((key) => !["field", "op", "value"].includes(key))) {
    issue(issues, path, "INVALID_WORKFLOW_CONDITION", "Field condition accepts only field, op, and value");
    return null;
  }
  const fieldKey = typeof raw.field === "string" ? raw.field : "";
  const field = fields[fieldKey];
  if (!field) {
    issue(issues, `${path}.field`, "UNKNOWN_ACTION_FIELD", `${fieldKey || "<missing>"} is not a declared field`);
  }
  const op = typeof raw.op === "string" ? raw.op : "";
  if (!GUARD_OPERATORS.has(op)) {
    issue(issues, `${path}.op`, "INVALID_GUARD_OPERATOR", "Condition operator must be eq or neq");
  }
  const value = raw.value;
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
    issue(issues, `${path}.value`, "INVALID_GUARD_VALUE", "Condition values must be scalar literals or null");
  } else if (field && !literalCompatible(field, value as WorkflowLiteral)) {
    issue(issues, `${path}.value`, "INCOMPATIBLE_GUARD_VALUE", `Condition value is incompatible with ${fieldKey}`);
  }
  return field
    && GUARD_OPERATORS.has(op)
    && (value === null || ["string", "number", "boolean"].includes(typeof value))
    ? { field: fieldKey, op: op as WorkflowGuardOperator, value: value as WorkflowLiteral }
    : null;
}

export function validateWorkflowActions(
  input: unknown,
  fields: Record<string, FieldDefinition>,
): { actions?: WorkflowActionsDefinition; issues: ModelValidationIssue[] } {
  const issues: ModelValidationIssue[] = [];
  if (input === undefined) return { issues };
  if (!isObject(input)) {
    issue(issues, "actions", "INVALID_ACTIONS", "actions must be an object");
    return { issues };
  }

  const entries = Object.entries(input);
  if (entries.length > 32) issue(issues, "actions", "TOO_MANY_ACTIONS", "A model may define at most 32 actions");
  const actions: WorkflowActionsDefinition = {};

  for (const [actionKey, rawAction] of entries) {
    const path = `actions.${actionKey}`;
    if (!ACTION_KEY.test(actionKey)) issue(issues, path, "INVALID_ACTION_KEY", `${actionKey} is not a valid action key`);
    if (!isObject(rawAction)) {
      issue(issues, path, "INVALID_ACTION", `${path} must be an object`);
      continue;
    }
    for (const property of Object.keys(rawAction)) {
      if (!["access", "policy", "guards", "branches", "set"].includes(property)) {
        issue(issues, `${path}.${property}`, "UNKNOWN_PROPERTY", `Unsupported action property ${property}`);
      }
    }

    const access = typeof rawAction.access === "string" ? rawAction.access : "";
    if (!ACTION_ACCESS.has(access)) {
      issue(issues, `${path}.access`, "INVALID_ACTION_ACCESS", "Workflow actions require write or manage access");
    }

    const policyResult = rawAction.policy === undefined
      ? { issues: [] as ModelValidationIssue[], policy: undefined }
      : validatePolicyExpression(
          rawAction.policy,
          fields,
          { operation: "action", allowRecord: true, allowInput: false },
          `${path}.policy`,
        );
    issues.push(...policyResult.issues);

    const guards: WorkflowGuardDefinition[] = [];
    if (rawAction.guards !== undefined) {
      if (!Array.isArray(rawAction.guards)) {
        issue(issues, `${path}.guards`, "INVALID_GUARDS", "guards must be an array");
      } else {
        if (rawAction.guards.length > 20) {
          issue(issues, `${path}.guards`, "TOO_MANY_GUARDS", "An action may define at most 20 guards");
        }
        rawAction.guards.forEach((rawGuard, index) => {
          const guardPath = `${path}.guards.${index}`;
          if (!isObject(rawGuard)) {
            issue(issues, guardPath, "INVALID_GUARD", `${guardPath} must be an object`);
            return;
          }
          for (const property of Object.keys(rawGuard)) {
            if (!["field", "op", "value", "errorCode", "message"].includes(property)) {
              issue(issues, `${guardPath}.${property}`, "UNKNOWN_PROPERTY", `Unsupported guard property ${property}`);
            }
          }
          const fieldKey = typeof rawGuard.field === "string" ? rawGuard.field : "";
          const field = fields[fieldKey];
          if (!field) {
            issue(issues, `${guardPath}.field`, "UNKNOWN_ACTION_FIELD", `${fieldKey || "<missing>"} is not a declared field`);
          }
          const op = typeof rawGuard.op === "string" ? rawGuard.op : "";
          if (!GUARD_OPERATORS.has(op)) {
            issue(issues, `${guardPath}.op`, "INVALID_GUARD_OPERATOR", "Guard operator must be eq or neq");
          }
          const value = rawGuard.value;
          if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
            issue(issues, `${guardPath}.value`, "INVALID_GUARD_VALUE", "Guard values must be scalar literals or null");
          } else if (field && !literalCompatible(field, value as WorkflowLiteral)) {
            issue(issues, `${guardPath}.value`, "INCOMPATIBLE_GUARD_VALUE", `Guard value is incompatible with ${fieldKey}`);
          }
          const errorCode = rawGuard.errorCode === undefined
            ? undefined
            : typeof rawGuard.errorCode === "string"
              ? rawGuard.errorCode
              : "";
          if (errorCode !== undefined && !ERROR_CODE.test(errorCode)) {
            issue(issues, `${guardPath}.errorCode`, "INVALID_ERROR_CODE", "errorCode must be an uppercase API error identifier");
          }
          const message = rawGuard.message === undefined
            ? undefined
            : typeof rawGuard.message === "string"
              ? rawGuard.message.trim()
              : "";
          if (message !== undefined && (!message || message.length > 200)) {
            issue(issues, `${guardPath}.message`, "INVALID_ERROR_MESSAGE", "message must contain 1-200 characters");
          }
          if (field && GUARD_OPERATORS.has(op) && (value === null || ["string", "number", "boolean"].includes(typeof value))) {
            guards.push({
              field: fieldKey,
              op: op as WorkflowGuardOperator,
              value: value as WorkflowLiteral,
              ...(errorCode ? { errorCode } : {}),
              ...(message ? { message } : {}),
            });
          }
        });
      }
    }

    const branches: WorkflowBranchDefinition[] = [];
    if (rawAction.branches !== undefined) {
      if (!Array.isArray(rawAction.branches) || rawAction.branches.length > 8) {
        issue(issues, `${path}.branches`, "INVALID_WORKFLOW_BRANCHES", "branches must be an array of at most 8 entries");
      } else {
        rawAction.branches.forEach((rawBranch, index) => {
          const branchPath = `${path}.branches.${index}`;
          if (!isObject(rawBranch)) {
            issue(issues, branchPath, "INVALID_WORKFLOW_BRANCH", "Workflow branch must be an object");
            return;
          }
          for (const property of Object.keys(rawBranch)) {
            if (property !== "when" && property !== "set") {
              issue(issues, `${branchPath}.${property}`, "UNKNOWN_PROPERTY", `Unsupported branch property ${property}`);
            }
          }
          const when = validateCondition(rawBranch.when, fields, `${branchPath}.when`, issues);
          const set = validateAssignments(rawBranch.set, fields, `${branchPath}.set`, issues);
          if (when && Object.keys(set).length) branches.push({ when, set });
        });
      }
    }

    const set = validateAssignments(rawAction.set, fields, `${path}.set`, issues);

    if (ACTION_KEY.test(actionKey) && ACTION_ACCESS.has(access) && Object.keys(set).length) {
      actions[actionKey] = {
        access: access as WorkflowActionDefinition["access"],
        ...(policyResult.policy ? { policy: policyResult.policy } : {}),
        ...(rawAction.guards === undefined ? {} : { guards }),
        ...(branches.length ? { branches } : {}),
        set,
      };
    }
  }

  return { ...(Object.keys(actions).length ? { actions } : {}), issues };
}