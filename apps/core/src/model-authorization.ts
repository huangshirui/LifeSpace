import type { Permission, SpaceRole } from "./authorization";
import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import type { ModelAccess } from "./model-definition";
import type { PublishedModel } from "./model-registry";

const accessRank: Record<ModelAccess, number> = { read: 2, write: 3, manage: 4 };
const permissionRank: Record<Permission, number> = { free_busy: 1, read: 2, write: 3, manage: 4 };
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
type DelegationRow = {
  id: string;
  revoked_at: string | null;
  expires_at: string | null;
  max_uses: number | null;
  consumed_at: string | null;
  target_type: "space" | "model" | "record";
  target_id: string;
  target_model_key: string | null;
  max_access: Permission;
};

export type DelegationSelector = {
  delegationId?: string | null;
  recordId?: string | null;
};

export type ModelAccessDecision = {
  applicationId: string;
  modelKey: string;
  required: ModelAccess;
  catalogAccess: ModelAccess;
  spaceAuthority: SpaceRole | "grant";
  actorPersonId: string | null;
  delegationId: string | null;
  singleUse: boolean;
};

function firstResult<T>(result: D1Result<unknown>): T | null {
  return ((result.results ?? []) as T[])[0] ?? null;
}

function delegationIsCurrent(row: DelegationRow): boolean {
  if (row.revoked_at || row.consumed_at) return false;
  if (!row.expires_at) return true;
  return Date.parse(row.expires_at) > Date.now();
}

function delegationScopeAllows(
  row: DelegationRow,
  spaceId: string,
  modelKey: string,
  recordId: string | null,
  required: ModelAccess,
): boolean {
  if (permissionRank[row.max_access] < accessRank[required]) return false;
  if (row.target_type === "space") return row.target_id === spaceId;
  if (row.target_type === "model") return row.target_id === modelKey;
  return Boolean(recordId)
    && row.target_id === recordId
    && row.target_model_key === modelKey;
}

export async function requireModelAccess(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  required: ModelAccess,
  selector: DelegationSelector = {},
): Promise<ModelAccessDecision> {
  if (!model.definition.access.includes(required)) {
    throw new ApiError("MODEL_OPERATION_UNSUPPORTED", `Model ${model.key} does not expose ${required} access`, 405);
  }

  const scope = stableScopes[required];
  if (!principal.scopes.includes(scope)) {
    throw new ApiError("CREDENTIAL_SCOPE_INSUFFICIENT", `Scope ${scope} is required`, 403);
  }

  const represented = Boolean(principal.actor);
  const requestedDelegationId = selector.delegationId?.trim() || null;
  if (represented && !requestedDelegationId) {
    throw new ApiError("DELEGATION_REQUIRED", "Represented execution requires an explicit Delegation selector", 403);
  }
  if (!represented && requestedDelegationId) {
    throw new ApiError("DELEGATION_INVALID", "Direct execution cannot exercise a Delegation", 403);
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
    WHERE source_space_id=? AND grantee_type=? AND grantee_id=?
      AND (
        (resource_type='space' AND resource_id IS NULL)
        OR (resource_type='model' AND resource_id=?)
      )
      AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))
    ORDER BY CASE permission WHEN 'manage' THEN 4 WHEN 'write' THEN 3 WHEN 'read' THEN 2 ELSE 1 END DESC LIMIT 1`)
    .bind(spaceId, principal.type, principal.id, model.key));
  const personIndex = principal.type === "user" ? statements.length : -1;
  if (principal.type === "user") {
    statements.push(env.DB.prepare(`SELECT id FROM space_people
      WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL LIMIT 1`).bind(spaceId, principal.id));
  }

  const delegationIndex = represented ? statements.length : -1;
  if (represented) {
    statements.push(env.DB.prepare(`SELECT
        d.id,d.revoked_at,d.expires_at,d.max_uses,d.consumed_at,
        s.target_type,s.target_id,s.target_model_key,s.max_access
      FROM agent_delegations d
      JOIN agent_delegation_scopes s ON s.delegation_id=d.id
      WHERE d.id=?
        AND d.principal_user_id=?
        AND d.agent_id=?
        AND d.application_id=?
        AND d.source_space_id=?
      LIMIT 1`)
      .bind(
        requestedDelegationId,
        principal.id,
        principal.actor!.id,
        principal.clientId,
        spaceId,
      ));
  }

  const results = await env.DB.batch(statements);
  const space = firstResult<SpaceRow>(results[0]);
  if (!space) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);

  const catalog = firstResult<CatalogRow>(results[1]);
  if (!catalog || accessRank[catalog.max_access] < accessRank[required]) {
    throw new ApiError(
      "APPLICATION_ACCESS_INSUFFICIENT",
      `Application ${principal.clientId} is not allowed ${required} access to model ${model.key}`,
      403,
    );
  }

  const membership = membershipIndex >= 0 ? firstResult<MembershipRow>(results[membershipIndex]) : null;
  const membershipAccess = membership ? roleMaxAccess[membership.role] : null;
  const grant = firstResult<GrantRow>(results[grantIndex]);
  const grantAccess = grant ? permissionMaxAccess[grant.permission] : null;
  const membershipAllowed = membershipAccess !== null && accessRank[membershipAccess] >= accessRank[required];
  const grantAllowed = grantAccess !== null && grantAccess !== undefined && accessRank[grantAccess] >= accessRank[required];
  if (!membershipAllowed && !grantAllowed) {
    throw new ApiError("PRINCIPAL_AUTHORITY_INSUFFICIENT", `Space ${spacePermissions[required]} permission is required`, 403);
  }

  let delegationId: string | null = null;
  let singleUse = false;
  if (represented) {
    const delegation = firstResult<DelegationRow>(results[delegationIndex]);
    if (!delegation || !delegationIsCurrent(delegation)) {
      throw new ApiError("DELEGATION_INVALID", "Delegation is missing, revoked, expired or already consumed", 403);
    }
    if (!delegationScopeAllows(
      delegation,
      spaceId,
      model.key,
      selector.recordId?.trim() || null,
      required,
    )) {
      throw new ApiError(
        "DELEGATION_SCOPE_INSUFFICIENT",
        `Delegation scope does not allow ${required} access to this target`,
        403,
      );
    }
    delegationId = delegation.id;
    singleUse = delegation.max_uses === 1;
  }

  const person = personIndex >= 0 ? firstResult<PersonRow>(results[personIndex]) : null;
  return {
    applicationId: principal.clientId,
    modelKey: model.key,
    required,
    catalogAccess: catalog.max_access,
    spaceAuthority: membershipAllowed ? membership!.role : "grant",
    actorPersonId: person?.id ?? null,
    delegationId,
    singleUse,
  };
}


export async function consumeSingleUseRead(
  env: Bindings,
  decision: ModelAccessDecision,
): Promise<void> {
  if (!decision.singleUse || !decision.delegationId) return;
  const consumedAt = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE agent_delegations
    SET consumed_at=?,consumed_by_change_id=NULL
    WHERE id=?
      AND max_uses=1
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))`)
    .bind(consumedAt, decision.delegationId)
    .run();
  if (result.meta.changes !== 1) {
    throw new ApiError("DELEGATION_INVALID", "Single-use Delegation was consumed, revoked or expired before the read completed", 403);
  }
}
