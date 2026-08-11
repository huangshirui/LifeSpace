import type { FieldDefinition, ModelAccess, ModelValidationIssue } from "./model-definition";

export const WORKFLOW_REFERENCES = ["now", "actor.id", "actor.type"] as const;
export type WorkflowReferenceName = typeof WORKFLOW_REFERENCES[number];
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

export type WorkflowActionDefinition = {
  access: Extract<ModelAccess, "write" | "manage">;
  guards?: WorkflowGuardDefinition[];
  set: Record<string, WorkflowAssignmentValue>;
};

export type WorkflowActionsDefinition = Record<string, WorkflowActionDefinition>;

const ACTION_KEY = /^[a-z][a-z0-9-]{1,62}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const WORKFLOW_REFERENCE_SET = new Set<string>(WORKFLOW_REFERENCES);
const ACTION_ACCESS = new Set<string>(["write", "manage"]);
const GUARD_OPERATORS = new Set<string>(["eq", "neq"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(issues: ModelValidationIssue[], path: string, code: string, message: string) {
  issues.push({ path, code, message });
}

function literalCompatible(field: FieldDefinition, value: WorkflowLiteral): boolean {
  if (value === null) return field.nullable === true;
  switch (field.type) {
    case "string":
    case "text":
    case "date":
    case "datetime":
    case "timezone":
    case "person":
    case "record":
      return typeof value === "string";
    case "enum":
      return typeof value === "string" && Boolean(field.values?.includes(value));
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "person_list":
    case "record_list":
      return false;
  }
}

function assignmentReference(value: unknown): WorkflowReference | null {
  if (!isObject(value) || Object.keys(value).length !== 1 || typeof value.$ref !== "string" || !WORKFLOW_REFERENCE_SET.has(value.$ref)) return null;
  return { $ref: value.$ref as WorkflowReferenceName };
}

function referenceCompatible(field: FieldDefinition, reference: WorkflowReferenceName): boolean {
  if (reference === "now") return field.type === "datetime";
  if (reference === "actor.id") return field.type === "string" || field.type === "text";
  if (reference === "actor.type") {
    return field.type === "enum"
      && ["user", "service", "device"].every((value) => field.values?.includes(value));
  }
  return false;
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
      if (!["access", "guards", "set"].includes(property)) issue(issues, `${path}.${property}`, "UNKNOWN_PROPERTY", `Unsupported action property ${property}`);
    }

    const access = typeof rawAction.access === "string" ? rawAction.access : "";
    if (!ACTION_ACCESS.has(access)) issue(issues, `${path}.access`, "INVALID_ACTION_ACCESS", "Workflow actions require write or manage access");

    const guards: WorkflowGuardDefinition[] = [];
    if (rawAction.guards !== undefined) {
      if (!Array.isArray(rawAction.guards)) {
        issue(issues, `${path}.guards`, "INVALID_GUARDS", "guards must be an array");
      } else {
        if (rawAction.guards.length > 20) issue(issues, `${path}.guards`, "TOO_MANY_GUARDS", "An action may define at most 20 guards");
        rawAction.guards.forEach((rawGuard, index) => {
          const guardPath = `${path}.guards.${index}`;
          if (!isObject(rawGuard)) {
            issue(issues, guardPath, "INVALID_GUARD", `${guardPath} must be an object`);
            return;
          }
          for (const property of Object.keys(rawGuard)) {
            if (!["field", "op", "value", "errorCode", "message"].includes(property)) issue(issues, `${guardPath}.${property}`, "UNKNOWN_PROPERTY", `Unsupported guard property ${property}`);
          }
          const fieldKey = typeof rawGuard.field === "string" ? rawGuard.field : "";
          const field = fields[fieldKey];
          if (!field) issue(issues, `${guardPath}.field`, "UNKNOWN_ACTION_FIELD", `${fieldKey || "<missing>"} is not a declared field`);
          const op = typeof rawGuard.op === "string" ? rawGuard.op : "";
          if (!GUARD_OPERATORS.has(op)) issue(issues, `${guardPath}.op`, "INVALID_GUARD_OPERATOR", "Guard operator must be eq or neq");
          const value = rawGuard.value;
          if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
            issue(issues, `${guardPath}.value`, "INVALID_GUARD_VALUE", "Guard values must be scalar literals or null");
          } else if (field && !literalCompatible(field, value as WorkflowLiteral)) {
            issue(issues, `${guardPath}.value`, "INCOMPATIBLE_GUARD_VALUE", `Guard value is incompatible with ${fieldKey}`);
          }
          const errorCode = rawGuard.errorCode === undefined ? undefined : typeof rawGuard.errorCode === "string" ? rawGuard.errorCode : "";
          if (errorCode !== undefined && !ERROR_CODE.test(errorCode)) issue(issues, `${guardPath}.errorCode`, "INVALID_ERROR_CODE", "errorCode must be an uppercase API error identifier");
          const message = rawGuard.message === undefined ? undefined : typeof rawGuard.message === "string" ? rawGuard.message.trim() : "";
          if (message !== undefined && (!message || message.length > 200)) issue(issues, `${guardPath}.message`, "INVALID_ERROR_MESSAGE", "message must contain 1-200 characters");
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

    const setInput = isObject(rawAction.set) ? rawAction.set : null;
    if (!setInput || Object.keys(setInput).length === 0) issue(issues, `${path}.set`, "ACTION_SET_REQUIRED", "An action must assign at least one field");
    if (setInput && Object.keys(setInput).length > 20) issue(issues, `${path}.set`, "TOO_MANY_ASSIGNMENTS", "An action may assign at most 20 fields");
    const set: Record<string, WorkflowAssignmentValue> = {};
    if (setInput) {
      for (const [fieldKey, rawValue] of Object.entries(setInput)) {
        const assignmentPath = `${path}.set.${fieldKey}`;
        const field = fields[fieldKey];
        if (!field) {
          issue(issues, assignmentPath, "UNKNOWN_ACTION_FIELD", `${fieldKey} is not a declared field`);
          continue;
        }
        if (field.immutable) issue(issues, assignmentPath, "IMMUTABLE_ACTION_FIELD", `Action cannot assign immutable field ${fieldKey}`);
        const reference = assignmentReference(rawValue);
        if (reference) {
          if (!referenceCompatible(field, reference.$ref)) issue(issues, assignmentPath, "INCOMPATIBLE_ACTION_REFERENCE", `${reference.$ref} is incompatible with ${fieldKey}`);
          set[fieldKey] = reference;
          continue;
        }
        if (rawValue !== null && !["string", "number", "boolean"].includes(typeof rawValue)) {
          issue(issues, assignmentPath, "INVALID_ACTION_VALUE", "Action assignments must be scalar literals, null, or a supported $ref");
          continue;
        }
        if (!literalCompatible(field, rawValue as WorkflowLiteral)) {
          issue(issues, assignmentPath, "INCOMPATIBLE_ACTION_VALUE", `Action value is incompatible with ${fieldKey}`);
          continue;
        }
        set[fieldKey] = rawValue as WorkflowLiteral;
      }
    }

    if (ACTION_KEY.test(actionKey) && ACTION_ACCESS.has(access) && setInput) {
      actions[actionKey] = {
        access: access as WorkflowActionDefinition["access"],
        ...(rawAction.guards === undefined ? {} : { guards }),
        set,
      };
    }
  }

  return { ...(Object.keys(actions).length ? { actions } : {}), issues };
}
