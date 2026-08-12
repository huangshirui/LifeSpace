import type { Bindings, Principal } from "./env";
import { getGenericResource, updateGenericResource, type GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import type { PublishedModel } from "./model-registry";
import { requirePolicyExpression, type PolicyContext, type ResolvedPolicyActor } from "./policy";
import type {
  WorkflowActionDefinition,
  WorkflowAssignmentValue,
  WorkflowCondition,
  WorkflowGuardDefinition,
} from "./workflow-definition";

function guardPasses(resource: GenericResource, guard: WorkflowGuardDefinition): boolean {
  const actual = Object.prototype.hasOwnProperty.call(resource.data, guard.field)
    ? resource.data[guard.field]
    : null;
  return guard.op === "eq" ? actual === guard.value : actual !== guard.value;
}

async function activePersonRelation(
  env: Bindings,
  spaceId: string,
  resource: GenericResource,
  field: string,
): Promise<boolean> {
  const value = resource.data[field];
  if (typeof value !== "string" || !value) return false;
  const row = await env.DB.prepare(`SELECT id FROM space_people
    WHERE id=? AND space_id=? AND deleted_at IS NULL LIMIT 1`)
    .bind(value, spaceId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function conditionPasses(
  env: Bindings,
  spaceId: string,
  resource: GenericResource,
  condition: WorkflowCondition,
): Promise<boolean> {
  if ("field" in condition) {
    const actual = Object.prototype.hasOwnProperty.call(resource.data, condition.field)
      ? resource.data[condition.field]
      : null;
    return condition.op === "eq" ? actual === condition.value : actual !== condition.value;
  }
  if ("personRelation" in condition) {
    return (await activePersonRelation(env, spaceId, resource, condition.personRelation)) === condition.active;
  }
  if ("all" in condition) {
    for (const child of condition.all) {
      if (!(await conditionPasses(env, spaceId, resource, child))) return false;
    }
    return true;
  }
  if ("any" in condition) {
    for (const child of condition.any) {
      if (await conditionPasses(env, spaceId, resource, child)) return true;
    }
    return false;
  }
  return !(await conditionPasses(env, spaceId, resource, condition.not));
}

function resolveAssignment(
  value: WorkflowAssignmentValue,
  resource: GenericResource,
  context: PolicyContext,
  timestamp: string,
): unknown {
  if (!value || typeof value !== "object") return value;
  if (value.$ref === "now") return timestamp;
  if (value.$ref === "actor.id") return context.actor.id;
  if (value.$ref === "actor.type") return context.actor.type;
  if (value.$ref === "actor.personId") {
    if (!context.actor.personId) {
      throw new ApiError("POLICY_CONTEXT_MISSING", "Action requires an active actor Space Person", 403);
    }
    return context.actor.personId;
  }
  if (value.$ref.startsWith("record.")) {
    return resource.data[value.$ref.slice("record.".length)] ?? null;
  }
  throw new ApiError("INVALID_ACTION_REFERENCE", "Published workflow contains an unsupported reference", 500);
}

function actionFor(model: PublishedModel, actionKey: string): WorkflowActionDefinition {
  const action = model.definition.actions?.[actionKey];
  if (!action) {
    throw new ApiError("ACTION_NOT_FOUND", `Action ${actionKey} is not defined for model ${model.key}`, 404);
  }
  return action;
}

async function selectedAssignments(
  env: Bindings,
  spaceId: string,
  resource: GenericResource,
  action: WorkflowActionDefinition,
): Promise<Record<string, WorkflowAssignmentValue>> {
  for (const branch of action.branches ?? []) {
    if (await conditionPasses(env, spaceId, resource, branch.when)) return branch.set;
  }
  return action.set;
}

export async function executeWorkflowAction(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  recordId: string,
  actionKey: string,
  expectedVersion: number,
  resolvedActor?: ResolvedPolicyActor,
): Promise<GenericResource> {
  const action = actionFor(model, actionKey);
  const resource = await getGenericResource(env, spaceId, model, recordId);
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  if (resource.version !== expectedVersion) {
    throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
  }

  const policyContext = await requirePolicyExpression(env, principal, spaceId, action.policy, resource, undefined, resolvedActor);

  for (const guard of action.guards ?? []) {
    if (!guardPasses(resource, guard)) {
      throw new ApiError(
        guard.errorCode ?? "ACTION_NOT_AVAILABLE",
        guard.message ?? `Action ${actionKey} is not available for this resource state`,
        409,
      );
    }
  }

  const assignments = await selectedAssignments(env, spaceId, resource, action);
  const timestamp = new Date().toISOString();
  const changes = Object.fromEntries(
    Object.entries(assignments).map(([field, value]) => [
      field,
      resolveAssignment(value, resource, policyContext, timestamp),
    ]),
  );
  return updateGenericResource(
    env,
    principal,
    spaceId,
    model,
    recordId,
    expectedVersion,
    changes,
    "action",
    undefined,
    resource,
  );
}

export function workflowActionAccess(
  model: PublishedModel,
  actionKey: string,
): WorkflowActionDefinition["access"] {
  return actionFor(model, actionKey).access;
}
