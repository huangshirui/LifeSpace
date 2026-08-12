import type { Permission, SpaceRole } from "./authorization";
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
const roleMaxAccess: Record<SpaceRole, ModelAccess> = {
  owner: "manage",
  admin: "manage",
  editor: "write",
  viewer: "read",
};
const permissionMaxAccess: Record<Permission, ModelAccess | null> = {
  free_busy: null,
  read: "read",
  write: "write",
  manage: "manage",
};

type SpaceRow = { id: string };
type CatalogRow = { max_access: ModelAccess };
type MembershipRow = { role: SpaceRole };
type GrantRow = { permission: Permission };
type PersonRow = { id: string };

export type ModelAccessDecision = {
  applicationId: string;
  modelKey: string;
  required: ModelAccess;
  catalogAccess: ModelAccess;
  spaceAuthority: SpaceRole | "grant";
  actorPersonId: string | null;
};

function firstResult<T>(result: D1Result<unknown>): T | null {
  return ((result.results ?? []) as T[])[0] ?? null;
}

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

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("SELECT id FROM spaces WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(spaceId),
    env.DB.prepare(`SELECT max_access FROM application_model_access
      WHERE application_id=? AND model_key=?`).bind(principal.clientId, model.key),
  ];
  const membershipIndex = principal.type === "user" ? statements.length : -1;
  if (principal.type === "user") {
    statements.push(env.DB.prepare(`SELECT role FROM space_memberships
      WHERE space_id=? AND user_id=? AND deleted_at IS NULL LIMIT 1`).bind(spaceId, principal.id));
  }
  const grantIndex = statements.length;
  statements.push(env.DB.prepare(`SELECT permission FROM data_grants
    WHERE source_space_id=? AND grantee_type=? AND grantee_id=? AND resource_type='space' AND resource_id IS NULL
      AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))
    ORDER BY CASE permission WHEN 'manage' THEN 4 WHEN 'write' THEN 3 WHEN 'read' THEN 2 ELSE 1 END DESC LIMIT 1`)
    .bind(spaceId, principal.type, principal.id));
  const personIndex = principal.type === "user" ? statements.length : -1;
  if (principal.type === "user") {
    statements.push(env.DB.prepare(`SELECT id FROM space_people
      WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL LIMIT 1`).bind(spaceId, principal.id));
  }

  const results = await env.DB.batch(statements);
  const space = firstResult<SpaceRow>(results[0]);
  if (!space) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);

  const catalog = firstResult<CatalogRow>(results[1]);
  if (!catalog || accessRank[catalog.max_access] < accessRank[required]) {
    throw new ApiError("FORBIDDEN", `Application ${principal.clientId} is not allowed ${required} access to model ${model.key}`, 403);
  }

  const membership = membershipIndex >= 0 ? firstResult<MembershipRow>(results[membershipIndex]) : null;
  const membershipAccess = membership ? roleMaxAccess[membership.role] : null;
  const grant = firstResult<GrantRow>(results[grantIndex]);
  const grantAccess = grant ? permissionMaxAccess[grant.permission] : null;
  const membershipAllowed = membershipAccess !== null && accessRank[membershipAccess] >= accessRank[required];
  const grantAllowed = grantAccess !== null && grantAccess !== undefined && accessRank[grantAccess] >= accessRank[required];
  if (!membershipAllowed && !grantAllowed) {
    throw new ApiError("FORBIDDEN", `Space ${spacePermissions[required]} permission is required`, 403);
  }

  const person = personIndex >= 0 ? firstResult<PersonRow>(results[personIndex]) : null;
  return {
    applicationId: principal.clientId,
    modelKey: model.key,
    required,
    catalogAccess: catalog.max_access,
    spaceAuthority: membershipAllowed ? membership!.role : "grant",
    actorPersonId: person?.id ?? null,
  };
}
