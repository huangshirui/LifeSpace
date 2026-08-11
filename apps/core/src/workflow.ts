import type { Bindings, Principal } from "./env";
import { getGenericResource, updateGenericResource, type GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import type { PublishedModel } from "./model-registry";
import type { WorkflowActionDefinition, WorkflowAssignmentValue, WorkflowGuardDefinition } from "./workflow-definition";

function guardPasses(resource: GenericResource, guard: WorkflowGuardDefinition): boolean {
  const actual = Object.prototype.hasOwnProperty.call(resource.data, guard.field) ? resource.data[guard.field] : null;
  return guard.op === "eq" ? actual === guard.value : actual !== guard.value;
}

function resolveAssignment(value: WorkflowAssignmentValue, principal: Principal, timestamp: string): unknown {
  if (!value || typeof value !== "object") return value;
  switch (value.$ref) {
    case "now": return timestamp;
    case "actor.id": return principal.id;
    case "actor.type": return principal.type;
  }
}

function actionFor(model: PublishedModel, actionKey: string): WorkflowActionDefinition {
  const action = model.definition.actions?.[actionKey];
  if (!action) throw new ApiError("ACTION_NOT_FOUND", `Action ${actionKey} is not defined for model ${model.key}`, 404);
  return action;
}

export async function executeWorkflowAction(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  recordId: string,
  actionKey: string,
  expectedVersion: number,
): Promise<GenericResource> {
  const action = actionFor(model, actionKey);
  const resource = await getGenericResource(env, spaceId, model.key, recordId);
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  if (resource.version !== expectedVersion) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);

  for (const guard of action.guards ?? []) {
    if (!guardPasses(resource, guard)) {
      throw new ApiError(
        guard.errorCode ?? "ACTION_NOT_AVAILABLE",
        guard.message ?? `Action ${actionKey} is not available for this resource state`,
        409,
      );
    }
  }

  const timestamp = new Date().toISOString();
  const changes = Object.fromEntries(Object.entries(action.set).map(([field, value]) => [field, resolveAssignment(value, principal, timestamp)]));
  return updateGenericResource(env, principal, spaceId, model, recordId, expectedVersion, changes, "action");
}

export function workflowActionAccess(model: PublishedModel, actionKey: string): WorkflowActionDefinition["access"] {
  return actionFor(model, actionKey).access;
}
