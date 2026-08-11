import { requireSpacePermission, type Permission } from "./authorization";
import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import type { ModelAccess } from "./model-definition";
import type { PublishedModel } from "./model-registry";

const accessRank: Record<ModelAccess, number> = { read: 1, write: 2, manage: 3 };
const stableScopes: Record<ModelAccess, string> = {
  read: "resources:read",
  write: "resources:write",
  manage: "resources:manage",
};
const spacePermissions: Record<ModelAccess, Permission> = {
  read: "read",
  write: "write",
  manage: "manage",
};

export type ModelAccessDecision = {
  applicationId: string;
  modelKey: string;
  required: ModelAccess;
  catalogAccess: ModelAccess;
};

export async function requireModelAccess(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  required: ModelAccess,
): Promise<ModelAccessDecision> {
  if (!model.definition.access.includes(required)) {
    throw new ApiError("MODEL_ACCESS_UNSUPPORTED", `Model ${model.key} does not expose ${required} access`, 405);
  }

  const scope = stableScopes[required];
  if (!principal.scopes.includes(scope)) {
    throw new ApiError("FORBIDDEN", `Scope ${scope} is required`, 403);
  }

  const catalog = await env.DB.prepare(`SELECT max_access FROM application_model_access
    WHERE application_id=? AND model_key=?`).bind(principal.clientId, model.key).first<{ max_access: ModelAccess }>();
  if (!catalog || accessRank[catalog.max_access] < accessRank[required]) {
    throw new ApiError("FORBIDDEN", `Application ${principal.clientId} is not allowed ${required} access to model ${model.key}`, 403);
  }

  await requireSpacePermission(env, principal, spaceId, spacePermissions[required]);
  return {
    applicationId: principal.clientId,
    modelKey: model.key,
    required,
    catalogAccess: catalog.max_access,
  };
}
